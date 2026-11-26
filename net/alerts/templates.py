"""Plain-text task summaries. Explicit configuration never reads the database."""
import json
import re
from collections.abc import Mapping

from django.core.exceptions import ValidationError

from net.infrastructure.sanitization import sanitize


TEMPLATE_KEY = 'task_summary'
VARIABLES = (
    'task_name', 'task_status', 'task_type', 'total', 'normal', 'abnormal',
    'recovered', 'failed', 'cancelled', 'skipped', 'info', 'started_at',
    'finished_at', 'duration', 'details_url', 'issues', 'recoveries',
)
MODE_CHOICES = (('compact', '简洁'), ('detailed', '详细'))
MAX_TITLE_LENGTH = 255
MAX_TEXT_BYTES = 12000
MAX_JSON_TEXT_BYTES = 16000
MAX_BODY_TEMPLATE_LENGTH = 4000
MAX_ITEMS = 5
_VARIABLE = re.compile(r'\{([a-z_]+)\}')
_COUNTS = {'total', 'normal', 'abnormal', 'recovered', 'failed', 'cancelled', 'skipped', 'info'}
_COMPACT_BODY = (
    '任务：{task_name}\n状态：{task_status} · 类型：{task_type}\n'
    '总数 {total} · 正常 {normal} · 异常 {abnormal} · 恢复 {recovered}\n'
    '失败 {failed} · 取消 {cancelled} · 跳过 {skipped} · 提示 {info}\n'
    '耗时：{duration}'
)
PRESETS = {
    'compact': {'title_template': '任务总结：{task_name} · {task_status}', 'body_template': _COMPACT_BODY},
    'detailed': {'title_template': '任务总结：{task_name} · {task_status}',
                 'body_template': _COMPACT_BODY + '\n开始：{started_at}\n结束：{finished_at}'
                 '\n问题摘要（最多 5 项）：\n{issues}\n恢复摘要（最多 5 项）：\n{recoveries}'},
}

# 单设备告警的变量集与汇总完全不同：它描述一台机器，不是一次任务。
DEVICE_VARIABLES = (
    'device_name', 'device_ip', 'target_type', 'status', 'tasks_name',
    'occurred_at', 'details_url', 'issues', 'recovered_count',
)
DEVICE_COUNTS = {'recovered_count'}
_DEVICE_BODY = (
    '设备：{device_name}（{device_ip}）\n类型：{target_type}\n'
    '状态：{status}\n时间：{occurred_at}\n问题：\n{issues}'
)
DEVICE_PRESETS = {
    'compact': {'title_template': '设备异常：{device_name}', 'body_template': _DEVICE_BODY},
    'detailed': {'title_template': '设备异常：{device_name} · {device_ip}',
                 'body_template': _DEVICE_BODY + '\n所属任务：{tasks_name}\n累计恢复：{recovered_count}'},
}


def validate_template(value, variables=None):
    """Accept only literal text and exact {whitelisted_name} tokens."""
    if not isinstance(value, str):
        raise ValidationError('模板必须为文本。')
    allowed = VARIABLES if variables is None else variables
    names = _VARIABLE.findall(value)
    if any(name not in allowed for name in names):
        raise ValidationError('模板含未知变量，请使用下方列出的变量。')
    remainder = _VARIABLE.sub('', value)
    if '{' in remainder or '}' in remainder:
        raise ValidationError('仅支持简单 {变量名}；不支持属性、索引、格式、转换或嵌套花括号。')


def get_task_summary_template():
    """任务汇总的默认模板；保留给只看内容、不关心渠道的调用方。"""
    return default_template('summary')


def default_template(trigger):
    """该 trigger 的默认模板；没有就返回 None，由渲染层回落到内置预设。"""
    from net.models import AlertNotificationTemplate
    return AlertNotificationTemplate.objects.filter(
        trigger=trigger, is_default=True).first()


def resolve_template(channel, trigger, policy=None):
    """策略路由优先，其次该 trigger 的默认模板。

    模板和渠道的配对配在告警策略上（AlertPolicyRoute）：同一条渠道可以在不同
    策略里用不同模板，(policy, channel, trigger) 唯一，所以最多命中一条 ——
    「发哪个」不存在歧义。没给策略时退回默认模板。
    """
    if policy is not None and getattr(policy, 'pk', None):
        if channel is not None and getattr(channel, 'pk', None):
            route = policy.routes.filter(
                channel=channel, trigger=trigger).select_related('template').first()
            if route is not None:
                return route.template
    return default_template(trigger)


def template_variables(trigger):
    return DEVICE_VARIABLES if trigger == 'device' else VARIABLES


def _clip(value, limit):
    value = str(value)
    encoded = value.encode('utf-8')
    if len(encoded) <= limit:
        return value
    return encoded[:max(0, limit - 3)].decode('utf-8', errors='ignore') + '…'


def _safe_text(value, limit=600):
    if value is None:
        return ''
    if not isinstance(value, (str, int, float, bool)):
        return ''
    # Scrub before clipping so a truncated assignment cannot expose its secret.
    return _clip(sanitize(str(value)), limit)


def _json_size(value):
    # requests uses ensure_ascii=True; emoji take 12 bytes in that payload.
    return len(json.dumps(value, ensure_ascii=True)) - 2


