import logging
from dataclasses import dataclass
from io import StringIO

from django.conf import settings
from django.contrib import messages
from index.common.access import is_admin
from django.core.management import call_command
from django.core.paginator import Paginator
from django.db.models import Count, Q
from django.core.exceptions import PermissionDenied
from django.http import Http404, JsonResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST

from assets.overview import department_totals, device_overview, people_overview
from assets.payloads import asset_detail_payload, asset_row_actions, configuration_notice
from index.common.table_payload import row_payloads as table_row_payloads
from index.common.table_payload import table_payload
from index.common.table_query import PAGE_SIZES, apply_table_filters, query_without_page
from index.common.table_registry import get_table_definition
from index.templatetags.extras import format_table_field
from net.models import Computer, Network_Device, People, WeakCurrentDevice, Server
from net.data_exchange.inventory_csv import IMPORTABLE_ENTITIES, inventory_import_guide
from alerts.views import alert_modal_context
from inspections.tasks import task_modal_context


@dataclass(frozen=True)
class AssetPage:
    model: type
    table_key: str
    title: str
    inspection_kind: str = ''
    collection_hint: str = ''


ASSET_PAGES = {
    'people': AssetPage(People, 'people', '人员·部门'),
    'computers': AssetPage(Computer, 'computers', 'PC'),
    'networks': AssetPage(
        Network_Device,
        'networks',
        '网络设备',
        'networks',
        '默认通过 SNMP + SSH 采集；深信服 AC 使用开放 API。请按导入窗口的字段示例填写。',
    ),
    'servers': AssetPage(
        Server,
        'servers',
        '服务器',
        'servers',
        'Linux 服务器通过 SSH 采集；Windows 服务器访问专用 HTTP JSON 服务。',
    ),
    'weakcurrent': AssetPage(
        WeakCurrentDevice,
        'weakcurrent',
        '弱电设备',
        'weakcurrent',
        '通过设备自带 API 采集；海康和大华设备支持 Digest 认证。',
    ),
}


def _asset_page(kind):
    try:
        return ASSET_PAGES[kind]
    except KeyError as exc:
        raise Http404('未知的资产类型') from exc


def _display_value(obj, field):
    value = obj
    for name in field.source.split('__'):
        value = getattr(value, name, None)
        if value is None:
            break
    display_method = getattr(obj, f'get_{field.source}_display', None)
    if callable(display_method):
        value = display_method()
    return value


def _history_url(kind, asset):
    # 记录视图现在挂在资产页的 object 参数下，target 必须用 & 接。
    from urllib.parse import urlencode

    view = {'computers': 'analyses'}.get(kind)
    if view is None and kind in {'networks', 'servers', 'weakcurrent'}:
        view = 'records'
    if view is None:
        return ''
    query = urlencode({'object': view, 'target': asset.pk})
    return f"{reverse('asset_list', args=[kind])}?{query}"


def project_task_metrics(request, kind):
    """一份请求内只算一次执行统计。

    `_outcome_expression()` 要对 result_snapshot 做 JSON 解引用，全表扫一次约 200ms。
    这里分两次算：一次是全部任务的总量（方块上「任务 N 个」用的），一次只算最新
    那个任务（正常/异常口径要和右侧「最新任务统计」面板一致）。之前拿全部任务的
    目标行一起算，35 个任务累计 28210 行，既把「台」写成目标数，又让每条解引用都
    白算了一遍。
    """
    cached = getattr(request, '_project_task_metrics', None)
    if cached is None:
        from net.inspections.task_summary import (
            build_project_task_metrics, project_task_queryset,
        )

        tasks = project_task_queryset(kind)
        total = tasks.count()
        latest = tasks.first()
        # 只算最新一个任务：口径跟着统计面板走，行数从上万掉到一两百。
        # 任务总数单独 count，别为了一个数字把全部目标行再解引用一遍。
        cached = build_project_task_metrics(tasks.filter(pk=latest.pk)) if latest else {
            'task_count': 0, 'completed_count': 0, 'normal_count': 0,
            'abnormal_count': 0, 'abnormal_rate': 0.0, 'latest_task_at': None,
        }
        cached['task_count'] = total
        cached['latest'] = latest
        request._project_task_metrics = cached
    return cached


