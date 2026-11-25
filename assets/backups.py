"""Administrator-only access to saved configuration versions."""
import re
import unicodedata
from datetime import datetime

from django.core.exceptions import ImproperlyConfigured
from django.http import Http404, HttpResponse, HttpResponseNotFound, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.template.defaultfilters import filesizeformat
from django.urls import reverse
from django.utils import timezone
from django.utils.http import content_disposition_header
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from index.common.access import admin_required
from net.models import Network_Device, WeakCurrentDevice
from index.common.json_script import localized_json_script

HISTORY_COLUMNS = (
    ("captured", "采集时间"), ("filename", "文件"), ("vendor", "厂商 / 范围"),
    ("size", "大小"), ("change", "较上一版"), ("sha256", "SHA-256"),
    ("task", "来源任务"),
)
HISTORY_NOTICE = (
    "配置原文不含脱敏，可能包含账号、密码等敏感凭据，只允许管理员下载；"
    "本页仅展示版本元数据，不预览原文，也不提供恢复或上传操作。"
)
HISTORY_NOTICE_BY_KIND = {
    "weakcurrent": "弱电设备目前只覆盖 Network 配置节的部分 API，"
                   "既有部分配置快照不代表已生成整机备份。",
}
DEFAULT_HISTORY_NOTICE = (
    "每日巡检自动备份一次当前运行配置，不含证书、私钥或固件，不是整机镜像。"
)
EMPTY_TITLE = "暂无可用配置备份"
EMPTY_MESSAGE = (
    "仅成功采集并保存的版本会显示在此；既有脱敏快照或部分配置节不一定形成完整备份。"
)
NO_EARLIER_TITLE = "没有更早的版本可比"
NO_EARLIER_MESSAGE = (
    "这是该设备最早保存的一版配置，或目前只保存了一版。"
    "每日首个成功巡检会保存一个版本，最多保留 10 个。"
)


def _script(payload, element_id):
    return localized_json_script(payload, element_id)


def _stamp(value, fmt):
    """日期与时间共用：只有带时区的 datetime 需要换成当地时间。"""
    if not value:
        return ""
    if isinstance(value, datetime) and timezone.is_aware(value):
        value = timezone.localtime(value)
    return value.strftime(fmt)


def _page_heading(title, description, **extra):
    payload = {
        "eyebrow": "设备配置",
        "title": title,
        "description": description,
    }
    payload.update(extra)
    return payload


def _asset(kind, pk):
    models = {'networks': Network_Device, 'weakcurrent': WeakCurrentDevice}
    if kind not in models:
        raise Http404('此资产类型不支持配置备份')
    return get_object_or_404(models[kind], pk=pk)


def _change_cell(added, removed):
    """旧表格的三种状态：+N/-N 小片、只有「无变化」、以及首个版本没有可比基数。"""
    chips = []
    if added:
        chips.append({"text": "+%s" % added, "tone": "add"})
    if removed:
        chips.append({"text": "-%s" % removed, "tone": "remove"})
    if added or removed:
        note = ""
    elif added is None and removed is None:
        note = "首个版本"
    else:
        note = "无变化"
    return {"chips": chips, "note": note}


def _backup_row(backup, kind, asset):
    added = getattr(backup, 'change_added', None)
    removed = getattr(backup, 'change_removed', None)
    task_url = ''
    if getattr(backup, 'task_target_id', None):
        task_url = reverse('task_detail', args=[backup.task_target.task_id])
    return {
        "id": str(backup.pk),
        "cells": {
            "captured": {
                "text": _stamp(backup.backup_date, '%Y-%m-%d'),
                "sub": _stamp(backup.captured_at, '%H:%M:%S %Z'),
                "stamp": True,
            },
            "filename": {"text": backup.filename, "sub": backup.media_type, "wrap": True},
            "vendor": {
                "text": backup.vendor or '未记录',
                "sub": backup.scope or '未记录',
            },
            "size": {
                "text": filesizeformat(backup.byte_size),
                "sub": "%s 字节" % backup.byte_size,
            },
            "change": _change_cell(added, removed),
            "sha256": {"text": backup.sha256, "code": True, "title": backup.sha256, "hash": True},
            "task": (
                {"text": "查看来源任务", "href": task_url}
                if task_url else {"text": "无关联任务", "muted": True}
            ),
        },
        "actions": [
            {
                "label": "下载原文",
                "url": reverse('configuration_backup_download', args=[kind, asset.pk, backup.pk]),
                "variant": "primary",
            },
            {
                "label": "与上一版对比",
                "url": reverse('configuration_backup_diff', args=[kind, asset.pk, backup.pk]),
                "variant": "secondary",
            },
        ],
    }


