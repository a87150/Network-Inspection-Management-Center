"""IP lookup and the IP address plan on one page: evidence on top, plan below."""
from datetime import datetime

from django.http import JsonResponse
from django.views.decorators.clickjacking import xframe_options_sameorigin
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.csrf import get_token
from django.views.decorators.http import require_GET

from index.common.access import is_admin
from net.devices.network.ipam import plan_report
from net.devices.network.observations import search
from net.models import IpSubnet
from index.common.json_script import localized_json_script

PAGE = {
    "eyebrow": "网络取证",
    "title": "IP 管理",
    "description": "查地址在哪台设备的哪个口见过，并对照登记的 IP 台账",
}
LEDGER_COLUMNS = (
    ("cidr", "网段"), ("purpose", "用途"), ("vlan", "VLAN"), ("gateway", "网关"),
    ("pool", "DHCP 地址池"), ("usable", "可用"), ("registered", "登记"),
)
MATCH_COLUMNS = (
    ("ip", "IP"), ("mac", "MAC"), ("device", "设备"), ("interface", "接口"),
    ("vlan", "VLAN"), ("source", "来源"), ("observed_at", "采集时间"),
)
ISSUE_LIMIT = 8


def _script(payload, element_id):
    return localized_json_script(payload, element_id)


def _stamp(value, fmt="%Y-%m-%d %H:%M:%S"):
    if not value:
        return ""
    if isinstance(value, datetime) and timezone.is_aware(value):
        value = timezone.localtime(value)
    return value.strftime(fmt)


def _columns(pairs):
    return [{"key": key, "label": label} for key, label in pairs]


def _match_rows(matches):
    rows = []
    for match in matches:
        task_url = reverse("task_detail", args=[match["task_id"]]) if match["task_id"] else ""
        rows.append({
            "id": "%s-%s" % (match["device_id"], match["observed_at"]),
            "cells": {
                "ip": {"text": match["ip"] or "—", "code": True},
                "mac": {"text": match["mac"] or "—", "code": True},
                "device": {
                    "text": match["device_name"],
                    "sub": match["device_ip"],
                    "href": reverse("asset_detail", args=["networks", match["device_id"]]),
                },
                "interface": {"text": match["interface"] or "—"},
                "vlan": {"text": match["vlan"] or "—"},
                "source": {"text": "ARP" if match["source"] == "arp" else "MAC"},
                "observed_at": {
                    "text": _stamp(match["observed_at"]),
                    "href": task_url,
                    "href_text": "查看任务",
                },
            },
        })
    return rows


def _lookup_block(query):
    """一次地址定位的结果，?fragment=lookup 也回这一块。"""
    result = search(query) if query else {"matches": [], "truncated": False}
    matches = result["matches"]
    return {
        "query": query,
        "columns": _columns(MATCH_COLUMNS),
        "rows": _match_rows(matches),
        "label": "匹配 %s 条" % len(matches),
        "region_label": "IP 定位结果表",
        "truncated": result["truncated"],
        "truncated_message": "匹配过多，仅显示前 %s 条。" % len(matches),
        "empty_title": "没有匹配记录",
        "empty_message": "该地址可能未在此时间窗内被采集到，或设备未勾选 ARP / MAC 表巡检项。",
    }


def _subnet_row(subnet):
    pool = {"text": "未设置", "muted": True}
    if subnet.pool_start:
        pool = {
            "text": "%s - %s" % (subnet.pool_start, subnet.pool_end),
            "sub": "%s 个" % subnet.pool_size,
            "code": True,
        }
    return {
        "id": str(subnet.pk),
        "cells": {
            "cidr": {"text": subnet.cidr, "sub": subnet.note, "code": True},
            "purpose": {"text": subnet.get_purpose_display()},
            "vlan": {"text": subnet.vlan or "—"},
            "gateway": {"text": subnet.gateway or "—"},
            "pool": pool,
            "usable": {"text": subnet.usable_hosts},
            "registered": {"text": len(subnet.addresses.all())},
        },
    }


def _issue_rows(issues):
    return [
        {
            "title": issue["title"],
            "detail": issue["detail"],
            "tone": "danger" if issue["severity"] == "error" else "warning",
            "label": "需处理" if issue["severity"] == "error" else "需确认",
        }
        for issue in issues[:ISSUE_LIMIT]
    ]


def _ledger_block(report):
    subnets = report["subnets"]
    issues = report["issues"]
    return {
        "columns": _columns(LEDGER_COLUMNS),
        "rows": [_subnet_row(subnet) for subnet in subnets],
        "label": "IP 台账",
        "region_label": "IP 网段表",
        "counts": [
            {"label": "网段", "value": len(subnets)},
            {"label": "登记", "value": report["registered_count"]},
            {"label": "观察", "value": report["observed_count"]},
            {"label": "未登记", "value": report["unplanned_count"]},
        ],
        "issues": _issue_rows(issues),
        "issue_more": "另有 %s 条提示未展开。" % (len(issues) - ISSUE_LIMIT)
        if len(issues) > ISSUE_LIMIT else "",
        "consistent_message": "台账与巡检观察一致，没有需要处理的提示。",
        "empty_title": "还没有登记网段",
        "empty_message": "点右上角「增加 IP 段」填网段、网关和 DHCP 地址池，"
                        "登记 IP 后本页会自动比对巡检看到的结果。",
        "unplanned": report["unplanned"],
        "unplanned_label": "观察到但未登记（前 %s 个）" % len(report["unplanned"]),
    }


@xframe_options_sameorigin
@require_GET
def ip_management(request):
    query = (request.GET.get("q") or "").strip()
    # 地址栏不动：查询在岛内重取这一块。
    if request.GET.get("fragment") == "lookup":
        return JsonResponse(_lookup_block(query))
    # 保存网段后只重取台账那一块。
    if request.GET.get("fragment") == "ledger":
        return JsonResponse({"ledger": _ledger_block(plan_report())})

    report = plan_report()
    payload = {
        "page": PAGE,
        "endpoint": "/api/v1/ip-subnets/",
        "can_administer": is_admin(request.user),
        "purposes": [
            {"value": value, "label": label}
            for value, label in IpSubnet.Purpose.choices
        ],
        "csrf": get_token(request),
        "query": query,
        "hint": "取自各设备最近一次成功巡检的 ARP / MAC 表，默认回看 %s 天"
                "（当前覆盖 %s 台设备）。ARP 与 MAC 是被动观察，只能证明某次巡检见过，"
                "不能证明此刻在线。" % (report["window_days"], report["devices"]),
        "lookup": _lookup_block(query) if query else None,
        "ledger": _ledger_block(report),
    }
    return render(request, "topology/ip_management.html", {
        "ip_bootstrap": _script(payload, "ip-subnet-bootstrap"),
    })
