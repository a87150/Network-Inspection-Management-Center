from django.contrib import messages
from index.common.access import admin_required
from index.common.form_json import form_errors, form_saved, wants_json
from django.db import IntegrityError, transaction
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse
from django.views.decorators.http import require_POST
from net.models import TaskRun, TaskTargetRun

def _stale_revision(asset, revision):
    """表单版本与库里不一致时视为并发覆盖。没带版本的调用方（脚本、旧页面）放行。"""
    if not revision:
        return False
    current = asset.__class__.objects.filter(pk=asset.pk).values_list(
        'updated_at', flat=True).first()
    if current is None:
        return True
    return current.isoformat() != str(revision)


def _integrity_message(exc):
    """把数据库约束失败翻译成用户能照做的提示。

    原来所有写入失败都说「请检查 IP 是否已存在」，包括端口为空这种跟 IP 毫无
    关系的情况，用户会一直盯着 IP 改。
    """
    text = str(getattr(exc, '__cause__', None) or exc).lower()
    if 'port' in text:
        return '端口必须填写（1-65535）。'
    if 'ip' in text:
        return '设备保存冲突，请检查 IP 是否已存在。'
    return '设备保存失败，请检查填写内容是否与已有记录冲突。'


from .forms import DEVICE_KINDS, device_form, preserve_empty_secrets


@admin_required
@require_POST
def asset_create(request, kind):
    if kind not in DEVICE_KINDS:
        raise Http404('该项目不支持手动添加设备。')
    form = device_form(kind, request.POST)
    if form.is_valid():
        try:
            with transaction.atomic():
                form.save()
        except IntegrityError as exc:
            form.add_error(None, _integrity_message(exc))
        else:
            if wants_json(request):
                return form_saved('设备已添加，可在列表中查看；尚未执行巡检。',
                                  reverse('asset_list', args=[kind]))
            messages.success(request, '设备已添加，可在列表中查看；尚未执行巡检。')
            return redirect('asset_list', kind=kind)
    if wants_json(request):
        return form_errors(_form_messages(form), reverse('asset_list', args=[kind]))
    from .views import asset_list
    return asset_list(request, kind, creation_form=form)


_CONNECTION_FIELDS = {
    'networks': {'vendor', 'ip', 'connection_type', 'port', 'username', 'password', 'snmp_version', 'snmp_port', 'snmp_community', 'snmp_security_level', 'snmp_username', 'snmp_auth_protocol', 'snmp_auth_password', 'snmp_priv_protocol', 'snmp_priv_password', 'snmp_context_name', 'snmp_retries'},
    'servers': {'server_type', 'ip', 'port', 'username', 'password', 'api_url', 'api_token', 'verify_ssl'},
    'weakcurrent': {'vendor', 'device_type', 'ip', 'api_url', 'api_username', 'api_password', 'api_token', 'verify_ssl'},
}
_TARGET_TYPES = {
    'networks': TaskTargetRun.TargetType.NETWORK_DEVICE,
    'servers': TaskTargetRun.TargetType.SERVER,
    'weakcurrent': TaskTargetRun.TargetType.WEAK_CURRENT,
}


def _connection_changes_during_active_task(kind, form, asset):
    original = type(asset).objects.get(pk=asset.pk)
    changed = [
        name for name in _CONNECTION_FIELDS[kind]
        if name in form.cleaned_data and form.cleaned_data[name] != getattr(original, name)
    ]
    if not changed:
        return False
    return TaskTargetRun.objects.filter(
        target_type=_TARGET_TYPES[kind], target_id=str(asset.pk),
        task__status__in=TaskRun.ACTIVE_STATUSES,
    ).exists()

@admin_required
def asset_edit(request, kind, pk):
    if kind not in DEVICE_KINDS:
        raise Http404('该项目不支持手动修改设备。')
    from .views import _asset_page, asset_list
    asset = get_object_or_404(_asset_page(kind).model, pk=pk)
    if request.method != 'POST':
        return asset_list(request, kind, edit_device=asset)
    form = device_form(kind, request.POST, instance=asset)
    if form.is_valid():
        try:
            with transaction.atomic():
                preserve_empty_secrets(form)
                if _stale_revision(asset, request.POST.get('form_revision')):
                    # 两个人同时改同一台设备时，后保存的那次会把前者整体覆盖，
                    # 还会把巡检刚刷新的 os_version 改回旧值。
                    form.add_error(None, '这台设备在你编辑期间被其他人保存过，请刷新后重新编辑。')
                elif _connection_changes_during_active_task(kind, form, asset):
                    form.add_error(None, '该设备存在活动巡检任务，任务结束后才能修改连接配置。')
                else:
                    form.save()
        except IntegrityError as exc:
            form.add_error(None, _integrity_message(exc))
        else:
            if not form.errors:
                message = '设备配置已更新；硬件与系统信息仍由巡检自动采集。'
                if wants_json(request):
                    return form_saved(message, reverse('asset_edit', args=[kind, asset.pk]))
                messages.success(request, message)
                return redirect('asset_edit', kind=kind, pk=asset.pk)
    if wants_json(request):
        return form_errors(_form_messages(form), reverse('asset_edit', args=[kind, asset.pk]))
    return asset_list(request, kind, creation_form=form, edit_device=asset)


def _form_messages(form):
    """Flatten Django's field->errors mapping into sentences a person reads."""
    return [
        '%s：%s' % (form.fields[name].label if name in form.fields else '配置', ' '.join(errors))
        for name, errors in form.errors.items()
    ]