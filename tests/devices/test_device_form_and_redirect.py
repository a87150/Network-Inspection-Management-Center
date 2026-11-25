"""设备表单的端口必填性与维护窗口删除的跳转白名单。

对应 docs/functional-review-2.32.md 补记的两条。
"""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from assets.forms import device_form
from net.models import MaintenanceWindow, Network_Device

User = get_user_model()


class ServerPortRequirementTests(TestCase):
    def test_blank_port_is_rejected_instead_of_hitting_the_not_null_column(self):
        """Server.port 是 NOT NULL，留空必须在这里就被挡下来。

        Django 会把「表单非必填、模型必填」的空值排除出模型校验，None 会一路
        落到 INSERT，最后被 IntegrityError 翻译成「请检查 IP 是否已存在」。
        """
        form = device_form('servers', data={
            'ip': '192.0.2.201', 'server_type': 'linux', 'port': '',
            'username': '', 'password': '',
        })

        self.assertFalse(form.is_valid())
        self.assertIn('port', form.errors)

    def test_network_device_may_leave_port_blank(self):
        """网络设备的 port 列允许 NULL，留空仍然合法。"""
        form = device_form('networks', data={
            'ip': '192.0.2.202', 'device_name': 'SW-1', 'vendor': 'cisco',
            'device_type': 'switch', 'port': '', 'username': '', 'password': '',
        })

        self.assertTrue(form.is_valid(), form.errors)


class MaintenanceDeleteRedirectTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            'maint-admin', password='pw', is_staff=True, is_superuser=True,
        )
        self.client.force_login(self.admin)
        self.device = Network_Device.objects.create(ip='192.0.2.203')

    def _window(self):
        return MaintenanceWindow.objects.create(
            target_id=self.device.pk,
            starts_at=timezone.now(),
            ends_at=timezone.now() + timedelta(hours=1),
        )

    def test_external_next_is_ignored(self):
        window = self._window()

        response = self.client.post(
            reverse('maintenance_window_delete', args=[window.pk]),
            {'next': 'https://evil.invalid/steal'}, follow=False,
        )

        self.assertEqual(response.status_code, 302)
        self.assertNotIn('evil.invalid', response['Location'])

    def test_internal_next_is_honoured(self):
        window = self._window()

        response = self.client.post(
            reverse('maintenance_window_delete', args=[window.pk]),
            {'next': reverse('maintenance_list')}, follow=False,
        )

        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse('maintenance_list'), response['Location'])
