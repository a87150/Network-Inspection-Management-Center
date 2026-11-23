"""服务器工作区页的 bootstrap：台账表 + 巡检记录表。

三页（网络设备 / 服务器 / 弱电设备）同构，配置各留在自己 app 里，不跨 app import。
表格本身不在这里算：台账走 assets.payloads.asset_table_payload，巡检记录走
index.common.table_payload，两处都和 REST 端点共用同一套列定义。
"""
from urllib.parse import quote

from django.core.paginator import Paginator
from django.middleware.csrf import get_token
from django.urls import reverse

from assets.overview import device_overview, record_block_lines
from assets.payloads import asset_table_payload
from index.common import workspace
from index.common.access import is_admin
from index.common.table_payload import attach_column_options, row_payloads, table_payload
from index.common.table_query import PAGE_SIZES, apply_table_filters
from index.common.table_registry import project_record_definition
from inspections.records import INSPECTION_RECORD_BADGES, _infrastructure_records
from django.core.exceptions import ValidationError
from net.models import Server, TaskRun

KIND = 'servers'
TITLE = '服务器'


def records_endpoint():
    """巡检记录的 REST 端点。

    全局记录接口没有 per-kind 路径，用 category 参数把范围钉死在本页这类设备上；
    翻页、排序、筛选参数由 workspace_table 自己拼，这里只固定 category。
    """
    return '/api/v1/inspection-records/?filter_category=' + quote(TITLE)


def _records_table(request):
    """巡检记录面板。参数前缀 logs，和台账表的参数空间分开。"""
    definition = project_record_definition(KIND)
    # 页头任务栏点了哪条，这张记录表就只看那条任务的执行记录。
    # 走 _infrastructure_records 自带的 task 参数（它按 task_target__task 过滤），
    # 不能在外面 filter(task_id=...)：那是记录行自己的字段，不是任务外键。
    task = None
    task_id = request.GET.get('task', '')
    if task_id:
        try:
            task = TaskRun.objects.filter(pk=task_id).first()
        except (ValidationError, ValueError):
            task = None
    source = _infrastructure_records(KIND, task=task)
    records, state = apply_table_filters(
        request, source, definition, prefix='logs',
    )
    page_obj = Paginator(records, state['page_size']).get_page(
        request.GET.get('logs_page'),
    )
    latest = records.first()
    payload = table_payload(
        page_obj, definition,
        row_payloads(page_obj.object_list, definition, INSPECTION_RECORD_BADGES),
        extra={
            'endpoint': records_endpoint(),
            'tableKey': KIND + '-logs',
            'label': '巡检记录',
            'regionLabel': '巡检记录数据表',
            'filters': state['filters'],
            'sort': state['sort'],
            'order': state['order'],
            'pageSizes': list(PAGE_SIZES),
            'emptyTitle': '暂无巡检记录',
            'exportUrl': reverse('table_export_scoped', args=['inspection_records', 'servers']),
            'emptyMessage': '执行一次巡检后，每次采集的结果会显示在这里。',
        },
    )
    payload['visibleColumns'] = {f.key: bool(f.default_visible) for f in definition.fields}
    payload['shownFilters'] = {
        f.key: bool(f.default_filter) or f.key in state['filters']
        for f in definition.fields if f.filterable
    }
    # choice 列要带候选值才会渲染成下拉，否则工具栏退回成文本框。
    attach_column_options(payload, definition, state)
    payload['csrf'] = get_token(request)
    return payload, (latest['time'] if latest else None)




