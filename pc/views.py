"""PC 工作区页：整页由一份 bootstrap JSON + Vue 单组件渲染。"""
from django.http import JsonResponse
from django.shortcuts import render

from assets.views import _asset_list_context, asset_detail_json

from .payloads import pc_bootstrap


def pc_workspace(request, **route_kwargs):
    # 切方块只取那一块的表格，不重算整页。地址栏不动。
    pane = request.GET.get('pane')
    if pane in ('logs', 'analyses'):
        return JsonResponse(pc_bootstrap(request, only=pane))
    # 弹窗（采集模板 / 分析配置 / 告警策略 / 问题等级）依赖旧 context 里的表单与开关，
    # 整页只换渲染方式，不重拼这些上下文。
    context = _asset_list_context(request, 'computers')
    # 深链（?object=logs / analyses）直接把那块一起算出来，首屏就有数据。
    deep = {'records': 'logs', 'logs': 'logs', 'analyses': 'analyses'}.get(request.GET.get('object', ''))
    # 三个方块各取各的：首屏只算台账，日志和分析记录由前端并发补拉，
    # 不让一次请求把三块的 SQL 全背下来。深链才顺带把对应那块一起算。
    panes = {'assets'}
    if deep:
        panes.add(deep)
    context['pc_bootstrap'] = pc_bootstrap(request, only=panes)
    return render(request, 'pc/pc.html', context)


def pc_detail_json(request, pk, **route_kwargs):
    return asset_detail_json(request, 'computers', pk)


def pc_task_stats(request, **route_kwargs):
    """切任务只换统计：返回该任务的 stats / task / problemUrl，任务栏不动。"""
    from .payloads import _analyses

    request.GET = request.GET.copy()
    request.GET['task'] = request.GET.get('task', '')
    data = _analyses(request)
    data.pop('tasks', None)
    return JsonResponse(data)


def pc_tasks(request, **route_kwargs):
    """任务栏翻页：返回与首屏同构的 task_block，前端换行不换页。"""
    from index.common import workspace
    from index.common.access import is_admin
    from net.inspections.task_summary import project_workspace_context

    context = project_workspace_context(request, 'computers')
    block = workspace.task_block(
        context['task_page'],
        section_title=context['task_section_title'],
        empty_title=context['task_empty_title'],
        redact_profiles=not is_admin(request.user),
    )
    block['selected_id'] = str(context['selected_task_id'] or '')
    return JsonResponse(block)
