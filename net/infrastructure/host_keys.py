"""SSH 主机密钥策略：首次信任即锁定（TOFU），指纹变了就停。

设备管理员口令是同型号设备一套传一套，被中间人接住一次就等于丢一片，
所以这里不提供"自动接受新密钥"的无条件路径：

* 默认 TOFU —— 第一次见到某台主机时把密钥指纹写进 net.SSHHostKey，
  之后每次比对。指纹不一致直接拒绝连接，不会静默覆盖。
* 严格模式（NET_SSH_HOST_KEY_STRICT=1）—— 只认已经记过的指纹，未知主机拒绝，
  录入靠运维显式 trust()。几十台设备要认这个成本，由部署方决定。
* 指纹不符永远拒绝，没有开关能绕过；换设备后要人工 forget() 再重连。

存的是指纹不是口令，但仍是可信边界数据：谁能改它，谁就能冒充设备。
"""
import os


class HostKeyError(RuntimeError):
    """主机密钥不可信：未知（严格模式）或与记录不符。"""


class HostKeyChanged(HostKeyError):
    """记录的指纹和这次拿到的对不上，可能是换设备，也可能是中间人。"""


def strict_mode() -> bool:
    return os.getenv('NET_SSH_HOST_KEY_STRICT', '').strip().lower() in {'1', 'true', 'yes', 'on'}


def host_id(host, port) -> str:
    return f'{host}:{int(port or 22)}'


def fingerprint(key) -> str:
    """和 OpenSSH 一致：sha256 的 base64 去掉补位，前缀 sha256:。"""
    import base64
    import hashlib

    digest = hashlib.sha256(key.asbytes()).digest()
    return 'sha256:' + base64.b64encode(digest).decode('ascii').rstrip('=')


def _model():
    from net.models import SSHHostKey

    return SSHHostKey


def entries() -> list:
    return list(_model().objects.all())


def recorded(host, port):
    row = _model().objects.filter(host=host, port=int(port or 22)).first()
    if row is None:
        return None
    return {'key_type': row.key_type, 'fingerprint': row.fingerprint, 'source': row.source}


def trust(host, port, key, user=None):
    """显式信任一台主机（严格模式下的录入入口）。"""
    model = _model()
    row, _created = model.objects.update_or_create(
        host=host, port=int(port or 22),
        defaults={
            'key_type': key.get_name() if hasattr(key, 'get_name') else '',
            'fingerprint': fingerprint(key),
            'source': model.Source.MANUAL,
            'trusted_by': user if getattr(user, 'pk', None) else None,
        },
    )
    return row


def forget(host, port) -> bool:
    deleted, _rows = _model().objects.filter(host=host, port=int(port or 22)).delete()
    return bool(deleted)


def verify(host, port, key, user=None):
    """返回 'known' / 'trusted'（首次记录）；不可信时抛异常。"""
    from django.utils import timezone

    model = _model()
    port = int(port or 22)
    current = fingerprint(key)
    row = model.objects.filter(host=host, port=port).first()
    if row is None:
        if strict_mode():
            raise HostKeyError(f'{host_id(host, port)} 尚未录入主机密钥指纹，严格模式拒绝连接。')
        model.objects.create(
            host=host, port=port,
            key_type=key.get_name() if hasattr(key, 'get_name') else '',
            fingerprint=current, source=model.Source.TOFU,
            trusted_by=user if getattr(user, 'pk', None) else None,
        )
        return 'trusted'
    if row.fingerprint != current:
        raise HostKeyChanged(
            f'{host_id(host, port)} 主机密钥指纹与记录不符：'
            f'记录 {row.fingerprint}，本次 {current}。'
            '确认设备已更换后先 forget() 再重连；否则可能有人在中间。'
        )
    # 校验时间单独更新，避免整行写。
    model.objects.filter(pk=row.pk).update(verified_at=timezone.now())
    return 'known'


def load_map() -> dict:
    """连接前在主线程读一次，避免在 SSH 握手线程里碰 ORM。"""
    return {
        (row.host, row.port): {
            'key_type': row.key_type, 'fingerprint': row.fingerprint, 'source': row.source,
        }
        for row in _model().objects.all()
    }


class _PendingPolicy:
    """只在内存里比对；首次信任的记录攒起来，回主线程再落库。

    paramiko 在握手线程里回调这里，那里既没有 Django 的数据库连接，
    也不该为了写一行指纹去开一条。所以判断全在内存，写库延后。
    """

    def __init__(self, known=None):
        # known=None 表示推迟到真正握手时再读库：没建立连接就不该碰数据库。
        self.known = None if known is None else dict(known)
        self.pending = []
        self.rejected = None

    def _ensure_loaded(self):
        if self.known is None:
            self.known = load_map()

    def check(self, host, port, key):
        self._ensure_loaded()
        port = int(port or 22)
        current = fingerprint(key)
        entry = self.known.get((host, port))
        if entry is None:
            if strict_mode():
                raise HostKeyError(f'{host_id(host, port)} 尚未录入主机密钥指纹，严格模式拒绝连接。')
            record = {
                'host': host, 'port': port,
                'key_type': key.get_name() if hasattr(key, 'get_name') else '',
                'fingerprint': current,
            }
            self.known[(host, port)] = {**record, 'source': 'tofu'}
            self.pending.append(record)
            return 'trusted'
        if entry.get('fingerprint') != current:
            raise HostKeyChanged(
                f'{host_id(host, port)} 主机密钥指纹与记录不符：'
                f'记录 {entry.get("fingerprint")}，本次 {current}。'
                '确认设备已更换后先 forget() 再重连；否则可能有人在中间。'
            )
        return 'known'

    def flush(self):
        """把本次首次信任的主机写进库。连接成功后调用。"""
        if not self.pending:
            return
        model = _model()
        for record in self.pending:
            model.objects.update_or_create(
                host=record['host'], port=record['port'],
                defaults={
                    'key_type': record['key_type'],
                    'fingerprint': record['fingerprint'],
                    'source': model.Source.TOFU,
                },
            )
        self.pending.clear()


def policy(known=None):
    """paramiko 的 MissingHostKeyPolicy：不自动接受，只按内存里的记录比对。"""
    import paramiko

    inner = _PendingPolicy(known)

    class ToFuPolicy(paramiko.MissingHostKeyPolicy):
        pending = inner.pending

        def missing_host_key(self, client, hostname, key):
            try:
                port = client.sock.getpeername()[1]
            except (AttributeError, OSError, IndexError):
                port = 22
            try:
                inner.check(hostname, port, key)
            except HostKeyError as exc:
                inner.rejected = exc
                raise

        def flush(self):
            inner.flush()

    return ToFuPolicy()
