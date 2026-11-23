"""Guest presentation: independent queries, explicit projections, safe links.

Do not reuse authenticated view/context builders here. Adding a model field
must never implicitly add a public column, search term or sort key.
"""
from urllib.parse import urlencode

from django.core.paginator import Paginator
from django.db.models import Count, Q
from django.http import Http404, JsonResponse
from django.template.response import TemplateResponse
from django.urls import reverse

from net.models import Computer, Network_Device, People, WeakCurrentDevice, Server
from index.common.json_script import localized_json_script


PAGE_SIZES = (20, 50, 100, 200, 500)
# (public key, database column, label); None denotes a fixed public type.
PUBLIC_INVENTORIES = {
    'people': (People, '人员', (
        ('name', 'name', '姓名'), ('department', 'department', '部门'),
        ('is_active', 'is_active', '在职'),
    )),
    'computers': (Computer, 'PC', (
        ('name', 'computer_name', '设备名称'), ('ip', 'ip_addresses', 'IP'),
        ('type', None, '类型'), ('manufacturer', 'manufacturer', '厂商'),
    )),
    'networks': (Network_Device, '网络设备', (
        ('name', 'device_name', '设备名称'), ('ip', 'ip', 'IP'),
        ('type', 'device_type', '类型'), ('manufacturer', 'vendor', '厂商'),
    )),
    'servers': (Server, '服务器', (
        ('name', 'name', '设备名称'), ('ip', 'ip', 'IP'),
        ('type', 'server_type', '类型'), ('manufacturer', 'manufacturer', '厂商'),
    )),
    'weakcurrent': (WeakCurrentDevice, '弱电设备', (
        ('name', 'device_name', '设备名称'), ('ip', 'ip', 'IP'),
        ('type', 'device_type', '类型'), ('manufacturer', 'vendor', '厂商'),
    )),
}


def _script(payload, element_id):
    return localized_json_script(payload, element_id)


def _summary(request, view_name):
    people = People.objects.aggregate(total=Count('pk'), active=Count('pk', filter=Q(is_active=True)))
    people['inactive'] = people['total'] - people['active']
    context = {'title': '人员统计' if view_name == 'people_statistics' else '资产概览',
               'people_summary': people}
    if view_name == 'index':
        context['inventories'] = [
            {'title': title, 'total': model.objects.count(),
             'url': reverse('asset_list', args=[kind])}
            for kind, (model, title, _fields) in PUBLIC_INVENTORIES.items()
        ]
    else:
        context['departments'] = list(People.objects.order_by('department').values('department').annotate(
            total=Count('pk'), active=Count('pk', filter=Q(is_active=True)),
            inactive=Count('pk', filter=Q(is_active=False)),
        ))
    # 访客页也走同一种岛：一份 JSON，一个组件，页面上没有权限控件。
    context['summary_bootstrap'] = _script({
        'page': {'title': context['title'], 'eyebrow': '汇总'},
        'people': people,
        'people_url': reverse('people_statistics'),
        'inventories': context.get('inventories') or [],
        # None 表示这一栏不存在（首页），空列表表示这类页面但暂时没有记录。
        'departments': context.get('departments'),
        'people_title': '人员',
        'people_link_label': '人员统计',
        'ledger_link_label': '查看台账',
        'department_caption': '部门人员统计',
        'department_empty': '暂无记录',
    }, 'public-summary-bootstrap')
    return TemplateResponse(request, 'public/summary.html', context)


def _inventory(request, kind):
    if kind not in PUBLIC_INVENTORIES:
        raise Http404('未知的公开资产类型')
    model, title, fields = PUBLIC_INVENTORIES[kind]
    sources = {key: source for key, source, _label in fields}
    # Accept the existing names for basic device columns, without accepting any
    # arbitrary model lookup or relationship traversal supplied by the client.
    aliases = {source: key for key, source, _label in fields if source}
    sort = request.GET.get('sort', 'name')
    sort = aliases.get(sort, sort)
    if sort not in sources:
        sort = 'name'
    order = request.GET.get('order', 'asc')
    if order not in ('asc', 'desc'):
        order = 'asc'
    try:
        size = int(request.GET.get('page_size', 50))
    except (ValueError, TypeError):
        size = 50
    size = max((n for n in PAGE_SIZES if n <= size), default=20)
    safe_params = {'sort': sort, 'order': order, 'page_size': size}
    queryset = model.objects.all()
    # Search is deliberately name-only, never the rich table's search fields.
    for param in ('q', 'filter_name'):
        value = request.GET.get(param, '').strip()[:255]
        if param == 'filter_name' and not value:
            value = request.GET.get('filter_' + sources['name'], '').strip()[:255]
        if value:
            queryset = queryset.filter(**{sources['name'] + '__icontains': value})
            safe_params[param] = value
    sort_source = sources[sort] or sources['name']
    queryset = queryset.order_by(('-' if order == 'desc' else '') + sort_source, 'pk')
    # Evaluate only the selected page, converting every row into a plain dict.
    projection = tuple(source for source in sources.values() if source)
    page = Paginator(queryset.values(*projection), size).get_page(request.GET.get('page'))
    page.object_list = [
        {key: row[source] if source else title for key, source, _label in fields}
        for row in page.object_list
    ]
    columns = []
    for key, _source, label in fields:
        params = dict(safe_params, sort=key, order='desc' if sort == key and order == 'asc' else 'asc')
        columns.append({'key': key, 'label': label, 'url': '?' + urlencode(params)})
    payload = {
        'page': {
            'title': title,
            'eyebrow': '公开基础信息',
            'count': page.paginator.count,
            'number': page.number,
            'pages': page.paginator.num_pages,
        },
        'columns': columns,
        'rows': page.object_list,
        'q': safe_params.get('q', ''),
        'filter_name': safe_params.get('filter_name', ''),
        'page_sizes': list(PAGE_SIZES),
        'page_size': size,
        'sort': sort,
        'order': order,
        'previous_url': '?' + urlencode(dict(safe_params, page=page.previous_page_number())) if page.has_previous() else '',
        'next_url': '?' + urlencode(dict(safe_params, page=page.next_page_number())) if page.has_next() else '',
        'search_label': '搜索名称',
        'filter_label': '名称筛选',
        'size_label': '每页条数',
        'submit_label': '筛选',
        'empty_message': '暂无记录',
        'previous_label': '上一页',
        'next_label': '下一页',
        'pagination_label': '公开列表分页',
        'caption': title + '公开列表',
    }
    # 访客页也不刷新：筛选/排序/翻页重取这一份 JSON，地址栏保持不动。
    if request.GET.get('fragment') == 'list':
        return JsonResponse(payload)
    context = {
        'title': title, 'page_obj': page, 'columns': columns,
        'page_sizes': PAGE_SIZES, 'page_size': size, 'sort': sort, 'order': order,
        'q': safe_params.get('q', ''), 'filter_name': safe_params.get('filter_name', ''),
        'previous_url': payload['previous_url'],
        'next_url': payload['next_url'],
        'list_bootstrap': _script(payload, 'public-list-bootstrap'),
    }
    return TemplateResponse(request, 'public/list.html', context)


def public_response(request, view_name, kwargs):
    """AccessMiddleware dispatch target for the approved public routes.

    资产台账已改为登录可见，因此这里不再有 asset_list 分支。
    """
    if view_name in ('index', 'people_statistics'):
        return _summary(request, view_name)
    if view_name == 'item_list':
        return _inventory(request, kwargs.get('item'))
    raise Http404('未知的公开页面')
