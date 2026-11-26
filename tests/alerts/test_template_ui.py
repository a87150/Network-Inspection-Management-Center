"""多模板的界面流程：列表、切换、新建、删除、渠道绑定。"""
from django.test import TestCase

from net.models import (
    AlertChannel,
    AlertNotificationTemplate,
    AlertPolicy,
    AlertPolicyRoute,
)


class TemplateSettingsUITests(TestCase):
    def setUp(self):
        from tests.auth import login_admin
        login_admin(self.client)
        self.url = '/alerts/template/'

    def test_lists_every_template_grouped_by_trigger(self):
        AlertNotificationTemplate.objects.create(name='设备告警', trigger='device')

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '告警通知模板')
        self.assertContains(response, '选择模板')
        self.assertContains(response, '默认任务汇总')
        self.assertContains(response, '设备告警')

    def test_switch_to_a_named_template_edits_that_row(self):
        row = AlertNotificationTemplate.objects.create(
            name='夜间汇总', trigger='summary', title_template='夜间 {task_name}')

        response = self.client.get(self.url, {'template': str(row.pk)})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context['current_template_id'], str(row.pk))
        self.assertContains(response, '夜间 {task_name}')

    def test_new_opens_an_empty_form_instead_of_the_default(self):
        response = self.client.get(self.url, {'new': '1'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context['current_template_id'], '')
        self.assertTrue(response.context['template_is_new'])
        self.assertEqual(response.context['template_form']['name'].value(), '')

    def test_saving_a_new_device_template_creates_a_second_row(self):
        before = AlertNotificationTemplate.objects.count()

        response = self.client.post(self.url, {
            'name': '设备-详细', 'trigger': 'device', 'mode': 'detailed',
            'title_template': '{device_name} 异常', 'body_template': '{issues}',
            'action': 'save',
        })

        self.assertEqual(AlertNotificationTemplate.objects.count(), before + 1)
        row = AlertNotificationTemplate.objects.get(name='设备-详细')
        self.assertEqual(row.trigger, 'device')
        self.assertTrue(row.is_default, '第一个 device 模板自动成为该时机的默认')
        self.assertEqual(response.status_code, 200)

    def test_device_template_rejects_summary_variables(self):
        response = self.client.post(self.url, {
            'name': '设备-错误', 'trigger': 'device', 'mode': 'compact',
            'title_template': '{task_name}', 'action': 'save',
        })

        self.assertEqual(response.status_code, 400)
        self.assertFalse(AlertNotificationTemplate.objects.filter(name='设备-错误').exists())

    def test_default_template_cannot_be_deleted(self):
        row = AlertNotificationTemplate.objects.get(trigger='summary', is_default=True)

        response = self.client.post(self.url, {'action': 'delete', 'template_id': str(row.pk)})

        self.assertEqual(response.status_code, 400)
        self.assertTrue(AlertNotificationTemplate.objects.filter(pk=row.pk).exists())

    def test_non_default_template_can_be_deleted(self):
        row = AlertNotificationTemplate.objects.create(name='临时', trigger='summary')

        response = self.client.post(self.url, {'action': 'delete', 'template_id': str(row.pk)})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(AlertNotificationTemplate.objects.filter(pk=row.pk).exists())


class PolicyRouteUITests(TestCase):
    """模板和渠道的配对配在告警策略上：勾了渠道，每个渠道各选一套模板。"""

    def setUp(self):
        from tests.auth import login_admin
        login_admin(self.client)
        self.channel = AlertChannel.objects.create(
            name='设备通知', channel_type=AlertChannel.ChannelType.FEISHU,
            settings={'webhook_url': 'https://open.feishu.test/hook'})
        self.summary_template = AlertNotificationTemplate.objects.get(
            trigger='summary', is_default=True)
        self.device_template = AlertNotificationTemplate.objects.create(
            name='设备告警', trigger='device')
        self.policy = AlertPolicy.objects.create(
            name='默认', is_default=True, mode=AlertPolicy.Mode.OVERRIDE)

    def _modal(self):
        return self.client.get('/alerts/', {'alert_modal': 'policy'})

    def test_policy_modal_offers_a_template_pick_per_channel(self):
        response = self._modal()

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '任务汇总模板')
        self.assertContains(response, '单设备告警模板')
        self.assertContains(response, '不发单设备告警')
        self.assertContains(
            response, 'name="template_device_%s"' % self.channel.pk, html=False)

    def test_saving_the_policy_writes_the_route(self):
        self.client.post('/alerts/policies/save/', {
            'scope': 'default', 'mode': 'override', 'name': '默认',
            'channels': [str(self.channel.pk)],
            'template_summary_%s' % self.channel.pk: str(self.summary_template.pk),
            'template_device_%s' % self.channel.pk: str(self.device_template.pk),
        })

        route = AlertPolicyRoute.objects.get(
            policy=self.policy, channel=self.channel, trigger='device')
        self.assertEqual(route.template_id, self.device_template.pk)
        self.assertTrue(AlertPolicyRoute.objects.filter(
            policy=self.policy, channel=self.channel, trigger='summary').exists())

    def test_clearing_the_device_slot_drops_only_that_route(self):
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template,
            trigger='device')
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.summary_template,
            trigger='summary')

        self.client.post('/alerts/policies/save/', {
            'scope': 'default', 'mode': 'override', 'name': '默认',
            'channels': [str(self.channel.pk)],
            'template_summary_%s' % self.channel.pk: str(self.summary_template.pk),
            'template_device_%s' % self.channel.pk: '',
        })

        self.assertFalse(AlertPolicyRoute.objects.filter(
            policy=self.policy, trigger='device').exists())
        self.assertTrue(AlertPolicyRoute.objects.filter(
            policy=self.policy, trigger='summary').exists())

    def test_unchecking_the_channel_removes_its_routes(self):
        AlertPolicyRoute.objects.create(
            policy=self.policy, channel=self.channel, template=self.device_template,
            trigger='device')

        self.client.post('/alerts/policies/save/', {
            'scope': 'default', 'mode': 'override', 'name': '默认',
            'channels': [],
        })

        self.assertFalse(AlertPolicyRoute.objects.filter(policy=self.policy).exists())
