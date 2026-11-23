"""人员部门工作区页。

视图不另起逻辑：弹窗 include 依赖 _asset_list_context 里那一整套上下文，
详情 payload 与其余资产页共用一个构造器。
"""
from django.shortcuts import render

from assets.views import _asset_list_context, asset_detail_json
from people.payloads import people_bootstrap


def people_workspace(request, **route_kwargs):
    # 路由带一个默认 kind='people'，为了和旧 asset_list 共用 URL 名（见 people/urls.py）。
    context = _asset_list_context(request, 'people')
    context['people_bootstrap'] = people_bootstrap(request)
    return render(request, 'people/people.html', context)


def people_detail_json(request, pk, **route_kwargs):
    return asset_detail_json(request, 'people', pk)