def _history_bootstrap(kind, asset, backups):
    total_bytes = sum(int(getattr(item, 'byte_size', 0) or 0) for item in backups)
    latest = backups[0].captured_at if backups else None
    payload = {
        "page": _page_heading(
            "配置备份历史",
            "%s · 保留最近 10 个成功日版本，第 11 份保存时删除最早一份" % asset,
            back_url=reverse('asset_detail', args=[kind, asset.pk]),
            back_label="返回设备详情",
        ),
        "notice": HISTORY_NOTICE + HISTORY_NOTICE_BY_KIND.get(kind, DEFAULT_HISTORY_NOTICE),
        "columns": [
            {"key": key, "label": label} for key, label in HISTORY_COLUMNS
        ],
        "rows": [_backup_row(backup, kind, asset) for backup in backups],
        "section_title": "已保存版本",
        "summary_label": "版本摘要",
        "summary": [
            {"label": "版本", "value": len(backups)},
            {"label": "合计", "value": filesizeformat(total_bytes)},
        ],
        "change_summary": {
            "label": "累计变更",
            "added": sum(getattr(item, 'change_added', None) or 0 for item in backups),
            "removed": sum(getattr(item, 'change_removed', None) or 0 for item in backups),
        },
        "latest_label": "最近采集",
        "latest": _stamp(latest, '%Y-%m-%d %H:%M'),
        "scroll_hint": "可横向滚动查看文件、校验值和来源任务",
        "region_label": "配置备份版本表",
        "empty_title": EMPTY_TITLE,
        "empty_message": EMPTY_MESSAGE,
    }
    return payload


@never_cache
@admin_required
@require_GET
def configuration_backup_list(request, kind, pk):
    from net.devices.configuration_backups import list_configuration_backups

    try:
        asset = _asset(kind, pk)
    except Http404:
        return HttpResponseNotFound('未找到设备或配置备份。')
    backups = list(list_configuration_backups(asset)[:10])
    return render(request, 'devices/configuration_backups.html', {
        'history_bootstrap': _script(
            _history_bootstrap(kind, asset, backups), 'configuration-backups-bootstrap',
        ),
    })

@never_cache
@admin_required
@require_GET
def configuration_backup_download(request, kind, pk, backup_id):
    from net.devices.configuration_backups import (
        list_configuration_backups, read_configuration_backup,
    )

    try:
        asset = _asset(kind, pk)
        backup = get_object_or_404(
            list_configuration_backups(asset), pk=backup_id,
            device_type='network_device' if kind == 'networks' else 'monitor',
            device_id=asset.pk,
        )
    except Http404:
        return HttpResponseNotFound('未找到设备或配置备份。')

    try:
        raw = read_configuration_backup(backup)
    except (ValueError, ImproperlyConfigured):
        # Never expose ciphertext, plaintext or key diagnostics in error pages.
        return HttpResponse('备份暂时无法读取或校验失败，请联系管理员。', status=503,
                            content_type='text/plain; charset=utf-8')

    filename = re.split(r'[/\\]', backup.filename or '')[-1]
    filename = ''.join(
        char for char in filename
        if not unicodedata.category(char).startswith('C') and char not in '<>:"|?*'
    ).strip(' .')[:180]
    filename = filename or f'configuration-{backup.pk}.cfg'
    response = HttpResponse(raw, content_type='application/octet-stream')
    response['Content-Disposition'] = content_disposition_header(True, filename)
    response['Content-Length'] = str(len(raw))
    response['X-Content-Type-Options'] = 'nosniff'
    return response


