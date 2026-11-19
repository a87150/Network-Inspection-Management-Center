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
        }
    else:
        aggregates = {
            'total': Count('pk'),
            'active': Count('pk', filter=Q(is_enabled=True)),
            'variants': Count('vendor', filter=~Q(vendor=''), distinct=True),
        }
    metrics = model.objects.aggregate(**aggregates)
    metrics.setdefault('variants', 0)
    metrics['variant_label'] = '采集方式' if kind == 'servers' else '厂商'
    metrics['active_rate'] = (
        round(metrics['active'] * 100 / metrics['total'], 1)
        if metrics['total'] else 0.0
    )
    return metrics
