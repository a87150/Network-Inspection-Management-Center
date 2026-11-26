"""列出并清理没有主人的配置备份。

备份行用裸 UUID 记录 device_type/device_id，没有外键，设备删掉之后这些密文会
永久留着（每台最多 10 份）。因为清理是不可逆的，这里做成手动命令而不是删除钩子：
先 --dry-run 看清单，确认后再加 --delete。
"""
from django.core.management.base import BaseCommand
from django.db.models import Q

from net.models import DeviceConfigurationBackup, Network_Device, WeakCurrentDevice

MODELS = {
    'network_device': Network_Device,
    'monitor': WeakCurrentDevice,
}


class Command(BaseCommand):
    help = '列出（或删除）设备已不存在的配置备份行。'

    def add_arguments(self, parser):
        parser.add_argument('--delete', action='store_true',
                            help='真正删除；不加时只列清单。')

    def handle(self, *args, **options):
        orphans = []
        for device_type, model in MODELS.items():
            alive = set(
                str(pk) for pk in model.objects.values_list('pk', flat=True))
            rows = DeviceConfigurationBackup.objects.filter(device_type=device_type)
            orphans.extend(
                row for row in rows if str(row.device_id) not in alive)
        if not orphans:
            self.stdout.write('没有无主配置备份。')
            return
        for row in orphans:
            self.stdout.write(
                f'{row.device_type} {row.device_id} {row.filename} '
                f'{row.backup_date} {row.byte_size} 字节')
        if not options['delete']:
            self.stdout.write(self.style.WARNING(
                f'共 {len(orphans)} 条；确认后加 --delete 才会删除。'))
            return
        ids = [row.pk for row in orphans]
        with __import__('django.db', fromlist=['transaction']).transaction.atomic():
            deleted, _ = DeviceConfigurationBackup.objects.filter(
                Q(pk__in=ids)).delete()
        self.stdout.write(self.style.SUCCESS(f'已删除 {deleted} 条。'))