def _taskbar_block(request):
    """页面顶部的任务栏：点一条就把台账换成那个任务的设备。"""
    from django.core.paginator import Paginator

    from index.common.workspace import task_block
    from django.utils import timezone

    from index.common.access import is_admin
    from net.inspections.task_summary import project_task_queryset, summarize_tasks

    # 只看这个工作区自己的任务：网络设备页不该出现 PC 的日志分析。
    page_obj = Paginator(project_task_queryset('servers'), 10).get_page(
        request.GET.get('task_page'),
    )
    page_obj.object_list = summarize_tasks(page_obj.object_list)

    # 任务栏下面那排统计：口径跟着选中的任务走，选中最新一条就是最新任务的数字。
    rows = page_obj.object_list
    latest_id = str(rows[0]['task'].pk) if rows else ''
    # 默认就选最新那条，不用用户先点一下。
    selected = request.GET.get('task', '') or latest_id
    # 只有选中的不是最新那条，这块统计才换口径叫「当前选择」。
    is_latest = not latest_id or str(selected) == latest_id
    focus = next((row for row in rows if str(row['task'].pk) == str(selected)), None) if selected else None
    focus = focus or (rows[0] if rows else None)
    from inspections.analysis_summary import inspection_task_statistics
    detail = inspection_task_statistics(KIND, focus['task'] if focus else None)
    # 数字用任务栏那份汇总（TaskTargetRun 口径），和上面表格的列一一对得上；
    # 问题类型只能从巡检记录来，记录没生成时就是空的。
    stats = {
        'label': '最新任务统计' if is_latest else '当前选择任务统计',
        'task_id': str(focus['task'].pk) if focus else '',
        'created_at': timezone.localtime(focus['task'].created_at).strftime('%Y-%m-%d %H:%M:%S') if focus else '',
        'status_label': focus['status_label'] if focus else '',
        # 配置名只给管理员看，任务本身只读账号也能看。
        'profile_label': (focus['profile_label'] if focus else '') if is_admin(request.user) else '',
        'total': focus['total'] if focus else 0,
        'cells': [
            {'label': '巡检总数', 'value': focus['total'], 'tone': ''},
            {'label': '正常结果', 'value': focus['normal'], 'tone': 'success'},
            {'label': '异常', 'value': focus['abnormal'], 'tone': 'danger' if focus['abnormal'] else ''},
            {'label': '待处理', 'value': focus['pending'], 'tone': ''},
            {'label': '已取消', 'value': focus['cancelled'], 'tone': ''},
            {'label': '执行失败目标', 'value': detail['execution_failed'], 'tone': 'danger' if detail['execution_failed'] else ''},
        ] if focus else [],
        'categories': detail['categories'],
        # 点长条要看的明细，和 PC 面板同一个弹窗通道。
        'problemUrl': (
            reverse('inspection_problem_list', args=[focus['task'].pk]) if focus else ''
        ),
    }
    return {
        **task_block(
            page_obj,
            section_title='巡检任务栏',
            empty_title='暂无巡检任务',
            redact_profiles=not is_admin(request.user),
        ),
        'stats': stats,
        'endpoint': reverse('dashboard_tasks'),
        'selected_id': selected,
        'refreshed_at': timezone.localtime().strftime('%Y-%m-%d %H:%M:%S'),
    }

def server_bootstrap(request, only=None):
    """only 指定只算哪几块；不给就全算。记录表最贵，首屏可以先不背它。"""
    want = set(only) if only else {'assets', 'logs'}
    admin = is_admin(request.user)
    overview = device_overview(KIND, Server)
    if 'logs' in want:
        logs, latest_record = _records_table(request)
    else:
        # 首屏不算记录表，但端点要照样给：它带着 filter_category，
        # 前端切过去时按这个地址取，筛选不会退回全站记录。
        logs, latest_record = {'count': 0, 'endpoint': records_endpoint()}, None
    assets = asset_table_payload(
        request,
        kind=KIND,
        admin=admin,
        endpoint=reverse('asset-row-list', args=[KIND]),
        detail_base=reverse('asset_list', args=[KIND]),
        empty_title='暂无服务器',
        empty_message='可通过右上角「导入设备」批量录入，或「添加设备」逐台添加。',
        task=request.GET.get('task', ''),
    )
    assets.update(tableKey=KIND, label=TITLE, regionLabel=TITLE + '数据表',
                  csrf=get_token(request))
    if admin:
        # 维护窗口批处理靠行首勾选框，提交时由 maintenance_window.js 收集。
        assets['selectAttr'] = 'data-device-selection-target'
    return workspace.bootstrap(
        page={'key': KIND, 'title': TITLE, 'heading': '台账与巡检记录', 'view': {'records': 'logs', 'logs': 'logs', 'access': 'access'}.get(request.GET.get('object') or '', 'assets')},
        blocks=[
            workspace.block(
                key='assets', title=TITLE, badge='台账',
                metric=overview['total'], unit='台',
                lines=[
                    [{'text': '启用 '},
                     {'text': str(overview['active']), 'tone': 'success'},
                     {'text': ' 台 · 停用 '},
                     {'text': str(overview['disabled']),
                      'tone': 'danger' if overview['disabled'] else ''},
                     {'text': ' 台'}],
                    [{'text': '启用率 %s%%' % overview['active_rate']}],
                    [{'text': '%s %s 种 · 型号 %s 种' % (
                        overview['variant_label'], overview['variants'],
                        overview['models'])}],
                ],
                entry='查看' + TITLE,
            ),
            workspace.block(
                key='logs', title='巡检记录', metric=logs['count'], unit='条',
                latest=latest_record, latest_label='最新巡检',
                lines=record_block_lines(KIND),
                entry='查看巡检记录',
            ),
        ],
        table=assets,
        urls={'rows': assets['endpoint'], 'logs': logs['endpoint']},
        csrf=get_token(request),
        logs=logs,
        taskbar=_taskbar_block(request),
        maintenance=admin,
    )