def _diff_bootstrap(kind, asset, current, against, versions, diff):
    """差异页整页数据；?fragment=diff 换对比版本时回同一份。"""
    change_badge = {"label": "", "tone": ""}
    if diff is not None:
        change_badge = (
            {"label": "新增 %s 行 / 删除 %s 行" % (diff['added'], diff['removed']),
             "tone": "warning"}
            if diff['changed'] else {"label": "两版内容一致", "tone": "info"}
        )
    return {
        "page": _page_heading(
            "配置版本对比",
            "%s · 仅管理员可见" % asset,
            back_url=reverse('configuration_backup_list', args=[kind, asset.pk]),
            back_label="返回备份历史",
        ),
        "columns": [
            {"key": "left", "label": "旧", "gutter": True},
            {"key": "right", "label": "新", "gutter": True},
            {"key": "text", "label": "内容"},
        ],
        "region_label": "配置差异明细表",
        "current_id": str(current.pk),
        "against_id": str(against.pk) if against is not None else "",
        "versions": [
            {
                "value": str(item.pk),
                "label": "%s · %s · %s" % (
                    _stamp(item.backup_date, '%Y-%m-%d'),
                    _stamp(item.captured_at, '%H:%M:%S'),
                    item.filename,
                ),
            }
            for item in versions if item.pk != current.pk
        ],
        "older": {
            "label": "旧版本",
            "date": _stamp(against.backup_date, '%Y-%m-%d') if against is not None else "",
            "stamp": _stamp(against.captured_at, '%Y-%m-%d %H:%M:%S') if against is not None else "",
        },
        "newer": {
            "label": "新版本",
            "date": _stamp(current.backup_date, '%Y-%m-%d'),
            "stamp": _stamp(current.captured_at, '%Y-%m-%d %H:%M:%S'),
        },
        "change_label": "变更",
        "change_badge": change_badge,
        "switch_label": "与其它版本对比",
        "truncated_message": (
            "配置过大，仅显示前 %s 行差异。" % len(diff['rows'])
            if diff is not None and diff['truncated'] else ""
        ),
        "rows": diff['rows'] if diff is not None else [],
        "empty_title": NO_EARLIER_TITLE,
        "empty_message": NO_EARLIER_MESSAGE,
    }


@never_cache
@admin_required
@require_GET
def configuration_backup_diff(request, kind, pk, backup_id):
    """Compare two saved versions; the query string picks the older side."""
    from net.devices.configuration_backups import list_configuration_backups
    from net.devices.configuration_diff import diff_backups

    try:
        asset = _asset(kind, pk)
        versions = list(list_configuration_backups(asset))  # 最新在前
    except Http404:
        return HttpResponseNotFound('未找到设备或配置备份。')

    current = next((item for item in versions if str(item.pk) == str(backup_id)), None)
    if current is None:
        return HttpResponseNotFound('未找到配置备份。')

    position = next(index for index, item in enumerate(versions) if item.pk == current.pk)
    # 只有比当前更旧的版本才能当「旧版本」。原来候选里包含比 current 更新的版本，
    # 选中后旧/新标签和 +/- 行数整个反过来，两版内容有差异时就是错的结论。
    older_versions = versions[position + 1:]
    against = versions[position + 1] if position + 1 < len(versions) else None
    requested = (request.GET.get('against') or '').strip()
    if requested:
        against = next((item for item in older_versions if str(item.pk) == requested), None)
        if against is None:
            return HttpResponseNotFound('未找到用于对比的配置版本。')

    diff = None
    if against is not None:
        try:
            diff = diff_backups(against, current)
        except (ValueError, ImproperlyConfigured):
            return HttpResponse('备份暂时无法读取或校验失败，请联系管理员。', status=503,
                                content_type='text/plain; charset=utf-8')

    payload = _diff_bootstrap(kind, asset, current, against, older_versions, diff)
    # 换对比版本不下拉整页：岛里重取这一份 JSON，地址栏保持不动。
    if request.GET.get('fragment') == 'diff':
        return JsonResponse(payload)
    return render(request, 'devices/configuration_diff.html', {
        'diff_bootstrap': _script(payload, 'configuration-diff-bootstrap'),
    })
