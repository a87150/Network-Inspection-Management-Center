"""配置备份：列表入口与对比页的版本顺序。

对应 docs/functional-review-2.32.md 里「备份页没有入口」「对比页能选更新的版本」。
"""
from datetime import datetime, timedelta, timezone as dt_timezone

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse

from assets.payloads import asset_row_actions
from net.devices.configuration_backups import store_configuration_backup
from net.models import Network_Device

User = get_user_model()


class BackupEntryTests(TestCase):
    def setUp(self):
        self.device = Network_Device.objects.create(ip='192.0.2.221', device_name='SW-BK')

    def test_row_actions_expose_the_backup_history(self):
        """三个备份视图原本没有任何反链，用户只能手打 URL。"""
        build = asset_row_actions('networks', admin=True)
        urls = [entry.get('url') for entry in build(self.device)]

        self.assertIn(
            reverse('configuration_backup_list', args=['networks', self.device.pk]),
            urls,
        )

    def test_non_admin_does_not_get_the_entry(self):
        build = asset_row_actions('networks', admin=False)
        urls = [entry.get('url') for entry in build(self.device)]

        self.assertNotIn(
            reverse('configuration_backup_list', args=['networks', self.device.pk]),
            urls,
        )


@override_settings(DEVICE_BACKUP_ENCRYPTION_KEY=Fernet.generate_key())
class DiffVersionOrderTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            'bk-admin', password='pw', is_staff=True, is_superuser=True,
        )
        self.client.force_login(self.admin)
        self.device = Network_Device.objects.create(ip='192.0.2.222')
        # list_configuration_backups 按 (backup_date, captured_at, id) 倒序。
        self.newest = self._store('newest.cfg', days_ago=0)
        self.middle = self._store('middle.cfg', days_ago=1)
        self.oldest = self._store('oldest.cfg', days_ago=2)

    def _store(self, filename, *, days_ago):
        at = datetime(2026, 9, 1, 12, 0, tzinfo=dt_timezone.utc) - timedelta(days=days_ago)
        return store_configuration_backup(
            self.device,
            {'status': 'success', 'vendor': 'cisco', 'format': 'text',
             'content': 'hostname %s\nend\n' % filename, 'scope': 'running-config',
             'complete': True},
            captured_at=at,
        )

    def test_candidates_only_include_older_versions(self):
        """选一个比当前更新的版本会让旧/新标签和 +/- 行数整个反过来。"""
        # ?fragment=diff 直接回 JSON，不用去解析页面里的 <script>。
        response = self.client.get(
            reverse('configuration_backup_diff',
                    args=['networks', self.device.pk, self.middle.pk]),
            {'fragment': 'diff'},
        )

        self.assertEqual(response.status_code, 200)
        values = [item['value'] for item in response.json()['versions']]

        self.assertIn(str(self.oldest.pk), values)
        self.assertNotIn(str(self.newest.pk), values, '更新的版本不能出现在旧版本候选里')
        self.assertNotIn(str(self.middle.pk), values, '当前版本不该出现在自己的候选里')

    def test_requesting_a_newer_version_is_rejected(self):
        """手工构造 ?against=<更新版本> 要明确拒绝，而不是静默按新当旧。"""
        response = self.client.get(
            reverse('configuration_backup_diff',
                    args=['networks', self.device.pk, self.middle.pk]),
            {'against': str(self.newest.pk)},
        )

        self.assertEqual(response.status_code, 404)
