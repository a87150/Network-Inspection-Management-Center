"""SSH 主机密钥策略：首次信任即锁定（TOFU），指纹变了就停。

设备管理员口令是同型号设备一套传一套，被中间人接住一次就等于丢一片，
所以这里不提供"自动接受新密钥"的无条件路径：

* 默认 TOFU —— 第一次见到某台主机时把密钥指纹记进 runtime/host_keys.json，
  之后每次比对。指纹不一致直接拒绝连接，不会静默覆盖。
* 严格模式（NET_SSH_HOST_KEY_STRICT=1）—— 只认已经记过的指纹，未知主机拒绝，
  录入靠运维显式 trust()。几十台设备要认这个成本，由部署方决定。
* 指纹不符永远拒绝，没有开关能绕过；换设备后要人工 forget() 再重连。

known_hosts 存的是指纹不是口令，但仍是可信边界数据：文件权限跟着 runtime 走。
"""
import json
import os
import threading
from pathlib import Path

_LOCK = threading.Lock()
_CACHE = None


class HostKeyError(RuntimeError):
    """主机密钥不可信：未知（严格模式）或与记录不符。"""


class HostKeyChanged(HostKeyError):
    """记录的指纹和这次拿到的对不上，可能是换设备，也可能是中间人。"""


def store_path() -> Path:
    override = os.getenv('NET_SSH_KNOWN_HOSTS')
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[2] / 'runtime' / 'host_keys.json'


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


def _read() -> dict:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    path = store_path()
    if not path.exists():
        _CACHE = {}
        return _CACHE
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        data = {}
    _CACHE = data if isinstance(data, dict) else {}
    return _CACHE


def _write(data: dict):
    global _CACHE
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8')
    tmp.replace(path)
    _CACHE = data


def entries() -> dict:
    return dict(_read())


def recorded(host, port):
    return _read().get(host_id(host, port))


def trust(host, port, key):
    """显式信任一台主机（严格模式下的录入入口）。"""
    with _LOCK:
        data = dict(_read())
        data[host_id(host, port)] = {
            'key_type': key.get_name() if hasattr(key, 'get_name') else '',
            'fingerprint': fingerprint(key),
            'source': 'manual',
        }
        _write(data)
        return data[host_id(host, port)]


def forget(host, port) -> bool:
    with _LOCK:
        data = dict(_read())
        removed = data.pop(host_id(host, port), None)
        if removed is not None:
            _write(data)
        return removed is not None


def verify(host, port, key):
    """返回 'known' / 'trusted'（首次记录）；不可信时抛异常。"""
    current = fingerprint(key)
    entry = recorded(host, port)
    if entry is None:
        if strict_mode():
            raise HostKeyError(
                f'{host_id(host, port)} 尚未录入主机密钥指纹，严格模式拒绝连接。'
            )
        with _LOCK:
            data = dict(_read())
            data[host_id(host, port)] = {
                'key_type': key.get_name() if hasattr(key, 'get_name') else '',
                'fingerprint': current,
                'source': 'tofu',
            }
            _write(data)
        return 'trusted'
    if entry.get('fingerprint') != current:
        raise HostKeyChanged(
            f'{host_id(host, port)} 主机密钥指纹与记录不符：'
            f'记录 {entry.get("fingerprint")}，本次 {current}。'
            '确认设备已更换后先 forget() 再重连；否则可能有人在中间。'
        )
    return 'known'


def policy():
    """paramiko 的 MissingHostKeyPolicy：不自动接受，只按 verify() 的结论走。"""
    import paramiko

    class ToFuPolicy(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client, hostname, key):
            # client 是 paramiko 的 Transport；端口只能从对端地址拿。
            try:
                port = client.sock.getpeername()[1]
            except (AttributeError, OSError, IndexError):
                port = 22
            verify(hostname, port, key)

    return ToFuPolicy()


def reset_cache():
    """测试用：清掉进程内缓存。"""
    global _CACHE
    _CACHE = None
