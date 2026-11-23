""" 拉取仓库外的 PC 采集发布产物。

二进制不进 Git（会随每次重编译膨胀、无法 diff），改由本命令在部署期补齐。
web 请求路径仍然只读本地文件，下载只发生在这里。
"""
from hashlib import sha256
from urllib.error import URLError
from urllib.request import urlopen

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from net.scripts import sensors
from net.scripts.executable import HOST_DIRECTORY, PREBUILT_HOST_SHA256

TIMEOUT = 60


class Command(BaseCommand):
    help = '按固定 SHA256 拉取 PCCollectorHost.exe / PawnIO_setup.exe / 传感器 DLL'

    def add_arguments(self, parser):
        parser.add_argument('--base-url', default='', help='发布产物目录地址，默认读 PC_COLLECTOR_BASE_URL')
        parser.add_argument('--check', action='store_true', help='只检查本地文件是否齐全，不下载')

    def handle(self, *args, **options):
        base = (options['base_url'] or getattr(settings, 'PC_COLLECTOR_BASE_URL', '')).rstrip('/')
        wanted = [('PCCollectorHost.exe', PREBUILT_HOST_SHA256)]
        manifest = sensors.manifest()
        wanted.append(('PawnIO_setup.exe', manifest['driver']['sha256']))
        wanted.extend(
            ('sensors/' + name, digest) for name, digest in sorted(manifest['files'].items())
        )
        missing = []
        for name, digest in wanted:
            target = HOST_DIRECTORY / name
            if target.is_file() and sha256(target.read_bytes()).hexdigest() == digest.lower():
                continue
            missing.append((name, digest, target))
        if not missing:
            self.stdout.write(self.style.SUCCESS('PC 采集产物齐全'))
            return
        if options['check']:
            raise CommandError('缺少 %d 个产物：%s' % (
                len(missing), ', '.join(item[0] for item in missing),
            ))
        if not base:
            raise CommandError(
                '未配置 PC_COLLECTOR_BASE_URL，无法下载：'
                + ', '.join(item[0] for item in missing)
            )
        for name, digest, target in missing:
            self._fetch(base + '/' + name, digest, target)
        self.stdout.write(self.style.SUCCESS('已补齐 %d 个产物' % len(missing)))

    def _fetch(self, url, digest, target):
        try:
            with urlopen(url, timeout=TIMEOUT) as response:
                data = response.read()
        except URLError as exc:
            raise CommandError('下载失败 %s：%s' % (url, exc)) from exc
        actual = sha256(data).hexdigest()
        if actual != digest.lower():
            raise CommandError('校验失败 %s：期望 %s，实际 %s' % (url, digest, actual))
        target.parent.mkdir(parents=True, exist_ok=True)
        # 先写临时文件再换名，避免半截文件被当成有效产物。
        temporary = target.with_suffix(target.suffix + '.part')
        temporary.write_bytes(data)
        temporary.replace(target)
        self.stdout.write('已下载 %s' % target.relative_to(HOST_DIRECTORY))
