from django.contrib.auth.decorators import login_required
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST

from assets.views import _asset_list_context, asset_detail_json
from weakcurrent.forms import AccessRecordSourceForm
from index.common.access import admin_required, is_admin
from index.common.form_json import form_errors, form_saved, wants_json
from index.common.table_payload import row_payloads, table_payload
from index.common.table_query import PAGE_SIZES, apply_table_filters, query_without_page
from index.common.table_registry import get_table_definition
from net.access.adapters import V6600_V6000_COMPAT_VERSION, build_adapter
from net.access.tasks import enqueue_access_sync
from net.models.access import AccessRecord, AccessRecordSource
from net.models.alerts import AlertChannel
from weakcurrent.payloads import weakcurrent_bootstrap


@require_GET
@login_required
def access_report_api(request):
    """门禁通行报表的 JSON 出口，给外部系统取数，也给配置弹窗做预览。"""
    from weakcurrent.report import build_report

    days = request.GET.get('days')
    try:
        days = max(1, min(90, int(days))) if days else 7
    except (TypeError, ValueError):
        days = 7
    return JsonResponse(build_report(days))


@require_POST
@admin_required
def access_report_config(request):
    """保存定期发送报表的配置。渠道复用告警渠道，不再单独维护推送。"""
    from net.models.access import AccessReportConfig

    config = AccessReportConfig.load()
    config.is_enabled = request.POST.get('is_enabled') == 'on'
    try:
        config.interval_hours = max(1, int(request.POST.get('interval_hours') or 24))
    except (TypeError, ValueError):
        config.interval_hours = 24
    try:
        config.range_days = max(1, min(90, int(request.POST.get('range_days') or 7)))
    except (TypeError, ValueError):
        config.range_days = 7
    channel_id = (request.POST.get('channel') or '').strip()
    config.channel_id = channel_id or None
    config.save()
    messages.success(request, '报表配置已保存。')
    return redirect('access_record_list')


@require_GET
def access_record_list(request):
    definition = get_table_definition('access_records')
    records, table_state = apply_table_filters(
        request, AccessRecord.objects.select_related('source', 'source__weak_current_device'), definition,
        include_legacy_status=False,
    )
    page_obj = Paginator(records, table_state['page_size']).get_page(request.GET.get('page'))
    return render(request, 'access/record_list.html', {
        'page_obj': page_obj,
        'records_bootstrap': table_payload(
            page_obj, definition, row_payloads(page_obj.object_list, definition),
            extra={
                'endpoint': '/api/v1/access-records/', 'label': '门禁记录',
                'show_actions': False, 'region_label': '门禁记录数据表',
            },
        ),
        'table_definition': definition, 'table_preference_key': 'access_records',
        'table_state': table_state, 'page_sizes': PAGE_SIZES,
        'pagination_query': query_without_page(request),
        'access_sources': AccessRecordSource.objects.filter(is_enabled=True).order_by('name'),
        'form': AccessRecordSourceForm() if is_admin(request.user) else None,
        'sources': AccessRecordSource.objects.order_by('name') if is_admin(request.user) else [],
        'compatibility_version': V6600_V6000_COMPAT_VERSION,
    })


@admin_required
def access_source_settings(request):
    source = get_object_or_404(AccessRecordSource, pk=request.GET.get('source')) if request.GET.get('source') else None
    return render(request, 'access/source_settings.html', {
        'form': AccessRecordSourceForm(instance=source), 'source': source,
        'source_saved': request.GET.get('saved') == '1',
        'sources': AccessRecordSource.objects.order_by('name'),
        'compatibility_version': V6600_V6000_COMPAT_VERSION,
    })


def _source_form_response(request, source, form, status=400):
    if wants_json(request):
        return form_errors([
            '%s：%s' % (form.fields[name].label if name in form.fields else '配置',
                       ' '.join(str(message) for message in messages))
            for name, messages in form.errors.items()
        ], reverse('access_source_settings'))
    return render(request, 'access/source_settings.html', {
        'form': form, 'source': source, 'sources': AccessRecordSource.objects.order_by('name'),
        'compatibility_version': V6600_V6000_COMPAT_VERSION,
    }, status=status)


