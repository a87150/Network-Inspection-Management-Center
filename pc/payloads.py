"""PC 工作区页面的 bootstrap 数据。

只做拼装：统计口径来自 overview / records / task_summary / analysis_summary，
表格块来自 assets.payloads，任务栏来自 index.common.workspace。这里不另算业务。
"""
from django.middleware.csrf import get_token
from django.urls import reverse

from assets.overview import device_overview
from assets.payloads import asset_table_payload
from index.common import workspace
from index.common.access import is_admin
from index.common.table_query import PAGE_SIZES
from inspections.analysis_summary import latest_analysis_statistics
from inspections.records import computer_logs_payload, computer_workspace_payloads
from net.inspections.task_summary import (
    project_workspace_context,
)
from net.models import Computer

ASSETS_ENDPOINT = '/api/v1/asset-rows/computers/'
LOGS_ENDPOINT = '/api/v1/computer-logs/'


def _percent(part, whole):
    """方块里的整数百分比，和旧模板的 widthratio 同口径。"""
    return round(part * 100 / whole) if whole else 0


def _asset_block(overview, latest):
    inactive = overview['total'] - overview['active']
    return workspace.block(
        key='assets', title='PC 资产', badge='台账',
        metric=overview['total'], unit='台',
        lines=[
            [{'text': '活跃 '}, {'text': str(overview['active']), 'tone': 'success'},
             {'text': ' 台 · 停用 '},
             {'text': str(inactive), 'tone': 'danger' if inactive else ''}, {'text': ' 台'}],
            [{'text': '活跃率 %s%%' % overview['active_rate']}],
        ],
        entry='查看 PC 资产', latest=latest, latest_label='最新上报',
    )


def _log_block(logs, errors_total):
    computers = logs['pc_logs_computers']
    missing = logs['pc_logs_missing_people']
    return workspace.block(
        key='logs', title='日志', badge='采集',
        metric=computers, unit='台',
        lines=[
            [{'text': '采集 '}, {'text': str(computers), 'tone': 'success'},
             {'text': ' 台 · 未采集数据人员 '},
             {'text': str(missing), 'tone': 'danger' if missing else ''}, {'text': ' 个'}],
            [{'text': '异常率 %s%%' % _percent(errors_total, computers)}],
        ],
        entry='查看日志', latest=logs['pc_logs_latest'], latest_label='最新采集',
    )


def _analysis_block(metrics, computers):
    # 正常/异常用最新那一个任务的口径，和右侧统计面板对齐；
    # 全部任务的累计目标数没有「台」的含义。
    abnormal = metrics['abnormal_count']
    return workspace.block(
        key='analyses', title='分析记录', badge='快照',
        metric=computers, unit='台',
        lines=[
            [{'text': '任务 '}, {'text': str(metrics['task_count']), 'tone': 'success'},
             {'text': ' 个 · 完成 '},
             {'text': str(metrics['completed_count']), 'tone': 'success'}, {'text': ' 个'}],
            [{'text': '正常 '}, {'text': str(metrics['normal_count']), 'tone': 'success'},
             {'text': ' 台 · 异常 '},
             {'text': str(abnormal), 'tone': 'danger' if abnormal else ''}, {'text': ' 台'}],
            [{'text': '整体异常率 %s%%' % metrics['abnormal_rate']}],
        ],
        entry='查看分析记录', latest=metrics['latest_task_at'], latest_label='最新分析',
    )


def _assets_table(request, admin):
    payload = asset_table_payload(
        request, kind='computers', admin=admin,
        endpoint=ASSETS_ENDPOINT,
        detail_base=reverse('asset_list', args=['computers']),
        empty_title='暂无 PC 数据',
        empty_message='请运行 PowerShell PC 信息采集脚本并上报。',
    )
    payload.update({
        'tableKey': 'computers',
        'label': 'PC',
        'regionLabel': 'PC 数据表',
        'csrf': get_token(request),
        # 每张表都能勾选：全选、反选、导出所选是通用能力，不跟批量任务绑定。
        'selectAttr': 'data-device-selection-target',
        # exportUrl 由 asset_table_payload 按当前筛选拼好，这里不要再覆盖。
    })
    return payload


def _export_query(request, page_parameter):
    """导出的是整个结果集：照搬当前参数，只去掉页码。"""
    from index.common.table_query import query_without_page
    query = query_without_page(request, page_parameter)
    return '?' + query if query else ''