def asset_list(request, kind, **kwargs):
    context = _asset_list_context(request, kind, **kwargs)
    # 方块切换走局部刷新：只要那一个视图的片段，页面本身不动。
    # 记录表的排序、筛选、翻页只要数据，地址栏保持不动。
    if request.GET.get('fragment') == 'table' and context.get('results_table'):
        return JsonResponse(context['results_table'])
    if request.GET.get('fragment') == 'pane':
        return render(request, 'devices/_pane.html', context)
    return render(request, 'devices/list.html', context)


def _asset_list_context(request, kind, *, integration_context=None, creation_form=None,
                        edit_device=None, selected_id=None):
    """列表页的完整 context。工作区与旧渲染共用它，两边字段不会分叉。"""
    page = _asset_page(kind)
    table_definition = get_table_definition(page.table_key)
    objects, table_state = apply_table_filters(
        request,
        page.model.objects.all(),
        table_definition,
        include_legacy_status=False,
    )
    page_obj = Paginator(objects, table_state['page_size']).get_page(
        request.GET.get('page'),
    )
    context = {
        'inventory_import_guide': inventory_import_guide(kind) if is_admin(request.user) else [],
        'item_key': kind,
        'item_name': page.title,
        'table_definition': table_definition,
        'page_obj': page_obj,
        'table_state': table_state,
        'page_sizes': PAGE_SIZES,
        'table_export_path': reverse('table_export', args=[page.table_key]),
        'configuration_selection_path': (
            reverse('configuration_zip', args=[kind])
            if is_admin(request.user) and kind in {'networks', 'weakcurrent'} else ''
        ),
        'pagination_query': query_without_page(request),
        'collection_hint': page.collection_hint,
        'import_enabled': is_admin(request.user) and kind in IMPORTABLE_ENTITIES,
        'personnel_api_import': is_admin(request.user) and kind == 'people',
        'data_source_note': (
            'PC 资料由终端采集器通过 API 上报日志后自动建立，无需导入设备清单。'
            if kind == 'computers' else ''
        ),
        'open_import_modal': (
            request.session.pop('open_import_modal', None) == kind
        ),
    }
    # 首屏行由服务端算好塞进 bootstrap：Vue 挂载后不用再跑一次同样的查询，
    # 也避免「先空表后刷出数据」的闪烁。
    admin = is_admin(request.user)
    context['workspace_rows'] = table_row_payloads(
        page_obj.object_list, table_definition,
        actions=asset_row_actions(kind, admin),
        row_id=lambda obj: obj.pk,
    )
    from .forms import DEVICE_KINDS, device_form, device_form_sections
    from index.common.workspace_actions import workspace_action_context
    context.update(workspace_action_context(kind))
    # Batch maintenance windows live on the list page: select rows, then one window
    # covers every selected asset of this kind.
    context['maintenance_enabled'] = is_admin(request.user) and kind in {
        'networks', 'servers', 'weakcurrent',
    }
    if context['maintenance_enabled']:
        from .maintenance import form_defaults
        context['maintenance_default'] = form_defaults()
    if kind in DEVICE_KINDS and is_admin(request.user):
        form = creation_form if creation_form is not None else device_form(kind, instance=edit_device)
        context.update(device_form=form, device_form_sections=device_form_sections(form),
                       open_add_device_modal=creation_form is not None and edit_device is None,
                       open_edit_device_modal=edit_device is not None,
                       edit_device=edit_device,
                       device_modal_mode='edit' if edit_device is not None else 'add')
    if kind == 'people' and is_admin(request.user):
        from people.integrations import people_modal_context
        modal_context = integration_context if integration_context is not None else people_modal_context(request)
        modal_context['open_import_modal'] = modal_context.get('open_import_modal') or context['open_import_modal']
        context.update(modal_context)
    if kind in {'computers', 'networks', 'servers', 'weakcurrent'}:
        context.update(task_modal_context(
            request, kind, allow_target_selection=kind in {'networks', 'servers', 'weakcurrent'},
        ))
        context.update(alert_modal_context(
            request, profile=context['task_default_profile'],
        ))
    # selectable 要等 task_modal_context 填过 task_allow_target_selection 才能算。
    selectable = bool(admin and context.get('task_allow_target_selection'))
    # PC 三个视图都在同一页的 tab 里，object 参数决定默认打开哪一个。
    _requested = request.GET.get('object', '')
    context['pc_tab'] = (
        {'logs': 'logs', 'analyses': 'analyses'}.get(_requested, 'assets')
        if kind == 'computers' else ''
    )
    if kind == 'computers':
        from inspections.records import computer_workspace_payloads

        context.update(computer_workspace_payloads(request))
        # 顶部大方块的执行统计跟分析记录 tab 共用一份，默认页也要有。
        context['task_metrics'] = project_task_metrics(request, 'computers')
        # 分析记录 tab 的内容在默认页也要渲染正确，不能因为没切过去就换成巡检结果表。
        context.setdefault('record_type', 'computer_analysis')
    elif kind != 'people':
        from inspections.records import access_records_payload, project_records_payload
        context.update(project_records_payload(kind, request))
        if kind == 'weakcurrent':
            context.update(access_records_payload(request))
    context['view'] = request.GET.get('object', 'rows')
    if kind == 'people':
        context['departments'] = department_totals()
        # 首页"手动同步人员"直接落到这里，把导入弹窗打开到人员同步。
        if request.GET.get('sync_modal'):
            context['open_import_modal'] = True
    # PC 的分析记录在自己的 tab 里，但它和独立记录页要同一份上下文，
    # 否则 tab 里渲染的是设备巡检那套标题和结果表。
    if kind == 'computers' and context['view'] == 'analyses':
        from inspections.records import computer_analysis_context

        context.update(computer_analysis_context(request))
        context['pc_tab'] = 'analyses'
    # 巡检记录并进资产页：和 /records/<kind>/ 用同一份上下文，不再维护两套。
    if context['view'] in ('records', 'analyses') and kind != 'computers':
        from inspections.records import computer_analysis_context, record_list_context

        shared = (computer_analysis_context(request) if context['view'] == 'analyses'
                  else record_list_context(request, kind))
        context.update(shared)
        context['view'] = request.GET.get('object')
    context['overview'] = (
        people_overview() if kind == 'people' else device_overview(kind, page.model)
    )
    context['workspace_table'] = table_payload(
        page_obj, table_definition, context.pop('workspace_rows'),
        extra={
            'endpoint': reverse('asset-row-list', args=[kind]),
            'detailBase': reverse('asset_list', args=[kind]),
            'initialDetail': context.pop('workspace_initial_detail', None),
            'label': page.title,
            'regionLabel': page.title + '数据表',
            'emptyTitle': '暂无 PC 数据' if kind == 'computers' else '暂无资产数据',
            'emptyMessage': EMPTY_MESSAGES.get(kind, '可点击右上角导入添加资产。'),
            # 每张表都能勾选（含 PC / 人员）：全选、反选、导出所选是通用能力，
            # 只有「把这些目标提交成任务」才依赖 selectable。
            'selectAttr': 'data-device-selection-target',
            'formId': 'manualTaskForm' if selectable else '',
            'csrf': get_token(request),
            'selectedId': (selected_id if selected_id is not None
                           else request.GET.get('selected', '')),
            'departments': context.get('departments') or [],
        },
    )
    return context


