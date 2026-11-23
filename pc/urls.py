"""PC 工作区页路由。

路径与 URL 名都沿用旧的 asset_list / asset_detail_json：AccessMiddleware 按
url_name 判权限，'asset_list' 在 PUBLIC_VIEWS 里，访客才会被送进
public_response 渲染只读页；全站十几处 reverse('asset_list', args=['computers'])
也因此不用改。旧路由留在 index/urls.py 里兜底其它 kind，阶段 5 再清理。
"""
from django.urls import path

from . import views

urlpatterns = [
    path('assets/computers/', views.pc_workspace, {'kind': 'computers'},
         name='asset_list'),
    path('assets/computers/<uuid:pk>/detail.json', views.pc_detail_json,
         name='asset_detail_json'),
    path('assets/computers/tasks.json', views.pc_tasks, name='pc_task_page'),
    path('assets/computers/task-stats.json', views.pc_task_stats, name='pc_task_stats'),
]
