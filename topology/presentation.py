"""Build a presentation-safe enterprise network topology payload."""

import re
from collections import Counter, deque
from functools import lru_cache
from ipaddress import ip_interface

from django.urls import reverse

from index.common.table_payload import detail_field_payloads
from index.common.table_registry import get_table_definition


ROLE_TIERS = {
    'firewall': 0,
    'router': 0,
    'core_switch': 1,
    'distribution_switch': 2,
    'access_switch': 3,
    'wireless_controller': 3,
    'network_other': 3,
}
DEFAULT_PREFIX_LENGTH = {4: 24, 6: 64}
ATTACHMENT_ROLE_PRIORITY = {
    'access_switch': 0,
    'wireless_controller': 1,
    'distribution_switch': 2,
    'core_switch': 3,
    'router': 4,
    'firewall': 5,
    'network_other': 6,
}


def _device_text(device):
    return ' '.join(
        str(value or '').strip() for value in (
            device.device_type, device.device_name, device.model,
        ) if str(value or '').strip()
    ).casefold()


def _has_code(value, code):
    return bool(re.search(rf'(?<![a-z0-9]){re.escape(code)}(?![a-z0-9])', value))


def network_role(device):
    """设备的拓扑角色。

    台账里显式标注的 network_role 优先——那一栏是用户按现场实际填的，
    比从名字里猜可靠。没标注（空值）才回退到按设备类型、名称、型号识别，
    这样旧数据和自动导入的设备不会因为没填这一栏就被画到错误的层。
    """
    explicit = (getattr(device, 'network_role', '') or '').strip()
    if explicit:
        return explicit
    value = _device_text(device)
    if any(token in value for token in ('access point', '无线接入点')) or _has_code(value, 'ap'):
        return 'access_point'
    if any(token in value for token in ('firewall', '防火墙', '安全网关', '出口网关')):
        return 'firewall'
    if any(token in value for token in ('core switch', '核心交换机', '核心')):
        return 'core_switch'
    if any(token in value for token in ('distribution switch', 'aggregation', '汇聚交换机', '汇聚')):
        return 'distribution_switch'
    if any(token in value for token in ('wireless controller', '无线控制器')) or _has_code(value, 'wlc') or _has_code(value, 'ac'):
        return 'wireless_controller'
    # 现场台账里大量设备只写了「接入」「汇聚」「POE」，没有英文型号，
    # 只认 switch/交换机 会把它们全部压成「其他」，层级就散了。
    if any(token in value for token in ('access switch', '接入交换机', '交换机', 'switch', 'poe')):
        return 'access_switch'
    if '接入' in value:
        return 'access_switch'
    if any(token in value for token in ('router', '路由器')):
        return 'router'
    if any(token in value for token in ('gateway', '网关')):
        return 'firewall'
    return 'network_other'


def network_tier(role):
    return ROLE_TIERS.get(role, 3)


UNLABELLED_SITE = '(未标注)'


def _subnet_hint(device):
    address = str(getattr(device, 'ip', '') or '').strip()
    parts = address.split('.')
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
        return '%s.%s' % (parts[0], parts[1])
    return ''


def _site_hint(device):
    """给场地起名用的提示，不参与分组。

    场地本身按拓扑结构算（见 site_components）；这里只是让标签像人话：
    台账写「场地-设备名」时用前缀，否则用 IP 前两段。
    """
    name = str(getattr(device, 'device_name', '') or '').strip()
    if '-' in name:
        head = name.split('-', 1)[0].strip()
        if head and head != UNLABELLED_SITE:
            return head
    return _subnet_hint(device)


def address_networks(value):
    networks = set()
    for candidate in re.split(r'[,;|\s]+', str(value or '').strip()):
        if not candidate:
            continue
        try:
            interface = ip_interface(candidate)
            if '/' not in candidate:
                interface = ip_interface(
                    f'{candidate}/{DEFAULT_PREFIX_LENGTH[interface.version]}'
                )
        except ValueError:
            continue
        networks.add(interface.network)
    return tuple(sorted(
        networks,
        key=lambda network: (network.version, -network.prefixlen, str(network)),
    ))


