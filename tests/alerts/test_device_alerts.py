"""单设备告警：渠道绑了 device 模板才发，维护窗口内不发。

原来 abnormal 事件只记 'recorded'，从不建投递行 —— 系统里根本没有「单台设备
出了问题就通知」这条路径，只有任务结束后的汇总。这里锁住新的判定。
"""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from net.alerts.messages import build_alert_message
from net.alerts.service import process_target_findings
from net.inspections.queue import enqueue_task
from net.models import (
    AlertChannel, AlertPolicyRoute, AlertDelivery, AlertEvent,
    AlertNotificationTemplate, AlertPolicy, InspectionProfile, MaintenanceWindow,
    Server, TaskRun,
)


def finding(key='inspection.cpu', state='abnormal'):
    return {'key': key, 'severity': 'warning', 'title': 'CPU 使用率过高',
            'detail': '连续 5 分钟超过 90%', 'state': state}


class DeviceAlertDeliveryTests(TestCase):
    def setUp(self):
        self.profile = InspectionProfile.objects.create(
            name='设备告警巡检', device_type=InspectionProfile.DeviceType.SERVER,
            selected_items=['cpu'],
        )
        self.device = Server.objects.create(name='ALERT-SRV', ip='192.0.2.231')
        # 渠道和策略必须先就位：enqueue_task 会把当时的生效策略与渠道冻结进
        # profile_snapshot['alert_routing']，之后再建就抓不到了。
        self.channel = AlertChannel.objects.create(
            name='设备通知', channel_type=AlertChannel.ChannelType.FEISHU,
            settings={'webhook_url': 'https://open.feishu.test/hook'},
        )
        self.policy = AlertPolicy.objects.create(
            name='默认', is_default=True, mode=AlertPolicy.Mode.OVERRIDE,
        )
        self.policy.channels.add(self.channel)
        self.target = self._terminal_target()
        self.device_template = AlertNotificationTemplate.objects.create(
            name='设备告警-简洁', trigger='device',
            title_template='{device_name} 异常', body_template='{device_ip}\n{issues}',
        )

    def _terminal_target(self):
        task = enqueue_task(self.profile, [self.device.pk], TaskRun.Source.MANUAL)
        target = task.target_runs.get()
        now = timezone.now()
        # 终态任务：RUNNING 会被 net_task_active_scope_ck 要求 active_scope_key，
        # 而 process_target_findings 只看 target 的状态。
        # 失败任务要求「全部目标都失败」，与下面把 target 置为 FAILED 一致。
        TaskRun.objects.filter(pk=task.pk).update(
            status=TaskRun.Status.FAILED, active_scope_key=None, progress=100,
            completed_targets=1, successful_targets=0, failed_targets=1, finished_at=now)
        target.__class__.objects.filter(pk=target.pk).update(
            status=TaskRun.Status.FAILED, started_at=now, finished_at=now)
        target.refresh_from_db()
        return target

    def _deliveries(self):
        return AlertDelivery.objects.filter(event__event_type='abnormal')

    def test_no_delivery_when_channel_has_no_device_template(self):
        """建了渠道不等于订阅了设备告警；没绑模板就不发。"""
        events = process_target_findings(self.target, [finding()])

        self.assertTrue(events)
        self.assertEqual(self._deliveries().count(), 0)

    def test_delivery_created_when_channel_binds_device_template(self):
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template, trigger='device',
        )

        process_target_findings(self.target, [finding()])

        delivery = self._deliveries().get()
        self.assertEqual(delivery.channel_id, self.channel.pk)
        self.assertEqual(delivery.status, AlertDelivery.Status.PENDING)

    def test_message_uses_the_channel_template(self):
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template, trigger='device',
        )

        process_target_findings(self.target, [finding()])
        event = AlertEvent.objects.get(event_type='abnormal')
        delivery = AlertDelivery.objects.get(event=event)

        # 模板在建投递行时就定下来了，发送时直接用它，不再回查渠道。
        message = build_alert_message(event, delivery.channel, delivery.template)

        self.assertIn('ALERT-SRV', message.title)
        self.assertIn('192.0.2.231', message.text)

    def test_maintenance_window_suppresses_device_delivery(self):
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template, trigger='device',
        )
        now = timezone.now()
        MaintenanceWindow.objects.create(
            target_type=MaintenanceWindow.TargetType.SERVER,
            target_id=self.device.pk,
            starts_at=now - timedelta(hours=1), ends_at=now + timedelta(hours=1),
        )

        process_target_findings(self.target, [finding()])

        self.assertEqual(self._deliveries().count(), 0,
                         '维护窗口内的设备不该发单设备告警')

    def test_recovery_uses_the_same_channel_rules(self):
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template, trigger='device',
        )
        process_target_findings(self.target, [finding()])
        self.target.refresh_from_db()
        self.target.finished_at = timezone.now() + timedelta(minutes=1)
        self.target.save(update_fields=['finished_at'])

        process_target_findings(self.target, [finding(state='normal')])

        self.assertEqual(
            AlertDelivery.objects.filter(event__event_type='recovery').count(), 1)

    def test_end_to_end_from_channel_binding_to_pending_delivery(self):
        """完整链路：渠道绑模板 → 设备异常 → 产出待发通知，内容按该模板渲染。"""
        from net.alerts.service import deliver_due_alerts
        from unittest.mock import patch

        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template, trigger='device',
        )
        process_target_findings(self.target, [finding()])
        delivery = self._deliveries().get()
        self.assertEqual(delivery.status, AlertDelivery.Status.PENDING)

        sent = []
        with patch('net.alerts.service.send_alert',
                   side_effect=lambda channel, message: sent.append(message) or
                   __import__('net.alerts.base', fromlist=['DeliveryResult']).DeliveryResult(True, 'ok', False)):
            deliver_due_alerts(limit=10)

        self.assertEqual(len(sent), 1)
        self.assertIn('ALERT-SRV', sent[0].title)
        self.assertIn('CPU 使用率过高', sent[0].text)
        delivery.refresh_from_db()
        self.assertEqual(delivery.status, AlertDelivery.Status.SENT)

    def test_summary_template_does_not_enable_device_delivery(self):
        """绑的是 summary 模板就不能拿来发设备告警。"""
        summary = AlertNotificationTemplate.objects.get(trigger='summary', is_default=True)
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=summary, trigger='summary',
        )

        process_target_findings(self.target, [finding()])

        self.assertEqual(self._deliveries().count(), 0)
