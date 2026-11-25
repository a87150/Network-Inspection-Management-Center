"""投递队列：一行坏数据不能拖垮整批。"""
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from net.alerts.service import deliver_due_alerts
from net.inspections.queue import enqueue_task
from net.models import (
    AlertChannel, AlertDelivery, AlertEvent, InspectionProfile, Server, TaskRun,
)


class PoisonRowIsolationTests(TestCase):
    def setUp(self):
        # summary 事件必须挂在真实任务上，模型的 _validate_scope 会校验。
        profile = InspectionProfile.objects.create(
            name='毒丸用例', device_type=InspectionProfile.DeviceType.SERVER,
            selected_items=['cpu'],
        )
        server = Server.objects.create(name='POISON-SRV', ip='192.0.2.241')
        self.task = enqueue_task(profile, [server.pk], TaskRun.Source.MANUAL)
        self.event = AlertEvent.objects.create(
            event_type='summary', task=self.task, summary_task=self.task,
            target_type='task', target_id=str(self.task.pk),
            profile_type='inspection_profile', profile_id=str(profile.pk),
            summary='汇总', severity='info', status=AlertEvent.Status.PENDING,
            occurred_at=timezone.now(),
        )
        self.channels = [
            AlertChannel.objects.create(
                name='通道%d' % index,
                channel_type=AlertChannel.ChannelType.FEISHU,
                settings={'webhook_url': 'https://open.feishu.test/hook%d' % index},
            )
            for index in range(2)
        ]
        for channel in self.channels:
            AlertDelivery.objects.create(event=self.event, channel=channel)

    def test_a_message_that_fails_to_build_does_not_stop_the_batch(self):
        """第一行渲染抛错时，第二行仍要发出去。

        渲染原来和 get 一起在 try 外面，异常会逃出 for 循环，本批剩余行不处理，
        而 claim 按 created_at 排序 —— 一行坏数据就让整条队列停摆到 attempt 耗尽。

        注意覆盖边界：这里只验证「渲染失败」。get 抛错（行被删、channel.settings
        解密失败）那条路径同样搬进了 try，但 claim 之后行刚存在，构造不出自然的
        失败，**没有测试覆盖**。改动那段时靠代码审查，别指望这条测试变红。
        """
        calls = {'build': 0}

        def build(event):
            calls['build'] += 1
            if calls['build'] == 1:
                raise ValueError('模板数据形状不对')
            from net.alerts.base import AlertMessage
            return AlertMessage(title='汇总', text='正文', facts={}, detail_url='')

        from net.alerts.base import DeliveryResult

        with patch('net.alerts.service.build_alert_message', side_effect=build), \
                patch('net.alerts.service.send_alert',
                      return_value=DeliveryResult(True, 'ok', False)):
            delivered = deliver_due_alerts(limit=10)

        self.assertEqual(len(delivered), 2, '两行都该被处理，不能因为第一行抛错就中断')
        self.assertEqual(calls['build'], 2)

        rows = list(AlertDelivery.objects.order_by('pk'))
        self.assertEqual(len(rows), 2)
        # 两行都离开了「待领取」：坏行落成可重试，好行直接成功。
        self.assertTrue(all(row.status != AlertDelivery.Status.PENDING for row in rows))
        self.assertTrue(any(row.status == AlertDelivery.Status.SENT for row in rows))