def _subnet_parent(endpoint_networks, backbone_nodes):
    candidates = []
    for node in backbone_nodes:
        overlaps = [
            max(endpoint.prefixlen, backbone.prefixlen)
            for endpoint in endpoint_networks
            for backbone in node['_networks']
            if endpoint.version == backbone.version and endpoint.overlaps(backbone)
        ]
        if overlaps:
            candidates.append((max(overlaps), node))
    return min(candidates, key=lambda item: (
        -item[0],
        ATTACHMENT_ROLE_PRIORITY[item[1]['role']],
        item[1]['tier'],
        item[1]['id'],
    ), default=(None, None))[1]


@lru_cache(maxsize=None)
def _definition(table_key):
    return get_table_definition(table_key)


def _details(asset, table_key):
    """基础资料 pairs, identical to the asset detail page card."""
    return detail_field_payloads(asset, _definition(table_key))


def _node(*, node_id, kind, role, label, subtitle, ip, vendor='', model='',
          status='unknown', url='', tier=None, parent_id=None,
          attachment_source='', child_count=0, details=(), site=''):
    return {
        'details': list(details),
        # 详情按需取：抽屉打开时前端打这个地址，首屏不再背每个节点的明细。
        'detailsUrl': reverse('operations_overview_node', args=[node_id]),
        'id': node_id,
        'kind': kind,
        'role': role,
        'site': site,
        'tier': tier,
        'label': label,
        'subtitle': subtitle,
        'ip': ip,
        'vendor': vendor or '',
        'model': model or '',
        'status': status,
        'url': url,
        'parent_id': parent_id,
        'attachment_source': attachment_source,
        'child_count': child_count,
    }


def _node_status(enabled, reachable):
    """节点状态：停用优先，其次看最近一次巡检连不连得上。

    四种状态各自有明确含义，图上要能分开：
    停用 = 人为下架；异常 = 连着但连不上；正常 = 最近一次巡检成功；未知 = 还没查过。
    reachable 为 None 表示这台设备从来没有巡检记录。
    """
    if not enabled:
        return 'disabled'
    if reachable is None:
        return 'unknown'
    return 'normal' if reachable else 'abnormal'


def _network_node(device, reachable=None):
    role = network_role(device)
    kind = 'endpoint' if role == 'access_point' else 'backbone'
    node = _node(
        node_id=f'networks:{device.pk}',
        kind=kind,
        role=role,
        tier=None if kind == 'endpoint' else network_tier(role),
        label=device.device_name or device.ip,
        subtitle=device.device_type or '其他网络设备',
        ip=device.ip,
        vendor=device.vendor,
        model=device.model,
        # 停用画灰不可点、异常标红，两者必须能分开：前者是人为下架，后者是连不上。
        status=_node_status(device.is_enabled, reachable),
        url=reverse('asset_detail', args=['networks', device.pk]),
        details=_details(device, 'networks'),
        site=_site_hint(device),
    )
    node['_subnet'] = _subnet_hint(device)
    node['_networks'] = address_networks(device.ip)
    return node


def _mac_set(value):
    """把「AA-BB, 11:22:33」这种多 MAC 字段拆成可比较的集合。

    终端在台账里的 MAC 是自由文本：分隔符有横杠、冒号、空格、逗号，大小写不定。
    归一化之后才能拿去和交换机 MAC 表里的写法对上。
    """
    parts = re.split(r'[,s;]+', str(value or ''))
    return {''.join(char for char in part.lower() if char.isalnum()) for part in parts} - {''}


