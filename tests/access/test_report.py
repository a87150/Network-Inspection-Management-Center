"""门禁报表：汇总口径、到点判定与定时发送入口。"""
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from net.access.adapters import V6600_V6000_COMPAT_VERSION
from net.alerts.base import DeliveryResult
from net.models.access import AccessRecord, AccessRecordSource, AccessReportConfig
from net.models.alerts import AlertChannel
from weakcurrent.report import build_report

KEY = 'Z0NlSlo5MWZ6cWJkS0pnS2VFN0NQN1pCTHNhT0xrT1k='


@override_settings(DEVICE_BACKUP_ENCRYPTION_KEY=KEY)
class AccessReportTests(TestCase):
    def setUp(self):
        self.source = AccessRecordSource(
            name='一号门禁', platform='zkteco_v6600',
            api_version=V6600_V6000_COMPAT_VERSION,
            base_url='https://v6600.example.test:8088', event_path='/access/events',
        )
        self.source.set_credentials({'access_token': 'never-render-this'})
        self.source.save()
        now = timezone.now()
        for offset, result in ((1, 'passed'), (2, 'passed'), (3, 'denied')):
            AccessRecord.objects.create(
                source=self.source, source_event_id='e%s' % offset,
                occurred_at=now - timedelta(hours=offset),
                person_name='张三', door_name='正门', result=result,
            )

    def test_report_counts_pass_and_deny(self):
        report = build_report(7)
        self.assertEqual(report['total'], 3)
        self.assertEqual(report['denied'], 1)
        self.assertEqual(report['sources'][0]['name'], '一号门禁')
        self.assertEqual(report['sources'][0]['passed'], 2)

    def test_report_ignores_records_outside_range(self):
        AccessRecord.objects.create(
            source=self.source, source_event_id='old',
            occurred_at=timezone.now() - timedelta(days=30),
            person_name='李四', door_name='侧门', result='passed',
        )
        self.assertEqual(build_report(7)['total'], 3)

    def test_config_due_only_when_enabled_and_elapsed(self):
        config = AccessReportConfig.load()
        now = timezone.now()
        self.assertFalse(config.is_due(now))
        config.is_enabled = True
        config.channel_id = '00000000-0000-0000-0000-000000000001'
        self.assertTrue(config.is_due(now))
        config.last_sent_at = now
        self.assertFalse(config.is_due(now))
        self.assertTrue(config.is_due(now + timedelta(hours=25)))


class SendAccessReportsCommandTests(TestCase):
    """send_access_reports 命令：按配置决定发不发，按发送结果决定推不推 last_sent_at。"""

    def setUp(self):
        self.channel = AlertChannel.objects.create(
            name='值班群', channel_type='feishu',
            settings={'webhook_url': 'https://example.test/hook'},
        )
        self.config = AccessReportConfig.load()
        self.config.is_enabled = True
        self.config.interval_hours = 24
        self.config.channel_id = self.channel.id
        self.config.save()

    def _run(self):
        call_command('send_access_reports', stdout=StringIO())

    def test_enabled_config_sends_once_and_records_last_sent_at(self):
        with patch('weakcurrent.report.send_alert',
                   return_value=DeliveryResult(True, 'ok', False)) as sender:
            self._run()
        self.assertEqual(sender.call_count, 1)
        self.config.refresh_from_db()
        self.assertIsNotNone(self.config.last_sent_at)

    def test_command_skips_when_disabled(self):
        self.config.is_enabled = False
        self.config.save()
        with patch('weakcurrent.report.send_alert') as sender:
            self._run()
        self.assertEqual(sender.call_count, 0)

    def test_command_skips_until_the_interval_elapses(self):
        self.config.last_sent_at = timezone.now()
        self.config.save()
        with patch('weakcurrent.report.send_alert') as sender:
            self._run()
        self.assertEqual(sender.call_count, 0)

    def test_failed_delivery_keeps_the_interval_open_for_a_retry(self):
        with patch('weakcurrent.report.send_alert',
                   return_value=DeliveryResult(False, 'boom', True)):
            self._run()
        self.config.refresh_from_db()
        self.assertIsNone(self.config.last_sent_at)

    def test_missing_channel_is_not_counted_as_sent(self):
        self.channel.delete()
        with patch('weakcurrent.report.send_alert') as sender:
            self._run()
        self.assertEqual(sender.call_count, 0)
        self.config.refresh_from_db()
        self.assertIsNone(self.config.last_sent_at)