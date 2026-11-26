"""XML parsing that refuses entity expansion.

xml.etree expands internal entities, so a few hundred crafted bytes can expand to
megabytes and stall a Worker thread. The rows/columns/cell limits in the callers all
run *after* parsing, so they cannot help. Rejecting DOCTYPE/ENTITY up front buys that
protection without taking on defusedxml.
"""
from xml.etree import ElementTree

# 只查前缀挡不住：XML 允许根元素之前出现任意长的注释和处理指令，把 DOCTYPE
# 放到第 4096 字节之后就能大摇大摆走过去。实测 6 KB 的 payload 能被展开成
# 一百万个字符，四层嵌套就是上百 MB——解析这步没有任何限额能拦它。
# 响应体本身已有 4 MiB 上限（见 native_http），全量扫描的代价可以接受。
_DECLARATION_MARKERS = (b'<!doctype', b'<!entity')


def safe_fromstring(payload):
    """Parse XML, raising ValueError when it declares a DOCTYPE or ENTITY."""
    if isinstance(payload, bytes):
        lowered = payload.lower()
    else:
        lowered = payload.encode('utf-8', 'replace').lower()
    if any(marker in lowered for marker in _DECLARATION_MARKERS):
        raise ValueError('XML with a DOCTYPE or entity declaration is rejected.')
    return ElementTree.fromstring(payload)