def _endpoint_nodes(computers, servers, weak_current, with_details=True, reachability=None):
    nodes = []
    for computer in computers:
        node = _node(
            node_id=f'computers:{computer.pk}', kind='endpoint', role='computer',
            label=computer.computer_name, subtitle='PC', ip=computer.ip_addresses or '',
            vendor=computer.manufacturer, model=computer.model,
            status=_node_status(
                computer.is_active,
                (reachability or {}).get('computers:%s' % computer.pk)),
            url=reverse('asset_detail', args=['computers', computer.pk]),
            details=_details(computer, 'computers') if with_details else (),
            site=_site_hint(computer),
        )
        node['_networks'] = address_networks(computer.ip_addresses)
        # 终端的 MAC 是把它挂到接入交换机下面的唯一真凭据：PC 不发 LLDP，
        # 只能靠交换机 MAC 表里「谁在哪个口学到」来定位。
        node['_macs'] = _mac_set(computer.mac_addresses)
        nodes.append(node)
    for server in servers:
        node = _node(
            node_id=f'servers:{server.pk}', kind='endpoint', role='server',
            label=server.name or server.ip, subtitle=server.get_server_type_display(),
            ip=server.ip, vendor=server.manufacturer, model=server.model,
            status=_node_status(
                server.is_enabled, (reachability or {}).get('servers:%s' % server.pk)),
            url=reverse('asset_detail', args=['servers', server.pk]),
            details=_details(server, 'servers') if with_details else (),
            site=_site_hint(server),
        )
        node['_networks'] = address_networks(server.ip)
        node['_macs'] = _mac_set(server.mac_addresses)
        nodes.append(node)
    for monitor in weak_current:
        node = _node(
            node_id=f'weakcurrent:{monitor.pk}', kind='endpoint', role='weak_current_device',
            label=monitor.device_name or monitor.ip,
            subtitle=monitor.device_type or '弱电设备', ip=monitor.ip,
            vendor=monitor.vendor, model=monitor.model,
            status=_node_status(
                monitor.is_enabled, (reachability or {}).get('weakcurrent:%s' % monitor.pk)),
            url=reverse('asset_detail', args=['weakcurrent', monitor.pk]),
            details=_details(monitor, 'weakcurrent') if with_details else (),
            site=_site_hint(monitor),
        )
        node['_networks'] = address_networks(monitor.ip)
        nodes.append(node)
    return nodes


def _physical_parent(endpoint, backbone_by_id, physical_edges):
    if endpoint['role'] != 'access_point':
        return None
    endpoint_pk = endpoint['id'].split(':', 1)[1]
    for edge in sorted(physical_edges, key=lambda row: str(row.get('id', ''))):
        if edge.get('resolution_status') != 'resolved':
            continue
        local_id = str(edge.get('local_device_id') or '')
        remote_id = str(edge.get('remote_device_id') or '')
        if local_id == endpoint_pk:
            parent = backbone_by_id.get(f'networks:{remote_id}')
        elif remote_id == endpoint_pk:
            parent = backbone_by_id.get(f'networks:{local_id}')
        else:
            parent = None
        if parent is not None:
            return parent
    return None


EXIT_ROLES = {'firewall', 'router'}


def _merge_orphans(components, backbone_nodes):
    """没有同场地链路、自己成一块的设备和主体合并。

    纯结构分组会把「没采到邻居的孤立设备」判成独立场地，页面上就是一排
    只有一台机器的列。这里只在分量大小为 1 时，用它的名称前缀或 IP 网段
    去找主体分量——是兜底归并，不是分组依据。
    """
    by_id = {node['id']: node for node in backbone_nodes}
    groups = [list(members) for members in components]
    for index, members in enumerate(groups):
        if len(members) != 1:
            continue
        orphan = by_id.get(members[0])
        if orphan is None:
            continue
        hints = {value for value in (orphan.get('site'), orphan.get('_subnet')) if value}
        if not hints:
            continue
        for other, peers in enumerate(groups):
            if other == index or len(peers) <= 1:
                continue
            if any(
                by_id.get(peer, {}).get('site') in hints
                or by_id.get(peer, {}).get('_subnet') in hints
                for peer in peers
            ):
                groups[other].extend(members)
                groups[index] = []
                break
    return [members for members in groups if members]


