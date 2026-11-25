"""Planned maintenance windows for network devices, servers and weak-current assets.

The REST layer (index/api) and the server-rendered page both read rows through
row_payloads(), so a column added here reaches Vue and the template together.
"""
from datetime import timedelta

from django import forms
from django.contrib import messages
from django.core.paginator import Paginator
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count, Q
from django.shortcuts import redirect, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST, require_http_methods

from index.common.access import admin_required
from index.common.form_json import form_errors, form_saved, wants_json
from net.models import MaintenanceWindow, Network_Device, Server, WeakCurrentDevice

# One asset kind per list page; the values mirror AlertEvent.target_type.
KIND_TARGET_TYPES = {
    "networks": "network_device",
    "servers": "server",
    "weakcurrent": "monitor",
}
TARGET_MODELS = {
    "network_device": Network_Device,
    "server": Server,
    "monitor": WeakCurrentDevice,
}
TARGET_LABELS = dict(MaintenanceWindow.TargetType.choices)

PHASES = {"active": "进行中", "pending": "未开始", "ended": "已结束"}
PHASE_BADGES = {"active": "warning", "pending": "info", "ended": "neutral"}
STATE_CHOICES = (("", "全部"), ("active", "进行中"), ("pending", "未开始"), ("ended", "已结束"))
PAGE_SIZE = 50


class MaintenanceWindowForm(forms.Form):
    starts_at = forms.DateTimeField(input_formats=["%Y-%m-%dT%H:%M"])
    ends_at = forms.DateTimeField(input_formats=["%Y-%m-%dT%H:%M"])
    note = forms.CharField(required=False, max_length=200)

    def clean(self):
        cleaned = super().clean()
        start = cleaned.get("starts_at")
        end = cleaned.get("ends_at")
        if start and end and end <= start:
            raise forms.ValidationError("结束时间必须晚于开始时间。")
        return cleaned


