"""列表页顶部的指标条：一次聚合算出，不把整表拉进 Python。

这些数字以前只出现在 /people/statistics/ 这类独立页面，用户要对照列表就得来回跳。
搬进工作区之后，页面一进来就能看到规模，不用再单开一页。
"""
from django.db.models import Count, Q
from django.utils import timezone

from net.models import People


def people_overview():
    """在职率、当年入职/离职、平均司龄。与 people_statistics 同一套口径。"""
    as_of = timezone.localdate()
    counts = People.objects.aggregate(
        total=Count('pk'),
        active=Count('pk', filter=Q(is_active=True)),
        departed=Count('pk', filter=Q(is_active=False)),
        hires_this_year=Count(
            'pk', filter=Q(hire_date__year=as_of.year, hire_date__lte=as_of),
        ),
        departures_this_year=Count(
            'pk',
            filter=Q(
                is_active=False,
                departure_date__year=as_of.year,
                departure_date__lte=as_of,
            ),
        ),
    )
    valid_hire_dates = list(People.objects.filter(
        is_active=True,
        hire_date__isnull=False,
        hire_date__lte=as_of,
).values_list('hire_date', flat=True))
    average_tenure = (
        round(
            sum((as_of - hire_date).days for hire_date in valid_hire_dates)
            / len(valid_hire_dates)
            / 365.25,
            1,
        )
        if valid_hire_dates else 0.0
    )
    return {
        **counts,
        'active_rate': (
            round(counts['active'] * 100 / counts['total'], 1)
            if counts['total'] else 0.0
        ),
        'average_active_tenure_years': average_tenure,
        'tenure_sample_count': len(valid_hire_dates),
    }




def department_totals():
    """部门分布。原来只在统计页出现，现在和人员列表同屏。"""
    merged = {}
    for group in People.objects.values('department').annotate(
        total=Count('pk'),
        active=Count('pk', filter=Q(is_active=True)),
    ):
        name = (group['department'] or '').strip() or '未分配部门'
        row = merged.setdefault(name, {'department': name, 'total': 0, 'active': 0})
        row['total'] += group['total']
        row['active'] += group['active']
    rows = []
    for row in merged.values():
        row['departed'] = row['total'] - row['active']
        row['active_rate'] = round(row['active'] * 100 / row['total'], 1)
        rows.append(row)
    rows.sort(key=lambda item: (-item['total'], item['department']))
    return rows

def device_overview(kind, model):
    """总数、启用数、厂商数；People 以外三类设备共用。"""
    # Server 没有 vendor 字段，采集方式在 server_type 里。
    if kind == 'computers':
        aggregates = {
            'total': Count('pk'),
            'active': Count('pk', filter=Q(is_active=True)),
        }
    elif kind == 'servers':
        aggregates = {
            'total': Count('pk'),
            'active': Count('pk', filter=Q(is_enabled=True)),
            'variants': Count('server_type', distinct=True),
            'models': Count('model', filter=~Q(model=''), distinct=True),
        }
    else:
        aggregates = {
            'total': Count('pk'),
            'active': Count('pk', filter=Q(is_enabled=True)),
            'variants': Count('vendor', filter=~Q(vendor=''), distinct=True),
            'models': Count('model', filter=~Q(model=''), distinct=True),
        }
    metrics = model.objects.aggregate(**aggregates)
    metrics.setdefault('variants', 0)
    metrics.setdefault('models', 0)
    metrics['disabled'] = max(0, metrics['total'] - metrics['active'])
    metrics['variant_label'] = '采集方式' if kind == 'servers' else '厂商'
    metrics['active_rate'] = (
        round(metrics['active'] * 100 / metrics['total'], 1)
        if metrics['total'] else 0.0
    )
    return metrics


def _device_status_counts(kind, page):
    """每台设备的当前状态：总数取资产表，异常取最新一条巡检记录。"""
    from django.db.models import OuterRef, Subquery

    asset = page.asset_field
    asset_model = page.model._meta.get_field(asset).related_model
    latest_severity = (
        page.model.objects
        .filter(**{asset: OuterRef('pk')})
        .order_by('-created_at', '-pk')
        .values('report_severity')[:1]
    )
    queryset = asset_model.objects.annotate(_latest_severity=Subquery(latest_severity))
    return {
        'devices': queryset.count(),
        'abnormal': queryset.filter(
            _latest_severity__in=('warning', 'critical'),
        ).count(),
    }


def record_block_lines(kind):
    """巡检记录方块的统计行：任务总数、成功数、涉及设备数。

    三个设备页共用；PC 页有自己的分析统计，不走这里。
    """
    from django.db.models import Count, Q

    from net.inspections.task_summary import project_task_queryset
    from net.models import TaskRun

    stats = project_task_queryset(kind).aggregate(
        tasks=Count('pk'),
        done=Count('pk', filter=Q(status=TaskRun.Status.SUCCESS)),
    )
    tasks = stats['tasks'] or 0
    done = stats['done'] or 0
    rate = round(done * 100 / tasks, 1) if tasks else 0.0
    # 设备侧的现状：和 PC 方块一样的口径，正常/异常按最新快照的严重级别分。
    from inspections.records import RECORD_PAGES

    page = RECORD_PAGES.get(kind)
    devices = normal = abnormal = 0
    if page:
        # 记录表一行是一次巡检，不是一台设备：直接 Count('pk') 会让重跑过的
        # 设备重复计数（12 台各跑 3 次会显示成 36 台）。台数取资产表，
        # 异常按每台设备**最新**那条记录的严重级别判断，和列表页口径一致。
        device_stats = _device_status_counts(kind, page)
        devices = device_stats['devices']
        abnormal = device_stats['abnormal']
        normal = devices - abnormal
    device_rate = round(abnormal * 100 / devices, 1) if devices else 0.0
    return [
        [{'text': '任务 '}, {'text': str(tasks), 'tone': 'success'},
         {'text': ' 个 · 成功 '},
         {'text': str(done), 'tone': 'success' if done else ''}, {'text': ' 个'}],
        [{'text': '正常 '}, {'text': str(normal), 'tone': 'success'},
         {'text': ' 台 · 异常 '},
         {'text': str(abnormal), 'tone': 'danger' if abnormal else ''}, {'text': ' 台'}],
        [{'text': '整体异常率 %s%% · 成功率 %s%%' % (device_rate, rate)}],
    ]