"""维护窗口：共用创建入口的校验、去重，以及停用接口的非法标识。

对应 docs/functional-review-2.32.md 里「批量建窗缺事务与校验」「停用接口 500」
「方块口径不一致」三条。
"""
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from assets.maintenance import create_windows, window_metrics
from net.models import MaintenanceWindow, Network_Device

User = get_user_model()


class CreateWindowsTests(TestCase):
    def setUp(self):
        self.a = Network_Device.objects.create(ip='192.0.2.211', device_name='SW-A')
        self.b = Network_Device.objects.create(ip='192.0.2.212', device_name='SW-B')
        self.start = timezone.now() + timedelta(hours=1)
        self.end = self.start + timedelta(hours=2)

    def test_unknown_target_is_rejected(self):
        """不存在的主键不能落成孤儿窗口 —— REST 侧原来完全不校验。"""
        ghost = uuid.uuid4()

        with self.assertRaises(ValidationError):
            create_windows('network_device', [str(self.a.pk), str(ghost)], self.start, self.end)

        self.assertFalse(MaintenanceWindow.objects.exists())

    def test_overlapping_window_is_skipped(self):
        create_windows('network_device', [str(self.a.pk)], self.start, self.end)

        again = create_windows(
            'network_device', [str(self.a.pk), str(self.b.pk)], self.start, self.end,
        )

        self.assertEqual(len(again), 1, '同一资产同一时段不该重复登记')
        self.assertEqual(str(again[0].target_id), str(self.b.pk))

    def test_empty_selection_is_rejected(self):
        with self.assertRaises(ValidationError):
            create_windows('network_device', [], self.start, self.end)

    def test_unknown_target_type_is_rejected(self):
        with self.assertRaises(ValidationError):
            create_windows('no_such_kind', [str(self.a.pk)], self.start, self.end)


class WindowMetricsTests(TestCase):
    def setUp(self):
        self.device = Network_Device.objects.create(ip='192.0.2.213')
        now = timezone.now()
        MaintenanceWindow.objects.create(
            target_id=self.device.pk, starts_at=now - timedelta(hours=1),
            ends_at=now + timedelta(hours=1),
        )
        MaintenanceWindow.objects.create(
            target_id=self.device.pk, starts_at=now + timedelta(hours=2),
            ends_at=now + timedelta(hours=3),
        )
        MaintenanceWindow.objects.create(
            target_id=self.device.pk, starts_at=now - timedelta(hours=3),
            ends_at=now - timedelta(hours=2),
        )
        MaintenanceWindow.objects.create(
            target_id=self.device.pk, starts_at=now + timedelta(hours=4),
            ends_at=now + timedelta(hours=5), is_enabled=False,
        )

    def test_buckets_add_up_to_total(self):
        """停用且未结束的窗口过去落在三块之外，三块之和永远小于总数。"""
        metrics = window_metrics()

        self.assertEqual(metrics['total'], 4)
        self.assertEqual(
            metrics['active'] + metrics['pending'] + metrics['ended'] + metrics['disabled'],
            metrics['total'],
            '四个计数必须覆盖全部窗口：%r' % metrics,
        )


class ToggleEnabledTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            'toggle-admin', password='pw', is_staff=True, is_superuser=True,
        )
        self.client.force_login(self.admin)
        self.device = Network_Device.objects.create(ip='192.0.2.214')

    def test_malformed_pk_returns_404_not_500(self):
        """get_object_or_404 对非 UUID 抛的是 ValidationError，不是 Http404。"""
        response = self.client.post(
            reverse('asset_toggle_enabled', args=['networks']),
            {'pk': 'not-a-uuid'},
        )

        self.assertEqual(response.status_code, 404)

    def test_valid_pk_toggles(self):
        response = self.client.post(
            reverse('asset_toggle_enabled', args=['networks']),
            {'pk': str(self.device.pk)},
        )

        self.assertEqual(response.status_code, 302)
        self.device.refresh_from_db()
        self.assertFalse(self.device.is_enabled)