def form_defaults(now=None):
    start = timezone.localtime(now or timezone.now()).replace(second=0, microsecond=0)
    return {
        "start": start.strftime("%Y-%m-%dT%H:%M"),
        "end": (start + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M"),
    }


def phase_of(window, at=None):
    """Half-open [starts_at, ends_at); a disabled window still reports its phase."""
    at = at or timezone.now()
    if window.starts_at <= at < window.ends_at:
        return "active"
    return "pending" if at < window.starts_at else "ended"


def attach_phase(windows, now=None):
    now = now or timezone.now()
    for window in windows:
        window.phase = phase_of(window, now)
        window.phase_label = PHASES[window.phase]
        window.phase_badge = PHASE_BADGES[window.phase]
    return windows


def window_metrics(now=None):
    """Counters for the page header cards; one aggregate query.

    The four buckets must add up to total. 「已结束」天然包含停用过的窗口，
    所以「停用且还没结束」单独记一格，否则这类窗口既不在进行中、也不在待生效、
    也不在已结束，三块之和永远小于总数。
    """
    now = now or timezone.now()
    return MaintenanceWindow.objects.aggregate(
        total=Count("id"),
        active=Count("id", filter=Q(
            is_enabled=True, starts_at__lte=now, ends_at__gt=now)),
        pending=Count("id", filter=Q(is_enabled=True, starts_at__gt=now)),
        ended=Count("id", filter=Q(ends_at__lte=now)),
        disabled=Count("id", filter=Q(is_enabled=False, ends_at__gt=now)),
    )


def asset_names(target_type, target_ids):
    model = TARGET_MODELS[target_type]
    label_field = "name" if target_type == "server" else "device_name"
    return {
        str(pk): name
        for pk, name in model.objects.filter(pk__in=target_ids).values_list("pk", label_field)
    }


def window_queryset(state="", now=None):
    """Shared filter for the page and the REST list."""
    now = now or timezone.now()
    windows = MaintenanceWindow.objects.order_by("-starts_at", "-created_at")
    if state == "active":
        return windows.filter(is_enabled=True, starts_at__lte=now, ends_at__gt=now)
    if state == "pending":
        return windows.filter(is_enabled=True, starts_at__gt=now)
    if state == "ended":
        return windows.filter(ends_at__lte=now)
    return windows


def row_payloads(windows, now=None):
    """Plain dicts for Vue; the same shape the REST list returns."""
    now = now or timezone.now()
    rows = list(windows)
    attach_phase(rows, now)
    names = {}
    for target_type in TARGET_MODELS:
        ids = [row.target_id for row in rows if row.target_type == target_type]
        if ids:
            names.update(asset_names(target_type, ids))
    return [
        {
            "id": str(row.pk),
            "target_type": row.target_type,
            "target_type_label": TARGET_LABELS.get(row.target_type, row.target_type),
            "target_id": str(row.target_id),
            "asset_name": names.get(str(row.target_id), str(row.target_id)),
            "starts_at": row.starts_at.isoformat(),
            "ends_at": row.ends_at.isoformat(),
            "starts_at_display": timezone.localtime(row.starts_at).strftime("%Y-%m-%d %H:%M"),
            "ends_at_display": timezone.localtime(row.ends_at).strftime("%Y-%m-%d %H:%M"),
            "note": row.note,
            "is_enabled": row.is_enabled,
            "phase": row.phase,
            "phase_label": row.phase_label,
            "phase_badge": row.phase_badge,
        }
        for row in rows
    ]


def create_windows(target_type, target_ids, starts_at, ends_at, note=""):
    """One window per asset. Shared by the form view and the REST endpoint.

    Validation lives here rather than in the callers: the REST endpoint used to
    skip it entirely and could write windows pointing at assets that never
    existed, or two overlapping windows for the same asset.
    """
    model = TARGET_MODELS.get(target_type)
    if model is None:
        raise ValidationError("这类资产不支持维护窗口。")
    wanted = list(dict.fromkeys(str(value) for value in target_ids))
    if not wanted:
        raise ValidationError("请先勾选要加入维护窗口的资产。")
    with transaction.atomic():
        known = {str(pk) for pk in model.objects.filter(pk__in=wanted).values_list("pk", flat=True)}
        missing = [value for value in wanted if value not in known]
        if missing:
            raise ValidationError("有 %d 个选中项已不存在，请刷新列表后重新选择。" % len(missing))
        overlapping = {
            str(value) for value in MaintenanceWindow.objects.filter(
                target_type=target_type, target_id__in=wanted,
                starts_at__lt=ends_at, ends_at__gt=starts_at,
            ).values_list("target_id", flat=True)
        }
        rows = [
            MaintenanceWindow(
                target_type=target_type, target_id=value,
                starts_at=starts_at, ends_at=ends_at, note=note,
            )
            for value in wanted
            if value not in overlapping
        ]
        return MaintenanceWindow.objects.bulk_create(rows)


@admin_required
@require_POST
def maintenance_window_create(request, kind):
    """Create one window per selected asset; the list page posts here."""
    def fail(message):
        if wants_json(request):
            return form_errors([message], reverse("asset_list", args=[kind]))
        messages.error(request, message)
        return redirect("asset_list", kind)

    target_type = KIND_TARGET_TYPES.get(kind)
    if not target_type:
        return fail("这类资产不支持维护窗口。")

    form = MaintenanceWindowForm(request.POST)
    requested = [value for value in request.POST.getlist("target_ids") if value]
    if not requested:
        return fail("请先在列表里勾选要加入维护窗口的资产。")
    if not form.is_valid():
        return fail("维护窗口未保存：%s" % " ".join(
            "%s %s" % (field, " ".join(errors)) for field, errors in form.errors.items()
        ))

    data = form.cleaned_data
    try:
        created = create_windows(
            target_type, requested, data["starts_at"], data["ends_at"], data["note"],
        )
    except ValidationError as exc:
        return fail(" ".join(exc.messages))
    if not created:
        return fail("这些资产在该时段已经有维护窗口了。")
    message = "已为 %d 个资产登记维护窗口：窗口内告警照常入库，但不外发。" % len(created)
    if wants_json(request):
        return form_saved(message, reverse("asset_list", args=[kind]))
    messages.success(request, message)
    return redirect("asset_list", kind)


@admin_required
@require_POST
def maintenance_window_delete(request, window_id):
    deleted, _ = MaintenanceWindow.objects.filter(pk=window_id).delete()
    messages.success(request, "维护窗口已删除。" if deleted else "维护窗口不存在。")
    # next 来自表单，不能直接交给 redirect：传 https://别处 时 Django 会原样
    # 302 出去，配合「发给另一个管理员点一下」就是一条开放重定向。
    target = request.POST.get("next") or ""
    if not url_has_allowed_host_and_scheme(
        target, allowed_hosts={request.get_host()}, require_https=request.is_secure(),
    ):
        target = "maintenance_list"
    return redirect(target)


@admin_required
@require_http_methods(["GET"])
def maintenance_list(request):
    """Server-rendered first paint; the Vue page takes over from the same payload."""
    state = (request.GET.get("state") or "").strip()
    now = timezone.now()
    page = Paginator(window_queryset(state, now), PAGE_SIZE).get_page(request.GET.get("page"))
    bootstrap = {
        "state": state,
        "states": [{"value": value, "label": label} for value, label in STATE_CHOICES],
        "endpoint": "/api/v1/maintenance-windows/",
        "count": page.paginator.count,
        "page": page.number,
        "pages": page.paginator.num_pages,
        "page_size": PAGE_SIZE,
        "rows": row_payloads(page.object_list, now),
        "can_administer": True,
    }
    return render(request, "maintenance/list.html", {"bootstrap": bootstrap})