def is_exit_node(node):
    return node.get('role') in EXIT_ROLES


def site_components(backbone_nodes, physical_edges, hints):
    """把主干设备分成若干场地，只看链路结构。

    出口设备之间的直连就是场地之间的隧道，先把它们摘掉；剩下的链路做连通
    分量，每个分量就是一块场地。同一场地的主备防火墙各自接核心，摘掉它们
    之间的心跳线仍然连通，不会被拆成两块。

    单场地时全部节点落进同一个分量，布局自然退化成「一棵树」。
    """
    by_pk = {node['id'].split(':', 1)[1]: node for node in backbone_nodes}
    adjacency = {node['id']: set() for node in backbone_nodes}
    for edge in physical_edges:
        if edge.get('resolution_status') != 'resolved':
            continue
        left = by_pk.get(str(edge.get('local_device_id') or ''))
        right = by_pk.get(str(edge.get('remote_device_id') or ''))
        if left is None or right is None or left is right:
            continue
        if is_exit_node(left) and is_exit_node(right):
            continue
        adjacency[left['id']].add(right['id'])
        adjacency[right['id']].add(left['id'])

    component_of = {}
    components = []
    for node in sorted(backbone_nodes, key=lambda item: (
            item['tier'] if item['tier'] is not None else 99, item['label'], item['id'])):
        if node['id'] in component_of:
            continue
        members = [node['id']]
        component_of[node['id']] = len(components)
        queue = deque([node['id']])
        while queue:
            current = queue.popleft()
            for neighbour in sorted(adjacency[current]):
                if neighbour in component_of:
                    continue
                component_of[neighbour] = len(components)
                members.append(neighbour)
                queue.append(neighbour)
        components.append(members)

    components = _merge_orphans(components, backbone_nodes)
    # 合并会改变分量数量，索引必须按最终结果重建。
    component_of = {
        member: index
        for index, members in enumerate(components)
        for member in members
    }

    labels = {}
    for index, members in enumerate(components):
        names = [hints.get(member, '') for member in members if hints.get(member)]
        labels[index] = Counter(names).most_common(1)[0][0] if names else ''
    for index, members in enumerate(components):
        if not labels[index]:
            # 没有可信名称就用位置编号，同一场地内共享同一个标签。
            labels[index] = '场地 %d' % (index + 1)
    for node in backbone_nodes:
        index = component_of[node['id']]
        node['site_id'] = index
        node['site'] = labels[index]
    return components, component_of


def _tier_of(node):
    return node['tier'] if node['tier'] is not None else 99


def backbone_parents(backbone_nodes, physical_edges):
    """把已解析链路收成树：从最靠近出口的设备出发做 BFS。

    链路本身是网状的，树只是一种呈现。先访问的一定更靠近出口（tier 更小），
    所以父节点的层号永远不大于子节点，画出来就是从出口往下走。

    同层之间直连（堆叠、冗余备份、或两台接入交换机对连）不算上下级。BFS 只
    知道访问顺序，不知道谁在谁上面：不加层级约束的话，先访问到的那台会凭空
    变成另一台的父节点，图上多出一条竖线，看起来像两台设备串成了一条链路。
    """
    by_pk = {node['id'].split(':', 1)[1]: node for node in backbone_nodes}
    by_id = {node['id']: node for node in backbone_nodes}
    adjacency = {node['id']: set() for node in backbone_nodes}
    for edge in physical_edges:
        if edge.get('resolution_status') != 'resolved':
            continue
        left = by_pk.get(str(edge.get('local_device_id') or ''))
        right = by_pk.get(str(edge.get('remote_device_id') or ''))
        if left is None or right is None or left is right:
            continue
        # 跨场地的链路是 VPN，不是上下级；把它算进树里会让一个场地挂到另一个
        # 场地下面。这里按结构分量判断，不看名字。
        if left.get('site_id') != right.get('site_id'):
            continue
        adjacency[left['id']].add(right['id'])
        adjacency[right['id']].add(left['id'])

    parent = {}
    visited = set()
    for root in sorted(backbone_nodes, key=lambda node: (
            _tier_of(node), node['label'], node['id'])):
        if root['id'] in visited:
            continue
        visited.add(root['id'])
        queue = deque([root['id']])
        while queue:
            current = queue.popleft()
            for neighbour in sorted(adjacency[current]):
                if neighbour in visited:
                    continue
                visited.add(neighbour)
                if _tier_of(by_id[neighbour]) > _tier_of(by_id[current]):
                    parent[neighbour] = current
                queue.append(neighbour)
    return parent


