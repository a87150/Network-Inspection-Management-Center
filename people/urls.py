"""人员部门工作区的路由。

路径与原 asset_list / asset_detail_json 完全相同；URL 名也沿用旧名，理由是
index/common/access.py 的 AccessMiddleware 按 url_name 判权限：'asset_list'
在 PUBLIC_VIEWS 里，访客的 /assets/people/ 才会被送进 public_response 渲染只读页，
换成新名字会把访客直接挡到登录页。旧路由继续留在 index/urls.py 里，
本条只是排在它前面先接住 people 这一种 kind。
"""
from django.urls import path

from people import views

urlpatterns = [
    path('assets/people/', views.people_workspace, {'kind': 'people'},
         name='asset_list'),
    path('assets/people/<uuid:pk>/detail.json', views.people_detail_json,
         {'kind': 'people'}, name='asset_detail_json'),
]