SWITCHABLE_KINDS = frozenset({'networks', 'servers', 'weakcurrent'})


def workspace_enabled(kind):
    """NET_ENTITY_WORKSPACE=all 或逗号分隔的 kind 列表；空串回退到旧详情页。"""
    configured = getattr(settings, 'ENTITY_WORKSPACE_KINDS', frozenset())
    return 'all' in configured or kind in configured

EMPTY_MESSAGES = {
    'computers': '请运行 PowerShell PC 信息采集脚本并上报。',
    'people': '可点击右上角“导入人员”添加人员。',
}


@require_POST
def asset_toggle_enabled(request, kind):
    """Switch a device on or off; switching off keeps it out of inspection."""
    page = _asset_page(kind)
    if kind not in SWITCHABLE_KINDS:
        raise Http404('该资产类型不支持停用')
    if not is_admin(request.user):
        raise PermissionDenied('只有管理员可以停用设备')
    asset = get_object_or_404(page.model, pk=request.POST.get('pk'))
    asset.is_enabled = not asset.is_enabled
    asset.save(update_fields=['is_enabled'])
    messages.success(request, ('%s 已启用' if asset.is_enabled else '%s 已停用') % asset)
    return redirect(query_without_page(request) and
                    '%s?%s' % (reverse('asset_list', args=[kind]), query_without_page(request))
                    or reverse('asset_list', args=[kind]))


