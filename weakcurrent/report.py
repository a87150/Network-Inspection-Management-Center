"""门禁通行报表：按周期汇总，定期推送到已配置的告警渠道。"""

from datetime import timedelta

from django.db.models import Count, Max, Q
from django.db.models.expressions import RawSQL
from django.utils import timezone

from net.alerts import send_alert
from net.models.access import AccessRecord, AccessReportConfig


def build_report(days=7, now=None):
    """按平台和日期汇总区间内的通行记录。"""
    now = now or timezone.now()
    start = now - timedelta(days=days)
    rows = AccessRecord.objects.filter(occurred_at__gte=start, occurred_at__lte=now)
    by_source = list(
        rows.values('source__name').annotate(
            total=Count('pk'),
            passed=Count('pk', filter=Q(result=AccessRecord.Result.PASSED)),
            denied=Count('pk', filter=Q(result=AccessRecord.Result.DENIED)),
            latest=Max('occurred_at'),
        ).order_by('-total'),
    )
    # TruncDay 要数据库装了时区表，这套 MariaDB 没装；DATE() 一样够用。
    by_day = list(
        rows.annotate(day=RawSQL('DATE(occurred_at)', []))
        .values('day').annotate(total=Count('pk')).order_by('day')
    )
    return {
        'generated_at': now.isoformat(),
        'range_days': days,
        'starts_at': start.isoformat(),
        'total': rows.count(),
        'denied': rows.filter(result=AccessRecord.Result.DENIED).count(),
        'sources': [
            {
                'name': row['source__name'],
                'total': row['total'],
                'passed': row['passed'],
                'denied': row['denied'],
                'latest': row['latest'].isoformat() if row['latest'] else None,
            }
            for row in by_source
        ],
        'days': [
            {
                'day': row['day'].isoformat() if hasattr(row['day'], 'isoformat') else str(row['day']),
                'total': row['total'],
            }
            for row in by_day
        ],
    }


def report_text(report):
    """推送给渠道的纯文本，够看就行，不铺 HTML。"""
    lines = [
        '门禁通行报表',
        '统计区间：最近 %s 天' % report['range_days'],
        '通行总数：%s 条，其中拒绝 %s 条' % (report['total'], report['denied']),
    ]
    for item in report['sources']:
        lines.append('- %s：%s 条（通过 %s / 拒绝 %s）' % (
            item['name'], item['total'], item['passed'], item['denied'],
        ))
    return '\n'.join(lines)


def send_due_reports(now=None):
    """到点就发一次，返回是否真的发出去了。入口是 send_access_reports 命令。"""
    config = AccessReportConfig.load()
    now = now or timezone.now()
    if not config.is_due(now):
        return False
    from net.models.alerts import AlertChannel

    channel = AlertChannel.objects.filter(pk=config.channel_id).first()
    if channel is None:
        return False
    report = build_report(config.range_days, now=now)
    result = send_alert(channel, {'title': '门禁通行报表', 'text': report_text(report)})
    if not result.success:
        # 发失败不推进 last_sent_at，下一轮定时任务还会重试，不会白丢一个周期。
        return False
    config.last_sent_at = now
    config.save(update_fields=['last_sent_at', 'updated_at'])
    return True