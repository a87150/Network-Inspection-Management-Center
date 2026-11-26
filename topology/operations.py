"""Presentation-safe data for the network topology page."""

from django.db import DatabaseError
from django.http import Http404, JsonResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.http import require_GET

from net.models import Computer, Network_Device, WeakCurrentDevice, Server
from net.topology.read_model import current_topology_payload
from topology.presentation import build_enterprise_topology


ASSET_NODE_LIMIT_PER_KIND = 80


def _safe_region(name, builder):
    try:
        return builder()
    except DatabaseError:
        return {'error': f'{name}_unavailable'}


def _asset_sources():
    """拓扑要读的字段太多，白名单式 only() 维护不过来。

    之前只列了 id/名称/IP，而拓扑卡片还要读 os、manufacturer、model、vendor、
    server_type 以及 cpu_model/memory_total_gb/disk_total_gb 等指标，每读一个
    deferred 字段就回查一次 —— 1500 台设备乘十几次就是一个量级的 SQL 放大。
    这几个模型都没有 TextField/JSONField 大字段，所以只排掉凭据列，其余一次取回。
    """
    return (
        ('computers', Computer.objects.defer('login_account')),
        ('networks', Network_Device.objects.defer(
            'password', 'snmp_auth_password', 'snmp_priv_password', 'api_shared_secret',
        )),
        ('servers', Server.objects.defer('password', 'api_token')),
        ('weakcurrent', WeakCurrentDevice.objects.defer('api_password', 'api_token')),
    )


def _selected_rows(key, queryset, required_network_ids):
    total = queryset.count()
    if key != 'networks' or not required_network_ids:
        rows = list(queryset.order_by('pk')[:ASSET_NODE_LIMIT_PER_KIND])
        return rows, max(0, total - len(rows))

    required_rows = list(queryset.filter(pk__in=required_network_ids).order_by('pk'))
    remaining = max(0, ASSET_NODE_LIMIT_PER_KIND - len(required_rows))
    rows = required_rows + list(
        queryset.exclude(pk__in=required_network_ids).order_by('pk')[:remaining]
    )
    return rows, max(0, total - len(rows))


def _load_assets(required_network_ids=()):
    selected = {}
    truncation = {}
    required_network_ids = {str(value) for value in required_network_ids if value}
    for key, queryset in _asset_sources():
        rows, omitted = _selected_rows(key, queryset, required_network_ids)
        selected[key] = rows
        if omitted:
            truncation[key] = omitted
    return selected, truncation


def _build_topology():
    # 破千条链路时，被截掉的链路对应的设备既不被保留、也拿不到邻居关系，
    # site_components 会把它判成孤立小场地。提高到 5000，并把是否截断回传给前端。
    physical = current_topology_payload(include_stale=True, limit=5000)
    links_truncated = bool(physical.get('links_truncated'))
    physical_edges = physical['links']
    required_network_ids = {
        value
        for edge in physical_edges
        for value in (edge.get('local_device_id'), edge.get('remote_device_id'))
        if value
    }
    assets, truncation = _load_assets(required_network_ids)
    if links_truncated:
        truncation['links'] = '链路超过显示上限，部分设备未绘制。'
    return build_enterprise_topology(
        network_devices=assets['networks'],
        computers=assets['computers'],
        servers=assets['servers'],
        weak_current=assets['weakcurrent'],
        physical=physical,
        asset_truncation=truncation,
        with_details=False,
    )


def build_operations_snapshot(*, now=None):
    generated_at = now or timezone.now()
    return {
        'schema_version': 3,
        'generated_at': generated_at.isoformat(),
        'topology': _safe_region('topology', _build_topology),
    }


@require_GET
def operations_overview(request):
    return render(
        request,
        'topology/operations_overview.html',
        {'snapshot': build_operations_snapshot()},
    )


@require_GET
def operations_overview_data(request):
    return JsonResponse(build_operations_snapshot())


@require_GET
def operations_ip_lookup(request):
    """按 IP 搜资产：拓扑只画主干和部分终端，没画出来的也要能查到。

    台账（ARP/MAC）来自巡检观察，没采到时是空的；这里直接查资产表本身，
    拓扑画不画都能定位到设备。"""
    from django.db.models import Q
    from net.models import Computer, Network_Device, Server, WeakCurrentDevice

    query = (request.GET.get('q') or '').strip()
    if not query:
        return JsonResponse({'query': '', 'results': []})
    rows = []
    sources = (
        (Computer, 'PC', ('computer_name',), 'ip_addresses', 'computers'),
        (Network_Device, '网络设备', ('device_name',), 'ip', 'networks'),
        (Server, '服务器', ('name',), 'ip', 'servers'),
        (WeakCurrentDevice, '弱电设备', ('device_name',), 'ip', 'weakcurrent'),
    )
    for model, label, name_fields, ip_field, kind_key in sources:
        condition = Q(**{f'{ip_field}__icontains': query})
        for field in name_fields:
            condition |= Q(**{f'{field}__icontains': query})
        for obj in model.objects.filter(condition)[:10]:
            rows.append({
                'kind': label,
                'kindKey': kind_key,
                'name': next(
                    (getattr(obj, f) for f in name_fields if getattr(obj, f, '')),
                    str(obj.pk),
                ),
                'ip': getattr(obj, ip_field, '') or '',
                'pk': obj.pk,
            })
    return JsonResponse({'query': query, 'results': rows})

@require_GET
def operations_node_detail(request, node_id):
    """单个节点的详细信息，抽屉打开时才取。

    拓扑首屏不再带每个节点的 details（180 个节点 67 KB），只在总览里给出
    名称、IP、型号这些一眼要看的字段；点开抽屉再单独拿这一份。这里按 id
    直接查那台资产，不重算整张拓扑。
    """
    from topology.presentation import _details

    kind, _, pk = str(node_id).partition(':')
    model = {
        'networks': Network_Device,
        'computers': Computer,
        'servers': Server,
        'weakcurrent': WeakCurrentDevice,
    }.get(kind)
    if model is None or not pk:
        raise Http404('节点不存在')
    asset = model.objects.filter(pk=pk).first()
    if asset is None:
        raise Http404('节点不存在')
    return JsonResponse({'details': _details(asset, kind)})