@admin_required
@require_POST
def access_source_save(request):
    source = get_object_or_404(AccessRecordSource, pk=request.POST.get('source_id')) if request.POST.get('source_id') else None
    form = AccessRecordSourceForm(request.POST, instance=source)
    if not form.is_valid():
        return _source_form_response(request, source, form)
    saved = form.save()
    message = f'已保存门禁平台来源“{saved.name}”。'
    if wants_json(request):
        return form_saved(message, f"{reverse('access_source_settings')}?source={saved.pk}&saved=1")
    messages.success(request, message)
    return redirect(f"{reverse('access_source_settings')}?source={saved.pk}&saved=1")


@admin_required
@require_POST
def access_source_test(request):
    source = get_object_or_404(AccessRecordSource, pk=request.POST.get('source_id')) if request.POST.get('source_id') else None
    # Save the submitted values first: testing cannot discard an edited URL,
    # endpoint, authentication method, or replacement token.
    form = AccessRecordSourceForm(request.POST, instance=source)
    if not form.is_valid():
        return _source_form_response(request, source, form)
    source = form.save()
    try:
        # Adapter probes exactly one page and never writes records/cursor.
        build_adapter(source).test_connection()
    except (ValidationError, ValueError) as exc:
        messages.error(request, f'连接测试失败：{exc}')
    except Exception as exc:
        messages.error(request, f'连接测试失败（{type(exc).__name__}）。')
    else:
        messages.success(request, '连接测试成功，平台事件接口可访问。')
    return redirect(f"{reverse('access_source_settings')}?source={source.pk}&saved=1")


@admin_required
@require_POST
def access_record_sync(request):
    try:
        tasks = enqueue_access_sync(request.POST.getlist('source_ids'))
    except ValidationError as exc:
        messages.error(request, '；'.join(exc.messages))
    else:
        messages.success(request, f'已创建 {len(tasks)} 个门禁记录采集任务。')
    return redirect('access_record_list')

# ---- 工作区页（台账 / 巡检记录 / 门禁记录 三页签，整页由 Vue 渲染）----

def weakcurrent_workspace(request, **route_kwargs):
    """路径与旧资产列表一致（assets/weakcurrent/），既有门禁路由不受影响。"""
    # 三个方块各取各的：切块只回那一块，不重算整页，地址栏不动。
    pane = request.GET.get('pane')
    if pane in ('logs', 'access'):
        payload = weakcurrent_bootstrap(request, only={pane})
        # 任务栏连同它的统计一起回去：切任务时前端要拿新的那排数字。
        payload['taskbar'] = weakcurrent_bootstrap(request, only={'assets'}).get('taskbar')
        return JsonResponse(payload)
    # 弹窗所需的表单、权限、配置开关都在 _asset_list_context 里，不重新拼。
    context = _asset_list_context(request, 'weakcurrent')
    # 记录表的排序、筛选、翻页只要数据，地址栏保持不动。
    # 按任务取台账：只回表格那一块，地址栏不动。
    if request.GET.get('fragment') == 'table':
        return JsonResponse(weakcurrent_bootstrap(request, only={'assets'})['table'])
    # 门禁报表配置弹窗要用：当前配置、可选渠道、上次发送时间。
    from net.models.access import AccessReportConfig

    context['report_config'] = AccessReportConfig.load()
    context['report_channels'] = AlertChannel.objects.all().order_by('name')
    deep = {'records': 'logs', 'logs': 'logs', 'access': 'access'}.get(request.GET.get('object', ''))
    context['weakcurrent_bootstrap'] = weakcurrent_bootstrap(
        request, only={'assets', deep} if deep else {'assets'},
    )
    return render(request, 'weakcurrent/weakcurrent.html', context)


def weakcurrent_detail_json(request, pk, **route_kwargs):
    return asset_detail_json(request, 'weakcurrent', pk)