def _logs_table(request, logs):
    """日志表：computer_logs_payload 已经算好，这里只补 workspace_table 要的字段。"""
    table = dict(logs['pc_logs'])
    state = logs['pc_logs_state']
    definition = logs['pc_logs_definition']
    table.update({
        'tableKey': definition.key,
        'label': 'PC 日志',
        'regionLabel': table.pop('region_label', '') or 'PC 日志数据表',
        'urlPrefix': 'logs',
        'filters': state['filters'],
        'sort': state['sort'],
        'order': state['order'],
        'pageSizes': list(PAGE_SIZES),
        'emptyTitle': '暂无 PC 日志',
        'emptyMessage': '终端上报日志文件后在这里列出。',
        'csrf': get_token(request),
        # 日志表不走 asset_table_payload，导出地址在这里按 logs_ 前缀的当前筛选拼。
        'exportUrl': reverse('table_export', args=[definition.key])
                     + _export_query(request, 'logs_page'),
        'visibleColumns': {field.key: bool(field.default_visible) for field in definition.fields},
        'shownFilters': {field.key: bool(field.default_filter)
                         for field in definition.fields if field.filterable},
    })
    table.pop('page_param', None)
    # 日志详情的地址是 /computers/logs/<pk>/，不是资产的 <base><uuid>/detail.json，
    # 所以这里不要 detail_modal：页面把它交给共享详情弹窗处理。
    for row in table['rows']:
        for action in row.get('actions') or []:
            action.pop('detail_modal', None)
    return table


def _analyses(request):
    context = project_workspace_context(request, 'computers')
    task = context['latest_task']
    tasks = workspace.task_block(
        context['task_page'],
        section_title=context['task_section_title'],
        empty_title=context['task_empty_title'],
        # 任务能看，配置名不能：只读账号的 bootstrap 里抹掉。
        redact_profiles=not is_admin(request.user),
    )
    tasks['selected_id'] = str(context['selected_task_id'] or '')
    tasks['endpoint'] = reverse('pc_task_page')
    stats_url = reverse('pc_task_stats')
    return {
        'tasks': tasks,
        'stats': latest_analysis_statistics(task),
        'task': {
            'id': str(task.pk) if task else '',
            'created_at': workspace.stamp(task.created_at) if task else '',
            'status': task.status if task else '',
            'status_label': task.get_status_display() if task else '',
        },
        'problemUrl': reverse('analysis_problem_list', args=[task.pk]) if task else '',
        'isLatest': context['results_is_latest'],
        'statsUrl': stats_url,
    }


def pc_bootstrap(request, only=None):
    """整页 bootstrap；only 给定时只算那一块的表格数据。

    首屏只算台账和方块数字，日志表、分析记录各自在切过去时才取，
    不点就不查。
    """
    admin = is_admin(request.user)
    # only 可以是一个或多个方块：深链进来时把目标方块和台账一起算，
    # 纯切方块只算那一个。
    if isinstance(only, str):
        only = {only}
    want = only if only is not None else {'assets', 'logs', 'analyses'}
    if want == {'logs'}:
        return {'logs': _logs_table(request, computer_logs_payload(request, tables=True))}
    if want == {'analyses'}:
        return {'analyses': _analyses(request)}
    overview = device_overview('computers', Computer)
    logs = computer_logs_payload(request, tables='logs' in want)
    # 异常总数与分析覆盖台数在 records 的 PC 汇总里，和旧页面共用同一个口径。
    records = computer_workspace_payloads(request, tables='analyses' in want)
    # 与资产面板共用同一份，别为同一个数字再扫一次 JSON 快照。
    from assets.views import project_task_metrics

    metrics = project_task_metrics(request, 'computers')
    assets_table = _assets_table(request, admin)

    data = workspace.bootstrap(
        page={
            'key': 'computers', 'title': 'PC', 'heading': 'PC',
            # ?object=logs / analyses 是外部入口，深链进来直接落在那块上。
            'view': {'records': 'logs', 'logs': 'logs', 'analyses': 'analyses'}.get(
                request.GET.get('object', ''), 'assets',
            ),
        },
        blocks=[
                _asset_block(overview, logs['pc_assets_latest']),
                # 分析记录放中间，日志放右边。
                _analysis_block(metrics, records['pc_analyses_computers']),
                _log_block(logs, records['pc_errors_total']),
        ],
        table=assets_table,
        urls={
            'rows': ASSETS_ENDPOINT,
            'logs': LOGS_ENDPOINT,
            'logDetail': reverse('computer_log_list'),
        },
        csrf=get_token(request),
        assets=assets_table,
    )
    # 表格按块取：没切过去的方块不查，省掉整张表的 payload 和分页。
    if 'logs' in want:
        data['logs'] = _logs_table(request, logs)
    if 'analyses' in want:
        data['analyses'] = _analyses(request)
    return data