def _asset_detail_context(request, kind, pk):
    page = _asset_page(kind)
    asset = get_object_or_404(page.model, pk=pk)
    table_definition = get_table_definition(page.table_key)
    detail_fields = [
        {
            'label': field.label,
            'value': format_table_field(_display_value(asset, field), field),
            'kind': field.kind,
        }
        for field in table_definition.fields
    ]
    latest = None
    latest_url = ''
    if kind == 'computers':
        latest = asset.analyses.order_by('-created_at', '-pk').first()
        if latest:
            latest_url = reverse('computer_analysis_detail', args=[latest.pk])
    elif kind in ('servers', 'networks', 'weakcurrent'):
        latest = asset.inspections.order_by('-created_at', '-pk').first()
        if latest:
            latest_url = reverse('record_detail', args=[kind, latest.pk])
    back_url = reverse('asset_list', args=[kind])
    history_url = _history_url(kind, asset)
    can_administer = is_admin(request.user)
    manual_action_label = '手动执行分析' if kind == 'computers' else (
        '手动执行巡检' if page.inspection_kind else ''
    )
    detail = asset_detail_payload(
        kind=kind,
        item_name=page.title,
        asset=asset,
        detail_fields=detail_fields,
        latest_record=latest,
        latest_url=latest_url,
        history_url=history_url,
        back_url=back_url,
        manual_action_label=manual_action_label,
        can_administer=can_administer,
    )
    return {
        'asset': asset,
        'item_key': kind,
        'item_name': page.title,
        'back_url': back_url,
        'history_url': history_url,
        'detail': detail,
        'notice': configuration_notice(kind) if can_administer else '',
    }


def asset_detail(request, kind, pk):
    """深链直接落在工作区里，选中项就是路径里的这条记录。

    这样 /assets/people/ 里点行换地址、和从收藏夹打开 /people/<pk>/，落的是同一个
    页面同一处状态——不用再为了看一条详情离开列表。
    """
    if workspace_enabled(kind):
        return entity_workspace(request, kind, selected_id=str(pk))
    return render(request, 'devices/detail.html', _asset_detail_context(request, kind, pk))


def entity_workspace(request, kind, selected_id='', **kwargs):
    """列表 + 详情同屏渲染。旧 view 名与 URL 不变，只是换了模板。"""
    context = _asset_list_context(request, kind, selected_id=selected_id, **kwargs)
    if selected_id:
        detail = _asset_detail_context(request, kind, selected_id)
        context['workspace_table']['initialDetail'] = {
            **detail['detail'], 'notice': detail['notice'],
        }
    return render(request, 'devices/list.html', context)