def _bounded_body(value, footer):
    raw_budget = MAX_TEXT_BYTES - len(footer.encode('utf-8'))
    wire_budget = MAX_JSON_TEXT_BYTES - _json_size(footer)
    if min(raw_budget, wire_budget) < 6:
        raise ValidationError('任务详情地址过长，无法在通知长度限制内完整保留。')
    value = _clip(value, raw_budget)
    if _json_size(value) > wire_budget:
        low, high = 0, len(value)
        while low < high:
            middle = (low + high + 1) // 2
            if _json_size(value[:middle] + '…') <= wire_budget:
                low = middle
            else:
                high = middle - 1
        value = value[:low] + '…'
    return value + footer


def _items(value):
    if not value:
        return '无'
    if isinstance(value, str):
        value = [line.strip() for line in value.splitlines() if line.strip()]
    if not isinstance(value, (list, tuple)):
        return _safe_text(value, 1200) or '无'
    lines = []
    for item in value[:MAX_ITEMS]:
        if isinstance(item, Mapping):
            # Do not copy arbitrary provider payloads into notifications.
            parts = [_safe_text(item.get(key), 240) for key in
                     ('target_name', 'target_id', 'severity', 'title', 'detail', 'message', 'summary')]
            text = ' · '.join(part for part in parts if part)
        else:
            text = _safe_text(item, 360)
        if text:
            lines.append('- ' + _clip(text.replace('\r', ' ').replace('\n', ' '), 360))
    if len(value) > MAX_ITEMS:
        lines.append(f'另有 {len(value) - MAX_ITEMS} 项，请查看任务详情。')
    return '\n'.join(lines) or '无'


def render_task_summary(data, template=None):
    """Return bounded title/text; pass {} for defaults with no live-template read.

    ``template`` accepts the singleton model or a mapping. Invalid persisted
    custom fields degrade to the mode preset; the settings form rejects them.
    """
    if template is None:
        template = get_task_summary_template()
    if isinstance(template, Mapping):
        config = template
    else:
        config = {key: getattr(template, key, '') for key in ('mode', 'title_template', 'body_template')}
    mode = config.get('mode', 'compact')
    if mode not in PRESETS:
        mode = 'compact'
    data = data if isinstance(data, Mapping) else {}
    values = {key: _safe_text(data.get(key, 0 if key in _COUNTS else ''))
              for key in VARIABLES if key not in ('details_url', 'issues', 'recoveries')}
    # Task URLs are complete navigation targets, never shortened with ellipses.
    values['details_url'] = str(sanitize(data.get('details_url') or ''))
    for key in ('issues', 'recoveries'):
        values[key] = _items(data.get(key))
    rendered = {}
    for field, output, max_length in (('title_template', 'title', 255),
                                       ('body_template', 'text', MAX_BODY_TEMPLATE_LENGTH)):
        source = config.get(field) or PRESETS[mode][field]
        try:
            validate_template(source)
            if len(source) > max_length:
                raise ValidationError('模板过长。')
        except ValidationError:
            source = PRESETS[mode][field]
        rendered[output] = _VARIABLE.sub(lambda match: values[match[1]], source)
    rendered['title'] = _clip(rendered['title'].replace('\r', ' ').replace('\n', ' ')[:MAX_TITLE_LENGTH], 768)
    footer = '\n完整结果请查看任务详情：' + (values['details_url'] or '任务记录页面')
    rendered['text'] = _bounded_body(rendered['text'], footer)
    return rendered


def render_device_alert(data, template=None):
    """单台设备的异常通知；变量集与任务汇总不同。

    维护窗口里的设备不会走到这里 —— 调用方在入队前已经筛掉了。
    """
    if template is None:
        template = default_template('device')
    if isinstance(template, Mapping):
        config = template
    else:
        config = {key: getattr(template, key, '') for key in ('mode', 'title_template', 'body_template')}
    mode = config.get('mode', 'compact')
    if mode not in DEVICE_PRESETS:
        mode = 'compact'
    data = data if isinstance(data, Mapping) else {}
    values = {
        key: _safe_text(data.get(key, 0 if key in DEVICE_COUNTS else ''))
        for key in DEVICE_VARIABLES
        if key not in ('details_url', 'issues', 'tasks_name')
    }
    values['details_url'] = str(sanitize(data.get('details_url') or ''))
    values['tasks_name'] = _safe_text(data.get('tasks_name'), 120)
    values['issues'] = _items(data.get('issues'))
    rendered = {}
    for field, output, max_length in (('title_template', 'title', MAX_TITLE_LENGTH),
                                       ('body_template', 'text', MAX_BODY_TEMPLATE_LENGTH)):
        source = config.get(field) or DEVICE_PRESETS[mode][field]
        try:
            validate_template(source, DEVICE_VARIABLES)
            if len(source) > max_length:
                raise ValidationError('模板过长。')
        except ValidationError:
            source = DEVICE_PRESETS[mode][field]
        rendered[output] = _VARIABLE.sub(lambda match: values[match[1]], source)
    rendered['title'] = _clip(rendered['title'].replace('\r', ' ').replace('\n', ' ')[:MAX_TITLE_LENGTH], 768)
    footer = '\n设备详情：' + (values['details_url'] or '资产页面')
    rendered['text'] = _bounded_body(rendered['text'], footer)
    return rendered
