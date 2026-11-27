"""Known network CLI families; export only complete saved native text."""
import re

from net.data_exchange.adapters import UnsupportedConfiguration, readable_text


# Scope is the displayed active configuration, not startup/files/certificates.
NETWORK_CONFIG = {
    'cisco': ('terminal length 0', 'show running-config', 'end', 'running-config'),
    'h3c': ('screen-length disable', 'display current-configuration', 'return', 'current-configuration'),
}

BAD_OUTPUT = re.compile(
    r'(?im)--\s*more\s*--|----\s*more\s*----|press\s+(?:any|enter|space)|'
    r'\b(?:truncated|pagination)\b|^\s*(?:%\s*)?(?:error\b|invalid\s+(?:input|command)|'
    r'unrecognized\s+command|unknown\s+command|incomplete\s+command|ambiguous\s+command|'
    r'permission\s+denied|access\s+denied|authorization\s+failed|not\s+authorized)|'
    r'^\s*(?:错误|无效命令|命令不完整|权限不足)')


def network_vendor(value):
    """日志里的品牌名 → 有原生配置命令的 CLI 家族，没有就返回空串。

    这里原先自己维护一张 VENDOR_ALIASES（只有 cisco/h3c），和台账那边的
    collection_profiles.ALIASES 是两套：'h3' 在这一侧认不出来，退化成
    generic_termerserver 驱动配 'terminal length 0'，而采集模板那侧认出 h3c、
    下的是 'display version'——驱动与命令集错配，配置备份还会被判 unsupported。
    现在统一走 normalize_vendor，两张表只留一张。
    """
    from net.devices.collection_profiles import normalize_vendor

    normalized = normalize_vendor(value)
    return normalized if normalized in NETWORK_CONFIG else ''


def validate_native(content, vendor):
    if vendor not in NETWORK_CONFIG:
        raise UnsupportedConfiguration('unregistered CLI family')
    if not readable_text(content) or BAD_OUTPUT.search(content):
        raise ValueError('invalid or incomplete native text')
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    terminator = NETWORK_CONFIG[vendor][2]
    meaningful = [line for line in lines[:-1]
                  if line not in ('!', '#') and not line.startswith(('Building configuration', 'Current configuration'))]
    if len(lines) < 2 or lines[-1] != terminator or not meaningful:
        raise ValueError('missing native configuration terminator/body')
    return content


def adapt(item):
    vendor = network_vendor(item.get('vendor'))
    if vendor not in NETWORK_CONFIG or item.get('format') != 'text':
        raise UnsupportedConfiguration('unsupported configuration format/vendor')
    if item.get('complete') is not True or item.get('scope') != NETWORK_CONFIG[vendor][3]:
        raise ValueError('incomplete configuration scope')
    return validate_native(item.get('content'), vendor), 'text/plain', 'txt', item['scope']
