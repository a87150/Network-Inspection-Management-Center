"""服务器工作区页的 bootstrap；装配逻辑见 index.common.device_payload。"""
from index.common.device_payload import build
from net.models import Server


def server_bootstrap(request, only=None):
    """only 指定只算哪几块；不给就全算。"""
    return build(
        request,
        kind='servers',
        title='服务器',
        model=Server,
        empty_title='暂无服务器',
        only=only,
    )