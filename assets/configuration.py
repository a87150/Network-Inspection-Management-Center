"""GET-only exports over saved snapshots and the asset table's query allowlist."""
from tempfile import SpooledTemporaryFile
from urllib.parse import quote
from uuid import UUID

from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from index.common.table_query import apply_table_filters
from index.common.access import admin_required
from index.common.table_registry import get_table_definition
from net.data_exchange.configuration import build_configuration_zip, latest_configuration
from net.models import Network_Device, WeakCurrentDevice


def _model(kind):
    model = {'networks': Network_Device, 'weakcurrent': WeakCurrentDevice}.get(kind)
    if model is None:
        raise Http404('不支持此资产类型的配置导出。')
    return model


def _response(content, media_type, filename='', status=200):
    response = HttpResponse(content, content_type=media_type, status=status)
    response['Cache-Control'] = 'no-store'
    response['X-Content-Type-Options'] = 'nosniff'
    if filename:
        response['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(filename, safe='')}"
    return response


def _configuration_response(asset):
    result = latest_configuration(asset)
    if result.status != 'success':
        status = 404 if result.status == 'missing' else 409
        return _response(result.message, 'text/plain; charset=utf-8', status=status)
    return _response(result.content, result.media_type, result.filename)


MAX_ZIP_ASSETS = 500


def _selected_ids(request):
    """返回 (ids, error)。ids 为 None 表示没带筛选，导出全部。"""
    raw = request.GET.get('target_ids')
    if raw is None:
        return None, None
    values = [value.strip() for value in raw.split(',') if value.strip()]
    if not values:
        return (), '请选择有效的设备。'
    if len(values) > MAX_ZIP_ASSETS:
        # 超限不是「没选」：原来两件事都回「请选择有效的设备」，用户按提示重选还是过不去。
        return (), '一次最多导出 %d 台设备，当前选了 %d 台。' % (MAX_ZIP_ASSETS, len(values))
    try:
        return tuple(dict.fromkeys(UUID(value) for value in values)), None
    except (TypeError, ValueError):
        return (), '设备标识无效，请刷新列表后重新选择。'


@never_cache
@admin_required
@require_GET
def configuration_download(request, kind, pk):
    asset = get_object_or_404(_model(kind), pk=pk)
    return _configuration_response(asset)


@never_cache
@admin_required
@require_GET
def configuration_zip(request, kind):
    model = _model(kind)
    selected_ids, selection_error = _selected_ids(request)
    if selection_error is not None:
        return _response(selection_error, 'text/plain; charset=utf-8', status=400)
    if selected_ids is not None:
        assets = model.objects.filter(pk__in=selected_ids)
        if len(selected_ids) == 1:
            asset = assets.first()
            if asset is None:
                return _response('所选设备不存在。', 'text/plain; charset=utf-8', status=404)
            return _configuration_response(asset)
    else:
        assets, _ = apply_table_filters(request, model.objects.all(),
                                        get_table_definition(kind), include_legacy_status=False)
    # 几百台设备的压缩包可能有上百 MB；写进 SpooledTemporaryFile（超过 8 MB
    # 自动落盘），再由 FileResponse 分块发送。
    archive = SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode='w+b')
    build_configuration_zip(assets, sink=archive)
    response = FileResponse(archive, as_attachment=True,
                            filename=f'{kind}-configurations.zip',
                            content_type='application/zip')
    response['Cache-Control'] = 'no-store'
    response['X-Content-Type-Options'] = 'nosniff'
    return response
