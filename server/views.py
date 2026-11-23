"""服务器工作区页：整页由 Vue 渲染，Django 只给 context 和 bootstrap。

路径与旧资产列表一致（assets/servers/），导航栏、告警、任务里的
reverse('asset_list', args=['servers']) 全部照旧可用。
"""
from django.http import JsonResponse
from django.shortcuts import render

from assets.views import _asset_list_context, asset_detail_json

from .payloads import server_bootstrap


def server_workspace(request, **route_kwargs):
    # 三个方块各取各的：切块只回那一块，不重算整页，地址栏不动。
    pane = request.GET.get('pane')
    if pane == 'logs':
        payload = server_bootstrap(request, only={pane})
        # 任务栏连同它的统计一起回去：切任务时前端要拿新的那排数字。
        payload['taskbar'] = server_bootstrap(request, only={'assets'}).get('taskbar')
        return JsonResponse(payload)
    # 弹窗所需的表单、权限、配置开关都在 _asset_list_context 里，不重新拼。
    context = _asset_list_context(request, 'servers')

    # 记录表的排序、筛选、翻页只要数据，地址栏保持不动。
    # 按任务取台账：只回表格那一块，地址栏不动。
    if request.GET.get('fragment') == 'table':
        return JsonResponse(server_bootstrap(request, only={'assets'})['table'])
    context['server_bootstrap'] = server_bootstrap(request, only={'assets'})
    return render(request, 'server/server.html', context)


def server_detail_json(request, pk, **route_kwargs):
    return asset_detail_json(request, 'servers', pk)
