"""Detail payload for the PC log page."""
import json

from django.urls import reverse
from django.utils import timezone

from index.common.badges import status_badge
from index.common.detail_payload import (
    code_section, detail_payload, field_section,
)


def _stamp(value, fmt='%Y-%m-%d %H:%M:%S'):
    return timezone.localtime(value).strftime(fmt) if value else '-'


def computer_log_detail_payload(*, log, analyses):
    # 分析历史和返回列表按钮都去掉了：日志详情本身就是终点，
    # 日志原文直接铺开，不再塞进折叠块里。
    return detail_payload(
        title='日志详情 #%s' % log.pk,
        eyebrow='PC 日志',
        description='日志内容只读；分析由手动或定时任务按每台 PC 最新日志执行。',
        sections=[
            field_section('日志概览', [
                ('PC', (log.computer.computer_name if log.computer_id else '') or '未知'),
                ('采集时间', _stamp(log.collected_at)),
                ('平台', log.platform or '-'),
                ('内容哈希', log.content_hash),
            ]),
            code_section(
                '已脱敏日志内容',
                json.dumps(log.payload, ensure_ascii=False, indent=2, sort_keys=True),
            ),
        ],
    )