def _orphan_parent(endpoint, backbone_nodes):
    """孤儿终端的兜底父节点：优先同场地、tier 最小的主干节点。"""
    site = endpoint.get('site') or ''
    pool = [node for node in backbone_nodes if not site or node.get('site') == site]
    if not pool:
        pool = list(backbone_nodes)
    if not pool:
        return None
    return min(pool, key=lambda node: (
        node.get('tier') if isinstance(node.get('tier'), int) else 99,
        str(node.get('id')),
    ))


def _mac_parent(endpoint, backbone_by_id, mac_locations):
    """终端挂在哪个口上，问交换机的 MAC 地址表。

    MAC 出现在某台设备的某个口下，那台就是它的上级。这比按网段猜准得多：
    同一个 /24 下挂十台接入交换机时，网段推断分不清终端到底接在哪一台。
    """
    for mac in sorted(endpoint.get('_macs') or ()):
        hit = mac_locations.get(mac)
        if not hit:
            continue
        parent = backbone_by_id.get(f'networks:{hit[0]}')
        if parent is not None:
            return parent
    return None


def attach_endpoints(backbone_nodes, endpoint_nodes, physical_edges, mac_locations=None):
    backbone_by_id = {node['id']: node for node in backbone_nodes}
    mac_locations = mac_locations or {}
    edges = []
    for endpoint in endpoint_nodes:
        parent = _physical_parent(endpoint, backbone_by_id, physical_edges)
        source = 'physical_discovered' if parent is not None else ''
        if parent is None:
            parent = _mac_parent(endpoint, backbone_by_id, mac_locations)
            source = 'mac_learned' if parent is not None else ''
        if parent is None:
            parent = _subnet_parent(endpoint['_networks'], backbone_nodes)
            source = 'inferred_subnet' if parent is not None else ''
        if parent is None:
            # 既没有物理发现、IP 也落不进任何主干设备的 /24（比如没填 IP 的 PC），
            # 原来直接跳过 —— 终端就这么静默消失了，而顶部「另有 N 个设备未绘制」
            # 只统计被截断的资产，对不上。兜底挂到本场地 tier 最小的主干节点上，
            # 前端用虚线区分。
            parent = _orphan_parent(endpoint, backbone_nodes)
            source = 'orphan' if parent is not None else ''
        if parent is None:
            continue
        endpoint['parent_id'] = parent['id']
        endpoint['attachment_source'] = source
        parent['child_count'] += 1
        edges.append({
            'id': f'attachment:{parent["id"]}:{endpoint["id"]}',
            'kind': 'endpoint_attachment',
            'source': parent['id'],
            'target': endpoint['id'],
            'attachment_source': source,
        })
    return sorted(edges, key=lambda edge: edge['id'])


