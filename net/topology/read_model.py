"""Explicit field allowlists for current physical topology."""
from net.models import NetworkTopologyInterface, NetworkTopologyLink

DEFAULT_LIMIT = 1000
MAX_LIMIT = 5000


def _bounded_limit(value, *, default=DEFAULT_LIMIT, maximum=MAX_LIMIT):
    """把外部传入的 limit 收敛到合法区间；解析不了就回落默认，不让它冒泡成 500。"""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(parsed, maximum))


def interface_payload(row):
    return {'id':str(row.pk),'device_id':str(row.device_id),'stable_key':row.stable_key,
            'if_index':row.if_index,'name':row.name,'description':row.description,
            'mac_address':row.mac_address,'admin_status':row.admin_status,'oper_status':row.oper_status,
            'speed_bps':row.speed_bps,'vlan_ids':row.vlan_ids,'is_stale':row.is_stale,
            'last_seen_at':row.last_seen_at.isoformat()}


def link_payload(row):
    # 接口名放在链路里，前端就不必再去 interfaces 数组里反查。原来那样查有两个
    # 问题：接口数量撞到 limit 被截断时查不到，只剩一串 ID；调用方还得自己知道
    # 该看 local 还是 remote——两侧都给了就不用猜。
    return {'id':str(row.pk),'kind':'physical_discovered','local_interface_id':str(row.local_interface_id),
            'local_interface_name':row.local_interface.name,
            'local_interface_description':row.local_interface.description,
            'local_device_id':str(row.local_interface.device_id),'remote_device_id':str(row.remote_device_id) if row.remote_device_id else None,
            'remote_interface_id':str(row.remote_interface_id) if row.remote_interface_id else None,
            'remote_interface_name':row.remote_interface.name if row.remote_interface_id else None,
            'remote_chassis_id':row.remote_chassis_id,'remote_port_id':row.remote_port_id,
            'remote_port_description':row.remote_port_description,'remote_system_name':row.remote_system_name,
            'remote_management_addresses':row.remote_management_addresses,'protocols':row.protocols,
            'evidence_direction':row.evidence_direction,'resolution_status':row.resolution_status,
            'status':row.status,'speed_bps':row.speed_bps,'vlan_ids':row.vlan_ids,
            'confidence':str(row.confidence),'last_seen_at':row.last_seen_at.isoformat()}


def current_topology_payload(*, include_stale=False, limit=DEFAULT_LIMIT):
    limit=_bounded_limit(limit)
    # interface_payload 只读本地 device_id 列，不碰 device 对象，所以这里不 join。
    interfaces=NetworkTopologyInterface.objects.order_by('device_id','stable_key')[:limit]
    links=NetworkTopologyLink.objects.select_related(
        'local_interface','remote_interface').order_by('-last_seen_at','id')
    if not include_stale:links=links.filter(status='current')
    total_links=links.count()
    links=links[:limit]
    return {'interfaces':[interface_payload(row) for row in interfaces],
            'links':[link_payload(row) for row in links],
            'links_truncated':total_links>limit}