def asset_detail_json(request, kind, pk):
    """右侧面板换行时取的那份 payload，与整页详情共用同一个构造器。

    权限不在视图里另写一套：AccessMiddleware 已按 url_name 判定过，这里再判一次
    只会让两处规则慢慢漂开。
    """
    context = _asset_detail_context(request, kind, pk)
    return JsonResponse({**context["detail"], "notice": context["notice"]})


def person_detail(request, pk):
    return asset_detail(request, 'people', pk)


def people_statistics(request):
    as_of = timezone.localdate()
    counts = People.objects.aggregate(
        total=Count('pk'),
        active=Count('pk', filter=Q(is_active=True)),
        departed=Count('pk', filter=Q(is_active=False)),
        hires_this_year=Count(
            'pk', filter=Q(hire_date__year=as_of.year, hire_date__lte=as_of),
        ),
        departures_this_year=Count(
            'pk',
            filter=Q(
                is_active=False,
                departure_date__year=as_of.year,
                departure_date__lte=as_of,
            ),
        ),
    )
    valid_hire_dates = list(People.objects.filter(
        is_active=True,
        hire_date__isnull=False,
        hire_date__lte=as_of,
    ).values_list('hire_date', flat=True))
    average_tenure = (
        round(
            sum((as_of - hire_date).days for hire_date in valid_hire_dates)
            / len(valid_hire_dates)
            / 365.25,
            1,
        )
        if valid_hire_dates else 0.0
    )
    metrics = {
        **counts,
        'active_rate': (
            round(counts['active'] * 100 / counts['total'], 1)
            if counts['total'] else 0.0
        ),
        'average_active_tenure_years': average_tenure,
        'tenure_sample_count': len(valid_hire_dates),
    }

    department_totals = {}
    grouped_departments = People.objects.values('department').annotate(
        total=Count('pk'),
        active=Count('pk', filter=Q(is_active=True)),
    )
    for group in grouped_departments:
        department = (group['department'] or '').strip() or '未分配部门'
        row = department_totals.setdefault(
            department, {'department': department, 'total': 0, 'active': 0},
        )
        row['total'] += group['total']
        row['active'] += group['active']
    departments = []
    for row in department_totals.values():
        row['departed'] = row['total'] - row['active']
        row['active_rate'] = round(row['active'] * 100 / row['total'], 1)
        departments.append(row)
    departments.sort(key=lambda row: (-row['total'], row['department']))

    from people.payloads import statistics_bootstrap

    return render(request, 'people/statistics.html', {
        'as_of': as_of,
        'metrics': metrics,
        'departments': departments,
        'statistics_bootstrap': statistics_bootstrap(
            metrics=metrics, departments=departments, as_of=as_of,
        ),
    })


def item_list(request, item):
    if item == 'accounts':
        return redirect('domain_controller_settings')
    return asset_list(request, item)


@require_POST
def run_infrastructure_inspection(request):
    asset_type = request.POST.get('asset_type', 'all')
    if asset_type not in {'all', 'networks', 'servers', 'weakcurrent'}:
        raise Http404('未知的巡检类型')
    asset_id = request.POST.get('asset_id') or None
    output = StringIO()
    try:
        call_command(
            'run_network_checks',
            asset_type=asset_type,
            asset_id=asset_id,
            timeout=1500,
            stdout=output,
        )
        messages.success(request, output.getvalue().strip() or '巡检完成。')
    except Exception:
        # Command output above is the operator's result summary, but a raw exception
        # can carry SQL fragments, absolute paths and internal hostnames.
        logging.getLogger(__name__).exception(
            '巡检命令失败 asset_type=%s asset_id=%s', asset_type, asset_id)
        messages.error(request, '巡检失败，请查看服务端日志。')

    if asset_type == 'all':
        return redirect('index')
    return redirect('asset_list', kind=asset_type)
