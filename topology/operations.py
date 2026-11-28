"""Presentation-safe data for the network topology page."""

from collections import Counter

from django.db import DatabaseError
from django.http import Http404, JsonResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.http import require_GET

from net.devices.network import observations
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
    # 停用的设备仍然取出来，由 presentation 标成 disabled：图上画灰、不可点。
    # 直接不画会让「停用」和「掉线/拆线」长得一样——前者是人为下架，后者是故障，
    # 都断在图上就分不清了。Computer 用 is_active 表达另一件事（主机是否上报过），
    # 不在停用口径里。
    return (
        ('computers', Computer.objects.defer('login_account')),
        ('networks', Network_Device.objects.defer(
            'password', 'snmp_auth_password', 'snmp_priv_password', 'api_shared_secret',
        )),
        ('servers', Server.objects.defer('password', 'api_token')),
        ('weakcurrent', WeakCurrentDevice.objects.defer('api_password', 'api_token')),
    )


def _reachability():
    """每台资产最近一次巡检到底连不连得上。键是拓扑节点 id。

    拓扑上「异常」和「停用」是两件事：停用是人为下架，异常是连不上。以前两者
    都只有一个 unknown，图上完全看不出设备是不是已经失联了。

    只取每台资产的最后一条记录，用 Subquery 让数据库做，不把历史记录拉回内存。

    和 net/dashboard/assets.py:with_latest_status 是同一套「每台资产取最新一条」的
    口径，这里保留独立实现而不是调它：那一份还要判 collection status、算错误记录
    存不存在，每台资产多四个子查询；拓扑只用一个 is_reachable 布尔，跟着它算等于
    为用不上的字段付全量代价。两份的排序键必须一致（-created_at, -pk），否则同一
    时刻的两条记录会在总览页和资产卡片上给出不同的「最新」。
    """
    from django.db.models import OuterRef, Subquery

    from inspections.records import RECORD_PAGES

    snapshot = {}
    for kind, page in RECORD_PAGES.items():
        field = page.asset_field
        latest = page.model.objects.filter(
            **{field: OuterRef('pk')},
        ).order_by('-created_at', '-pk').values('is_reachable')[:1]
        asset_model = page.model._meta.get_field(field).related_model
        rows = asset_model.objects.annotate(_latest_reachable=Subquery(latest)).values_list(
            'pk', '_latest_reachable')
        for pk, reachable in rows:
            snapshot['%s:%s' % (kind, pk)] = reachable
    return snapshot


def _selected_rows(key, queryset, required_network_ids):
    """挑出这次要画的资产，附带台账总数和「端点有没有顶破上限」。

    链路端点必须全保留，所以结果可能超过每类上限：5000 条链路牵出 90 台交换机，
    90 台都得画。差额不在这里算——选中不等于画出来（停用且无连线的设备还会被
    presentation 剔除），见 _truncation_counts。
    """
    total = queryset.count()
    if key != 'networks' or not required_network_ids:
        rows = list(queryset.order_by('pk')[:ASSET_NODE_LIMIT_PER_KIND])
        return rows, total, False

    required_rows = list(queryset.filter(pk__in=required_network_ids).order_by('pk'))
    remaining = max(0, ASSET_NODE_LIMIT_PER_KIND - len(required_rows))
    rows = required_rows + list(
        queryset.exclude(pk__in=required_network_ids).order_by('pk')[:remaining]
    )
    return rows, total, len(required_rows) > ASSET_NODE_LIMIT_PER_KIND


def _load_assets(required_network_ids=()):
    selected = {}
    totals = {}
    retained = set()
    required_network_ids = {str(value) for value in required_network_ids if value}
    for key, queryset in _asset_sources():
        rows, total, over_limit = _selected_rows(key, queryset, required_network_ids)
        selected[key] = rows
        totals[key] = total
        if over_limit:
            retained.add(key)
    return selected, totals, retained


def _truncation_counts(totals, nodes, retained):
    """每类资产「没画出来」的数量，按真正进图的节点数算。

    用总数减上限、或减选中的行数都不准：链路端点不受上限约束，选中数可以超过
    上限；反过来，停用且没连线的设备即使被选中，presentation 也会把它们剔除。
    只有图上实际有几个节点是确定的，界面上的「另有 N 个设备未绘制」才对得上。

    因为保留链路端点而提前截断普通设备的，另用一条非数字说明区分：前端
    truncationCount 只累加数字，字符串不影响总数。
    """
    drawn = Counter(node['id'].split(':', 1)[0] for node in nodes)
    counts = {}
    for key, total in totals.items():
        omitted = max(0, total - drawn.get(key, 0))
        if omitted:
            counts[key] = omitted
    for key in retained:
        counts['%s_retained' % key] = '已保留全部链路端点，普通设备因此提前截断。'
    return counts


def _build_topology(physical=None):
    # 破千条链路时，被截掉的链路对应的设备既不被保留、也拿不到邻居关系，
    # site_components 会把它判成孤立小场地。提高到 5000，并把是否截断回传给前端。
    if physical is None:
        physical = current_topology_payload(include_stale=True, limit=5000)
    physical_edges = physical['links']
    required_network_ids = {
        value
        for edge in physical_edges
        for value in (edge.get('local_device_id'), edge.get('remote_device_id'))
        if value
    }
    assets, totals, retained = _load_assets(required_network_ids)
    topology = build_enterprise_topology(
        network_devices=assets['networks'],
        computers=assets['computers'],
        servers=assets['servers'],
        weak_current=assets['weakcurrent'],
        physical=physical,
        with_details=False,
        reachability=_safe_region('reachability', _reachability) or {},
        # 终端不发 LLDP，只能靠交换机 MAC 表里「谁在哪个口学到」定位。
        mac_locations=_safe_region('mac_locations', observations.mac_locations) or {},
    )
    truncation = _truncation_counts(totals, topology['nodes'], retained)
    if physical.get('links_truncated'):
        truncation['links'] = '链路超过显示上限，部分设备未绘制。'
    topology['asset_truncation'] = truncation
    return topology


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
