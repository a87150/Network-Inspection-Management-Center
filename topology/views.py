import hashlib
import json
from django.contrib.auth.decorators import login_required
from django.core.paginator import Paginator
from django.db.models import Q
from django.http import HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_GET

from net.infrastructure.sanitization import sanitize
from net.models import NetworkTopologyInterface, NetworkTopologyLink, NetworkTopologyObservation, TopologyDiscoveryBatch
from net.topology.read_model import current_topology_payload, interface_payload, link_payload

# 证据列宽。超过去以后以前是直接对 JSON 字符串切片，切在中间就是半截 JSON。
EVIDENCE_MAX_CHARS=65536
EVIDENCE_PREVIEW_CHARS=4096


def _evidence_body(value):
    """证据超过列宽时给一个合法的截断信封：仍可 parse，仍带摘要。

    原来直接 json.dumps(...)[:65536]，超长时前端 JSON.parse 必然抛错，整页证据打不开。
    现在超长返回 {truncated, sha256, bytes, preview}，前端照旧 parse 这个字符串即可。
    """
    text=json.dumps(value,ensure_ascii=False,default=str)
    if len(text)<=EVIDENCE_MAX_CHARS:
        return text
    encoded=text.encode('utf-8')
    return json.dumps({'truncated':True,'sha256':hashlib.sha256(encoded).hexdigest(),
                       'bytes':len(encoded),'preview':text[:EVIDENCE_PREVIEW_CHARS]},ensure_ascii=False)


def _page(request, queryset, serializer):
    try: page_size=max(1,min(int(request.GET.get('page_size',50)),500))
    except (TypeError,ValueError):page_size=50
    try: page_number=max(1,int(request.GET.get('page',1)))
    except (TypeError,ValueError):page_number=1
    paginator=Paginator(queryset,page_size)
    page=paginator.get_page(page_number)
    return JsonResponse({'results':[serializer(row) for row in page.object_list],
        'pagination':{'page':page.number,'page_size':page_size,'count':paginator.count,'pages':paginator.num_pages}})


@login_required
@require_GET
def topology_data(request):
    # limit 的解析与钳制收在 read_model._bounded_limit 里：?limit=abc 回落默认值。
    return JsonResponse(current_topology_payload(include_stale=request.GET.get('include_stale')=='1',limit=request.GET.get('limit')))


@login_required
@require_GET
def topology_interfaces(request):
    # interface_payload 只读 device_id 列值，不读 device 对象，所以不 join。
    queryset=NetworkTopologyInterface.objects.order_by('device_id','stable_key')
    if request.GET.get('device_id'):queryset=queryset.filter(device_id=request.GET['device_id'])
    return _page(request,queryset,interface_payload)


@login_required
@require_GET
def topology_links(request):
    queryset=NetworkTopologyLink.objects.select_related(
        'local_interface','remote_interface').order_by('-last_seen_at','id')
    if request.GET.get('include_stale')!='1':queryset=queryset.filter(status='current')
    if request.GET.get('device_id'):
        # 两侧都是多对一外键，一条链路只可能命中一次，不需要 distinct()。原来用 | 拼两个
        # queryset 再 distinct()，Paginator 计数就成了 COUNT(*) FROM (SELECT DISTINCT ...)，
        # 对含 JSON 列的整行去重，等于每翻一页建一次临时表。
        device_id=request.GET['device_id']
        queryset=queryset.filter(Q(local_interface__device_id=device_id)|Q(remote_device_id=device_id))
    return _page(request,queryset,link_payload)


@login_required
@require_GET
def topology_batches(request):
    queryset=TopologyDiscoveryBatch.objects.order_by('-started_at','id')
    if request.GET.get('device_id'):queryset=queryset.filter(device_id=request.GET['device_id'])
    def serialize(row):
        return {'id':str(row.pk),'source_task_id':str(row.source_task_id),'source_target_id':str(row.source_target_id),
                'device_id':str(row.device_id),'protocol':row.protocol,'status':row.status,'schema_version':row.schema_version,
                'started_at':row.started_at.isoformat(),'collected_at':row.collected_at.isoformat() if row.collected_at else None,
                'finished_at':row.finished_at.isoformat() if row.finished_at else None,'message':row.message,
                'interface_count':row.interface_count,'observation_count':row.observation_count,
                'resolved_count':row.resolved_count,'unresolved_count':row.unresolved_count,'conflict_count':row.conflict_count}
    return _page(request,queryset,serialize)


@login_required
@require_GET
def topology_evidence(request, pk):
    if not request.user.has_perm('net.view_topology_evidence'):
        return HttpResponseForbidden('需要拓扑原始证据查看权限。')
    row=get_object_or_404(NetworkTopologyObservation,pk=pk)
    try:evidence=json.loads(row.evidence)
    except (TypeError,ValueError):evidence=row.evidence
    safe=sanitize(evidence)
    response=JsonResponse({'id':str(row.pk),'batch_id':str(row.batch_id),'protocol':row.protocol,
                           'neighbor':sanitize(row.neighbor),'evidence':_evidence_body(safe),
                           'evidence_sha256':row.evidence_sha256,'collected_at':row.collected_at.isoformat()})
    response['Cache-Control']='no-store'
    return response
