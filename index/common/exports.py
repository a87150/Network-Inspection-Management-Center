import copy

from django.core.exceptions import ValidationError
from django.http import Http404
from django.shortcuts import get_object_or_404

from index.common.table_registry import get_table_definition, project_record_definition
from net.data_exchange.table_csv import export_filtered_csv
from net.models import (
    Computer,
    ComputerLogFile,
    Domain_Account,
    Domain_Computer,
    Domain_Group,
    WeakCurrentDevice,
    Network_Device,
    People,
    Server,
    TaskRun,
    TaskTargetRun,
    AlertEvent,
)

from inspections.records import (
    RECORD_PAGES,
    _computer_analysis_records,
    _error_records,
    _infrastructure_records,
    _inspection_records,
)


MODEL_TABLES = {
    'computer_logs': ComputerLogFile,
    'people': People,
    'computers': Computer,
    'networks': Network_Device,
    'servers': Server,
    'weakcurrent': WeakCurrentDevice,
    'domain_accounts': Domain_Account,
    'domain_computers': Domain_Computer,
    'domain_groups': Domain_Group,
    'task_runs': TaskRun,
    'alert_events': AlertEvent,
}


def _table_source(request, table_key, scope):
    if table_key in MODEL_TABLES:
        if scope:
            raise Http404('该表不支持分组导出')
        queryset = MODEL_TABLES[table_key].objects.all()
        if table_key == 'computer_logs':
            queryset = queryset.filter(retained=True)
        if table_key == 'alert_events':
            queryset = queryset.prefetch_related('deliveries__channel')
        return queryset
    if table_key == 'computer_inspections':
        if scope:
            raise Http404('该表不支持分组导出')
        task = None
        if request.GET.get('task'):
            try:
                task = get_object_or_404(TaskRun, pk=request.GET['task'], task_type='computer_analysis')
            except (ValidationError, ValueError):
                raise Http404('任务无效')
        return _computer_analysis_records(request.GET.get('target', '').strip(), task=task)
    if table_key == 'computer_errors':
        if scope:
            raise Http404('该表不支持分组导出')
        from inspections.result_query import computer_queryset
        return computer_queryset().filter(_error_total__gt=0)
    if table_key == 'inspection_records':
        if scope:
            if scope not in RECORD_PAGES:
                raise Http404('未知的巡检类型')
            task = None
            if request.GET.get('task'):
                device_type = {'networks': 'network_device', 'servers': 'server', 'weakcurrent': 'monitor'}[scope]
                try:
                    task = get_object_or_404(TaskRun, pk=request.GET['task'], task_type='inspection',
                                             inspection_profile__device_type=device_type)
                except (ValidationError, ValueError):
                    raise Http404('任务无效')
            return _infrastructure_records(
                scope, target=request.GET.get('target', '').strip(), task=task,
            )
        return _inspection_records()
    if table_key == 'access_records':
        if scope:
            raise Http404('该表不支持分组导出')
        from net.models import AccessRecord
        return AccessRecord.objects.all()
    if table_key == 'error_records' and not scope:
        return _error_records()
    if table_key == 'task_targets' and scope:
        try:
            task = TaskRun.objects.get(pk=scope)
        except (TaskRun.DoesNotExist, ValidationError, ValueError) as exc:
            raise Http404('未知的任务') from exc
        if task.task_type in TaskRun.PEOPLE_INTERACTIVE_TASK_TYPES:
            from people.integrations import require_people_owner
            require_people_owner(request, task)
        return TaskTargetRun.objects.filter(task=task)
    raise Http404('未知的数据表')


# 域对象三张表在页面里用页签前缀（accounts_filter_x）互不打架，导出端点没有页签
# 概念，所以把带前缀的参数补一份无前缀别名，筛选才会真的跟着导出走。
EXPORT_PARAMETER_PREFIXES = {
    'domain_accounts': 'accounts',
    'domain_computers': 'computers',
    'domain_groups': 'groups',
}


def _with_unprefixed_parameters(request, table_key):
    prefix = EXPORT_PARAMETER_PREFIXES.get(table_key)
    if not prefix:
        return request
    data = request.GET.copy()
    for key in list(data):
        if key.startswith(f'{prefix}_'):
            data.setdefault(key[len(prefix) + 1:], data[key])
    if data == request.GET:
        return request
    alias = copy.copy(request)
    alias.GET = data
    return alias


def _selected_only(request, source):
    """导出所选：前端把勾选的主键逗号拼在 target_ids 里，只导这些行。"""
    raw = (request.GET.get('target_ids') or '').strip()
    if not raw:
        return source
    wanted = {value.strip() for value in raw.split(',') if value.strip()}
    if not wanted:
        return source
    if hasattr(source, 'filter'):
        model = getattr(source, 'model', None)
        if model is None:
            return source
        try:
            keys = [model._meta.pk.to_python(value) for value in wanted]
        except (ValidationError, ValueError):
            return source.none()
        return source.filter(pk__in=keys)
    return [row for row in source if str(_row_pk(row)) in wanted]


def _row_pk(row):
    if isinstance(row, dict):
        return row.get('id') or row.get('pk') or ''
    return getattr(row, 'pk', '')


def table_export(request, table_key, scope=''):
    try:
        definition = get_table_definition(table_key)
    except KeyError as exc:
        raise Http404('未知的数据表') from exc
    request = _with_unprefixed_parameters(request, table_key)
    source = _selected_only(request, _table_source(request, table_key, scope))
    if table_key == 'computer_inspections':
        definition = project_record_definition('computers')
    elif table_key == 'inspection_records' and scope in RECORD_PAGES:
        definition = project_record_definition(scope)
    return export_filtered_csv(
        request, definition, source, f'{table_key}.csv',
    )