def build_enterprise_topology(*, network_devices, computers, servers, weak_current,
                              physical, asset_truncation=None, with_details=True,
                              reachability=None, mac_locations=None):
    reachability = reachability or {}
    physical_edges = list(physical.get('links', []))
    linked_ids = set()
    for edge in physical_edges:
        for side in ('local_device_id', 'remote_device_id'):
            value = edge.get(side)
            if value:
                linked_ids.add('networks:%s' % value)
    # 停用且一条链路都不沾的设备不画：既不在用，也不在任何链路端点，画出来只剩
    # 噪音。停用但还有链路的仍要画（见下面的 disabled 状态）——那是「机器下架了、
    # 线还插着」，摘掉就跟断线看不出区别了。
    network_nodes = [
        node for node in (
            _network_node(device, reachability.get('networks:%s' % device.pk))
            for device in network_devices)
        if node['status'] != 'disabled' or node['id'] in linked_ids
    ]
    # 首屏只要名称/IP/型号这些一眼要看的字段；每个节点 400 多字节的
    # details 合计 67 KB，等抽屉打开再单独取。
    if not with_details:
        for node in network_nodes:
            node['details'] = []
    backbone_nodes = [node for node in network_nodes if node['kind'] == 'backbone']
    endpoint_nodes = [
        *[node for node in network_nodes if node['kind'] == 'endpoint'],
        *_endpoint_nodes(computers, servers, weak_current, with_details=with_details,
                         reachability=reachability),
    ]
    hints = {node['id']: node.get('site', '') for node in backbone_nodes}
    components, component_of = site_components(backbone_nodes, physical_edges, hints)
    site_id_of = {node['id'].split(':', 1)[1]: node.get('site_id') for node in backbone_nodes}
    for edge in physical_edges:
        left = site_id_of.get(str(edge.get('local_device_id') or ''))
        right = site_id_of.get(str(edge.get('remote_device_id') or ''))
        # 两端场地不同的已解析链路就是场地之间的 VPN 隧道。
        edge['vpn'] = bool(
            left is not None and right is not None and left != right
            and edge.get('resolution_status') == 'resolved'
        )
    hierarchy = backbone_parents(backbone_nodes, physical_edges)
    hierarchy_edges = []
    for node in backbone_nodes:
        parent_id = hierarchy.get(node['id'])
        if not parent_id:
            continue
        node['parent_id'] = parent_id
        hierarchy_edges.append({
            'id': f'hierarchy:{parent_id}:{node["id"]}',
            'kind': 'backbone_hierarchy',
            'source': parent_id,
            'target': node['id'],
        })
    attachment_edges = attach_endpoints(
        backbone_nodes, endpoint_nodes, physical_edges, mac_locations,
    )
    nodes = backbone_nodes + endpoint_nodes
    # 终端跟随上级的场地，别再按自己的 IP 猜一次。
    by_id = {node['id']: node for node in nodes}
    for node in nodes:
        parent = by_id.get(node.get('parent_id') or '')
        if parent is not None and parent.get('site'):
            node['site'] = parent['site']
            node['site_id'] = parent.get('site_id')
    nodes.sort(key=lambda node: (
        0 if node['kind'] == 'backbone' else 1,
        node.get('site_id') if node.get('site_id') is not None else 999,
        node['tier'] if node['tier'] is not None else 99,
        node['label'], node['id'],
    ))
    sites = [
        {'id': index, 'label': next(
            (node['site'] for node in backbone_nodes if node.get('site_id') == index), ''),
         'node_ids': members}
        for index, members in enumerate(components)
    ]
    backbone_count = sum(node['kind'] == 'backbone' for node in nodes)
    has_physical_links = bool(physical_edges)
    for node in nodes:
        node.pop('_networks', None)
        node.pop('_macs', None)
    return {
        'mode': 'empty' if not backbone_count else ('hybrid' if has_physical_links else 'backbone'),
        'nodes': nodes,
        'sites': sites,
        'attachment_edges': attachment_edges,
        'hierarchy_edges': sorted(hierarchy_edges, key=lambda edge: edge['id']),
        'interfaces': list(physical.get('interfaces', [])),
        'physical_edges': physical_edges,
        'asset_truncation': dict(asset_truncation or {}),
        'has_physical_links': has_physical_links,
    }
