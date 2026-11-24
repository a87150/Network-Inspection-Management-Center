"""网络设备工作区页的 bootstrap；装配逻辑见 index.common.device_payload。"""
from index.common.device_payload import build
from net.models import Network_Device


def network_bootstrap(request, only=None):
    """only 指定只算哪几块；不给就全算。"""
    return build(
        request,
        kind='networks',
        title='网络设备',
        model=Network_Device,
        empty_title='暂无网络设备',
        only=only,
    )