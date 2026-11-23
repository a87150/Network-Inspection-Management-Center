"""服务器 工作区页路由。

路径与 URL 名都沿用旧的 asset_list / asset_detail_json：AccessMiddleware 按
url_name 判权限，'asset_list' 在 PUBLIC_VIEWS 里，访客才会被送进
public_response 渲染只读页；全站十几处 reverse('asset_list', args=['servers'])
也因此不用改。旧路由留在 index/urls.py 里兜底其它 kind，阶段 5 再清理。
"""
from django.urls import path

from . import views

urlpatterns = [
    path('assets/servers/', views.server_workspace, {'kind': 'servers'},
         name='asset_list'),
    path('assets/servers/<uuid:pk>/detail.json', views.server_detail_json,
         name='asset_detail_json'),
]
