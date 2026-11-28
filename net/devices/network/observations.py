"""Locate an IP or MAC using ARP/MAC evidence inspections already collect.

Read-only projection over saved results: no extra device access, no new
scanner. ARP and MAC entries are passive observations with a timestamp - they
never prove a host is currently online, and every row carries its source time.
"""
from __future__ import annotations

from datetime import timedelta

from django.db.models import Exists, OuterRef
from django.utils import timezone

from net.models import Network_Device_Inspection

LOOKBACK_DAYS = 7
MAX_MATCHES = 50

_IP_KEYS = ("ip_address", "ip", "address", "ipv4_address")
_MAC_KEYS = ("mac_address", "mac", "mac_addr")
_INTERFACE_KEYS = ("interface", "port", "iface", "physical_interface")
_VLAN_KEYS = ("vlan", "vlan_id", "vlanid")


def _first(record, keys):
    if not isinstance(record, dict):
        return ""
    for key in keys:
        value = record.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text and text != "-":
            return text
    return ""


def normalize_mac(value):
    """Compare MACs regardless of separators: aa:bb:cc equals aabbcc."""
    return "".join(char for char in str(value).lower() if char.isalnum())


def _records(details, item):
    payload = details.get(item) if isinstance(details, dict) else None
    if not isinstance(payload, dict):
        return []
    rows = payload.get("records")
    return rows if isinstance(rows, list) else []


def latest_inspections(*, lookback_days=LOOKBACK_DAYS):
    """One successful result per device: the newest inside the lookback window.

    在查询里直接排掉"同一设备还有更晚成功记录"的行，每设备只留最新一条。
    原来是先按 created_at 全局取 [:MAX_RECORDS] 再按设备 setdefault：设备数乘
    采集轮数一过上限，排在后面的设备一条都不剩，它们的 MAC 证据静默消失。
    设备表是人工维护的物理清单，每设备恰好一行，行数天然有界，不需要全局预算。
    """
    since = timezone.now() - timedelta(days=lookback_days)
    superseded = Network_Device_Inspection.objects.filter(
        status="success", created_at__gte=since,
        device_id=OuterRef("device_id"), created_at__gt=OuterRef("created_at"))
    rows = (Network_Device_Inspection.objects
            .select_related("device", "task_target")
            .filter(status="success", created_at__gte=since)
            .filter(~Exists(superseded))
            .order_by("device_id", "-created_at"))
    latest = {}
    for row in rows:
        latest.setdefault(row.device_id, row)
    return latest


def observed_addresses(*, lookback_days=LOOKBACK_DAYS):
    """Every IP in ARP evidence, with the normalized MACs and device that saw it."""
    latest = latest_inspections(lookback_days=lookback_days)
    seen = {}
    for inspection in latest.values():
        for record in _records(inspection.details or {}, "arp_table"):
            ip = _first(record, _IP_KEYS)
            if not ip:
                continue
            entry = seen.setdefault(ip, {"macs": set(), "devices": []})
            mac = _first(record, _MAC_KEYS)
            if mac:
                entry["macs"].add(normalize_mac(mac))
            entry["devices"].append(inspection.device.device_name)
    return {"addresses": seen, "devices": len(latest)}


def mac_locations(*, lookback_days=LOOKBACK_DAYS):
    """每个 MAC 最后出现在哪台设备的哪个口。

    交换机的 MAC 地址表是终端位置的真凭据：PC 和服务器不发 LLDP，拓扑里看不到
    它们，但它们的 MAC 一定会在某一台接入交换机的某个口上被学到。同一个 MAC
    可能同时出现在级联的多台设备上（上游设备也会学到），取巡检时间最新的那台。

    返回 {归一化 MAC: (设备 pk, 接口名)}。
    """
    latest = latest_inspections(lookback_days=lookback_days)
    found = {}
    for inspection in latest.values():
        for record in _records(inspection.details or {}, "mac_table"):
            mac = normalize_mac(_first(record, _MAC_KEYS))
            interface = _first(record, _INTERFACE_KEYS)
            if not mac or not interface:
                continue
            previous = found.get(mac)
            if previous is None or inspection.created_at > previous[2]:
                found[mac] = (inspection.device_id, interface, inspection.created_at)
    # 时间要一起带出去：同一个 MAC 会被级联的上游设备一起学到，
    # 判断该挂哪台时要看谁学到的时刻最新。
    return dict(found)


def search(query, *, lookback_days=LOOKBACK_DAYS):
    """Match one IP or MAC against each device's latest successful result."""
    needle = (query or "").strip()
    if not needle:
        return {"query": "", "matches": [], "devices": 0, "window_days": lookback_days}
    needle_mac = normalize_mac(needle)
    needle_ip = needle.lower()

    latest = latest_inspections(lookback_days=lookback_days)

    matches = []
    truncated = False
    for inspection in latest.values():
        details = inspection.details or {}
        device = inspection.device
        for source, item in (("arp", "arp_table"), ("mac", "mac_table")):
            for record in _records(details, item):
                ip = _first(record, _IP_KEYS)
                mac = _first(record, _MAC_KEYS)
                hit_ip = bool(ip) and ip.lower() == needle_ip
                hit_mac = bool(mac) and bool(needle_mac) and normalize_mac(mac) == needle_mac
                if not (hit_ip or hit_mac):
                    continue
                if len(matches) >= MAX_MATCHES:
                    truncated = True
                    break
                matches.append({
                    "device_id": str(device.pk),
                    "device_name": device.device_name,
                    "device_ip": device.ip,
                    "ip": ip,
                    "mac": mac,
                    "interface": _first(record, _INTERFACE_KEYS),
                    "vlan": _first(record, _VLAN_KEYS),
                    "source": source,
                    "observed_at": inspection.created_at,
                    "task_id": inspection.task_target.task_id if inspection.task_target_id else None,
                })
            if truncated:
                break
        if truncated:
            break

    return {
        "query": needle,
        "matches": matches,
        "devices": len(latest),
        "window_days": lookback_days,
        "truncated": truncated,
    }
