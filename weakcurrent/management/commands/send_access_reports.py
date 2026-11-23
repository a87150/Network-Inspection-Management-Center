"""按门禁报表配置发送一次通行报表；交给系统计划任务周期调用。"""

from django.core.management.base import BaseCommand

from weakcurrent.report import send_due_reports


class Command(BaseCommand):
    help = '按 AccessReportConfig 的 is_enabled / interval_hours 发一次门禁通行报表，未到点则跳过'

    def handle(self, *args, **options):
        if send_due_reports():
            self.stdout.write(self.style.SUCCESS('门禁通行报表已发送。'))
            return
        self.stdout.write('未启用、未到发送间隔或渠道不可用，本次跳过。')
