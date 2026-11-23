"""Latest PC task statistics from persisted report projections, not log JSON."""
from django.db.models import CharField, Count, Q, Value
from django.db.models.functions import Coalesce, NullIf
from django.contrib.auth.decorators import login_required
from django.core.paginator import Paginator
from django.http import Http404
from urllib.parse import quote

from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_GET

from net.inspections.issues import PROJECT_RULES
from net.models import ComputerAnalysis
from .result_query import computer_queryset


def _task_scope(task, records):
    if task.profile_snapshot.get('matching_mode') != 'people':
        return records, []
    from .people_result_query import PeopleResultRows
    joined = PeopleResultRows.from_roster(records, task.parameters_snapshot.get('personnel_roster', []))
    missing = joined.placeholders if task.status in {'success', 'partial', 'failed'} else []
    return joined.queryset, missing


def _problem_rows_csv(category, rows):
    """问题明细导出：和表格同源，不另算一遍。"""
    import csv

    from django.http import HttpResponse

    response = HttpResponse(content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = (
        'attachment; filename="problems-%s.csv"' % category.replace('"', '')
    )
    response.write('\ufeff')
    writer = csv.writer(response)
    writer.writerow(['对象', '人员名称', '具体问题', '等级', '关键指标'])
    for row in rows:
        writer.writerow([
            row.get('asset', ''), row.get('user', ''), row.get('issue', ''),
            row.get('severity', ''), row.get('metrics', ''),
        ])
    return response


def _problem_definition():
    """问题明细的列定义：问题行是 dict，排序/筛选用它自己的 query_source。"""
    from index.common.table_registry import get_table_definition

    return get_table_definition('analysis_problems')


def _problem_rows_response(request, task, category, page_obj, rows, definition, state,
                           route='analysis_problem_list'):
    """问题明细统一走 table_payload，弹窗里复用工作区那套表格能力。"""
    from django.http import JsonResponse
    from django.urls import reverse

    from index.common.table_payload import (
        attach_column_options, row_payloads, table_payload,
    )

    if request.GET.get('format') == 'csv':
        return _problem_rows_csv(category, rows)

    payload = attach_column_options(table_payload(
        page_obj, definition,
        row_payloads(rows, definition),
        extra={
            # 翻页/排序/筛选都回到同一个弹窗地址，只换 JSON。
            'endpoint': reverse(route, args=[task.pk]) + '?category=' + quote(category),
            'exportUrl': (
                reverse(route, args=[task.pk])
                + '?category=' + category + '&format=csv'
            ),
            'tableKey': 'analysis-problems',
            'label': '问题明细',
            'regionLabel': '问题明细数据表',
            'emptyTitle': '该任务暂无此类问题',
            'pageSizes': [20, 50, 100],
            'filters': state['filters'],
            'sort': state['sort'],
            'order': state['order'],
            'shownFilters': {
                field.key: bool(field.default_filter) or field.key in state['filters']
                for field in definition.fields if field.filterable
            },
        },
    ), definition, state)
    if 'application/json' in request.headers.get('Accept', ''):
        # 岛内翻页/排序/筛选：同一个地址，只换 JSON，不整页刷新。
        return JsonResponse({**payload, 'results': payload['rows']})
    return render(request, 'inspections/analysis_problem_rows.html', {
        'task': task, 'category': category, 'page_obj': page_obj,
        'problems_bootstrap': payload,
    })


@login_required
@require_GET
def analysis_problem_list(request, pk):
    from net.models import TaskRun
    from net.devices.pc.severity import grade_issue

    from index.common.table_query import apply_table_filters

    task = get_object_or_404(TaskRun, pk=pk, task_type=TaskRun.TaskType.COMPUTER_ANALYSIS)
    category = request.GET.get('category', '').strip()
    if not category or len(category) > 100 or '、' in category:
        raise Http404('未知的问题类型')
    definition = _problem_definition()
    records, missing = _task_scope(task, ComputerAnalysis.objects.filter(task_target__task_id=task.pk))
    if category == '人员缺少日志':
        rows = [
            {
                # record 语义的 category 过滤按每行的 category 值走，缺了就全被筛掉。
                'category': category,
                'asset': '%s · %s' % (
                    row.report_enrichment.get('personnel_name', ''),
                    row.report_enrichment.get('employee_number', ''),
                ),
                'user': row.summary or '',
                'issue': '人员未匹配日志',
                'severity': '警告',
                'metrics': '—',
            }
            for row in missing
        ]
        rows, state = apply_table_filters(request, rows, definition, include_legacy_status=False)
        page_obj = Paginator(rows, state['page_size']).get_page(request.GET.get('page'))
        return _problem_rows_response(
            request, task, category, page_obj, page_obj.object_list, definition, state,
        )
    records = records.filter(
        Q(report_problem_types=category)
        | Q(report_problem_types__startswith=category + '、')
        | Q(report_problem_types__endswith='、' + category)
        | Q(report_problem_types__contains='、' + category + '、')
    ).annotate(
        # severity 列的筛选与排序落在这一列上，和列表页的等级口径一致。
        _report_level=Coalesce(
            NullIf('report_severity', Value('')), Value('normal'),
            output_field=CharField(),
        ),
    ).select_related('computer').only(
        'pk', 'computer_id', 'computer__computer_name', 'computer__user_name',
        'exceptions', 'report_metrics',
    )
    # 排序/筛选交给表格查询层：参数是 sort/order/filter_*，和别的表一套语义。
    # 它替换掉原来写死的 order_by，并且分页在 SQL 层，只把当页的 exceptions 读出来。
    records, state = apply_table_filters(request, records, definition, include_legacy_status=False)
    page_obj = Paginator(records, state['page_size']).get_page(request.GET.get('page'))
    rows = []
    for record in page_obj:
        findings = []
        for raw in record.exceptions if isinstance(record.exceptions, list) else []:
            if not isinstance(raw, dict):
                continue
            issue = grade_issue(raw)
            if issue['category'] == category:
                findings.append({
                    'title': issue.get('问题类型') or '未命名问题',
                    'description': issue.get('详细问题') or '',
                    'severity': issue['severity'], 'severity_label': issue['severity_label'],
                })
        rows.append({
            'asset': record.computer.computer_name if record.computer_id else '—',
            'user': (record.computer.user_name if record.computer_id else '') or '—',
            'issue': ' / '.join('%s：%s' % (f['title'], f['description']) for f in findings),
            'severity': findings[0]['severity_label'] if findings else '提示',
            'metrics': (
                record.report_metrics
                if record.report_metrics and record.report_metrics != '无可用指标'
                else '—'
            ),
        })
    return _problem_rows_response(
        request, task, category, page_obj, rows, definition, state,
    )


def latest_analysis_statistics(task):
    levels = dict.fromkeys(('normal', 'info', 'warning', 'critical'), 0)
    categories = dict.fromkeys((category for category, _ in PROJECT_RULES['computers'].values()), 0)
    total = failed = 0
    if task is not None:
        records, missing = _task_scope(task, computer_queryset().filter(task_target__task_id=task.pk))
        counts = records.aggregate(total=Count('pk'), **{
            level: Count('pk', filter=Q(_report_level=level)) for level in levels
        })
        total = counts.pop('total')
        levels.update(counts)
        total += len(missing)
        levels['warning'] += len(missing)
        if missing:
            categories['人员缺少日志'] = len(missing)
        failed = task.target_runs.filter(status='failed').count()
        groups = records.order_by().values(
            'report_problem_types',
        ).annotate(count=Count('pk'))
        for group in groups:
            for category in set(filter(None, group['report_problem_types'].split('、'))):
                categories[category] = categories.get(category, 0) + group['count']
    return {
        'total': total, 'levels': levels, 'execution_failed': failed,
        'categories': [
            {'label': label, 'count': count, 'percentage': round(count * 100 / total, 1) if total else 0}
            for label, count in categories.items()
        ],
    }


# 设备巡检的细项太多（网络设备 24 项），面板按大类归并。
# PROJECT_RULES 只登记细项名，分组只在这里维护，避免牵动记录表列和问题明细。
INSPECTION_CATEGORY_GROUPS = {
    'networks': {
        '硬件': ('CPU', '内存', '温度', '磁盘使用率'),
        '网络': ('带宽使用率', '实时吞吐量', '实时接口流量', '接口状态', 'VLAN',
                 'IPv4 路由表', 'ARP 地址表', 'MAC 地址表', '拓扑发现（LLDP/CDP）',
                 '无线 AP 状态', '无线客户端'),
        '系统': ('在线用户数', '会话数', '系统时间', '设备日志'),
        '配置': ('内置库', '行为日志统计', '设备配置'),
        '设备信息': ('设备信息',),
        '采集': ('采集连接',),
    },
    'servers': {
        '硬件': ('CPU', '内存', '磁盘存储'),
        '网络': ('网络',),
        '系统': ('服务', '系统日志', '操作系统', '设备名称'),
        '采集': ('采集连接',),
    },
    'weakcurrent': {
        '设备': ('设备信息', '设备运行状态'),
        '通道': ('视频通道/门禁闸机通道',),
        '存储': ('录像/存储',),
        '配置': ('设备配置',),
        '采集': ('采集连接',),
    },
}


def inspection_task_statistics(kind, task):
    """设备巡检的「最新任务统计」，与 `latest_analysis_statistics` 同一套口径。

    设备记录上同样有 report_severity / report_problem_types，检查项名称来自
    PROJECT_RULES[kind]，所以 PC 那份面板的结构可以整段复用，只换数据源。
    """
    levels = dict.fromkeys(('normal', 'info', 'warning', 'critical'), 0)
    # 细项按大类归并后再出面板。
    category_groups = {
        item: group
        for group, items in INSPECTION_CATEGORY_GROUPS[kind].items()
        for item in items
    }
    categories = dict.fromkeys(INSPECTION_CATEGORY_GROUPS[kind], 0)
    total = failed = 0
    if task is not None:
        from .records import _record_page
        from .result_query import infrastructure_queryset

        source = infrastructure_queryset(kind, _record_page(kind)).filter(
            task_target__task_id=task.pk,
        )
        counts = source.aggregate(total=Count('pk'), **{
            level: Count('pk', filter=Q(_report_level=level)) for level in levels
        })
        total = counts.pop('total')
        levels.update(counts)
        failed = task.target_runs.filter(status='failed').count()
        rows_grouped = source.order_by().values('report_problem_types').annotate(
            count=Count('pk'),
        )
        for row in rows_grouped:
            for item in set(filter(None, (row['report_problem_types'] or '').split('、'))):
                label = category_groups.get(item, '其他')
                categories[label] = categories.get(label, 0) + row['count']
    return {
        'total': total,
        'levels': levels,
        'execution_failed': failed,
        'categories': [
            {'label': label, 'count': count,
             'percentage': round(count * 100 / total, 1) if total else 0}
            for label, count in categories.items()
        ],
    }


def _kind_of_task(task):
    """任务属于哪个工作区；设备巡检看 profile 的 device_type。"""
    profile = task.inspection_profile
    if profile is None:
        return None
    for kind, device_type in (
        ('networks', 'network_device'), ('servers', 'server'), ('weakcurrent', 'monitor'),
    ):
        if profile.device_type == device_type:
            return kind
    return None


@login_required
@require_GET
def inspection_problem_list(request, pk):
    """设备巡检的问题明细，与 PC 的 `analysis_problem_list` 同一个返回结构。

    category 传的是大类（硬件/网络/系统…），记录上存细项名，
    所以先把大类翻译成一批细项再匹配。
    """
    from net.models import TaskRun

    from index.common.table_query import apply_table_filters

    task = get_object_or_404(TaskRun, pk=pk, task_type=TaskRun.TaskType.INSPECTION)
    kind = _kind_of_task(task)
    if kind is None:
        raise Http404('未知的巡检项目')
    category = request.GET.get('category', '').strip()
    if not category or len(category) > 100 or '、' in category:
        raise Http404('未知的问题类型')

    from .records import _record_page

    page = _record_page(kind)
    groups = INSPECTION_CATEGORY_GROUPS.get(kind, {})
    items = list(groups.get(category, ()))
    known = [item for values in groups.values() for item in values]
    source = page.model.objects.filter(task_target__task_id=task.pk).select_related(
        page.asset_field,
    )
    if items:
        condition = Q()
        for item in items:
            condition |= (
                Q(report_problem_types=item)
                | Q(report_problem_types__startswith=item + '、')
                | Q(report_problem_types__endswith='、' + item)
                | Q(report_problem_types__contains='、' + item + '、')
            )
        source = source.filter(condition)
    elif category == '其他':
        # 面板把未登记的检查项归到「其他」，明细这边要能看到它们。
        source = source.exclude(report_problem_types__in=known)
    else:
        source = source.none()

    definition = _problem_definition()
    asset = page.asset_field
    name_field = 'name' if kind == 'servers' else 'device_name'

    rows = []
    for record in source:
        owner = getattr(record, asset, None)
        rows.append({
            'category': category,
            'asset': '%s (%s)' % (
                getattr(owner, name_field, '') or '', getattr(owner, 'ip', '') or '',
            ),
            'user': '—',
            'issue': record.summary or '巡检正常',
            'severity': record.report_severity or 'normal',
            'metrics': record.report_metrics or '—',
        })
    rows, state = apply_table_filters(request, rows, definition, include_legacy_status=False)
    page_obj = Paginator(rows, state['page_size']).get_page(request.GET.get('page'))
    return _problem_rows_response(
        request, task, category, page_obj, page_obj.object_list, definition, state,
        route='inspection_problem_list',
    )

