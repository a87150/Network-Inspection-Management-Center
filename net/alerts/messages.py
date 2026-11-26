"""Normalize persisted alert events into transport-neutral messages."""

from net.infrastructure.sanitization import sanitize

from .base import AlertMessage


def _display(value):
    # Scrub structured facts before string conversion preserves only their repr.
    return str(sanitize(value))


def _finding_text(finding):
    title = _display(finding.get('title') or finding.get('key') or 'Unknown finding')
    severity = _display(finding.get('severity') or 'unknown')
    detail = _display(finding.get('detail') or '')
    return f'[{severity}] {title}' + (f': {detail}' if detail else '')


def _asset_identity(target_type, target_id):
    """设备名与地址；不同资产类型的字段名不一样，取不到就用空串。"""
    from assets.maintenance import TARGET_MODELS
    model = TARGET_MODELS.get(target_type)
    if model is None:
        return '', ''
    row = model.objects.filter(pk=target_id).values(
        'ip' if target_type in ('server', 'monitor') else 'ip',
        'name' if target_type == 'server' else 'device_name',
    ).first() if target_type != 'monitor' else None
    if row is None:
        return '', ''
    return str(row.get('name') or row.get('device_name') or ''), str(row.get('ip') or '')


def build_alert_message(event, channel=None, template=None):
    """Build one message containing the event's complete run-target context.

    ``template`` 是建投递行时就定下的那套模板（告警策略里配的「模板 × 渠道」
    配对，随任务一起冻结）。传了就用它；没传才回落到按渠道现查，再回落到
    事件生成那一刻的渲染快照。
    """
    event_type = _display(event.event_type)
    if event_type == 'summary':
        from .templates import render_task_summary, resolve_template
        data = dict(getattr(event, 'summary_data', None) or {})
        detail_url = _display(data.get('details_url') or f'/tasks/{event.task_id}/')
        data['details_url'] = detail_url
        # 投递行带了模板就用它；没带才回落到事件生成时的渲染快照。
        template = template or (resolve_template(channel, 'summary')
                                if channel is not None else None)
        if template is not None:
            rendered = render_task_summary(data, template=template)
            return AlertMessage(title=rendered['title'], text=rendered['text'],
                                facts={'event_type': 'summary'}, detail_url=detail_url)
        title, text = data.get('message_title'), data.get('message_text')
        if not isinstance(title, str) or not isinstance(text, str):
            # Legacy summaries must never pick up edits made after the event.
            defaults = render_task_summary(data, template={})
            title = title if isinstance(title, str) else defaults['title']
            text = text if isinstance(text, str) else defaults['text']
        return AlertMessage(title=title, text=text,
                            facts={'event_type': 'summary'}, detail_url=detail_url)
    # 单设备通知：带了模板就按模板渲染，否则回落到下面的通用格式。
    from .templates import render_device_alert, resolve_template
    device_template = template or (resolve_template(channel, 'device')
                                   if channel is not None else None)
    if device_template is not None:
        target_type = _display(event.target_type)
        device_name, device_ip = _asset_identity(target_type, str(event.target_id))
        issues = [
            {'title': _display(item.get('title') or item.get('key') or ''),
             'detail': _display(item.get('detail') or '')}
            for item in (event.findings or [])
        ]
        rendered = render_device_alert({
            'device_name': device_name or str(event.target_id),
            'device_ip': device_ip,
            'target_type': target_type,
            'status': _display(event.event_type),
            'tasks_name': _display(getattr(event.task, 'profile_snapshot', {}).get('name') or ''),
            'occurred_at': _display(event.occurred_at.isoformat() if hasattr(event.occurred_at, 'isoformat') else event.occurred_at),
            'details_url': f'/alerts/{_display(event.id)}/',
            'issues': issues,
            'recovered_count': len(issues),
        }, template=device_template)
        return AlertMessage(
            title=rendered['title'], text=rendered['text'],
            facts={'event_type': event_type, 'target_type': target_type},
            detail_url=f'/alerts/{_display(event.id)}/',
        )
    findings = list(event.findings or [])
    finding_titles = [_display(item.get('title') or item.get('key') or 'Unknown finding') for item in findings]
    project = f'{_display(event.profile_type)}/{_display(event.profile_id)}'
    target = f'{_display(event.target_type)}/{_display(event.target_id)}'
    run_time = _display(event.occurred_at.isoformat() if hasattr(event.occurred_at, 'isoformat') else event.occurred_at)
    detail_url = f'/alerts/{_display(event.id)}/'

    if event_type == 'recovery':
        title = 'Recovery alert' + (f': {", ".join(finding_titles)}' if finding_titles else '')
    else:
        title = 'Abnormal alert' + (f': {", ".join(finding_titles)}' if finding_titles else '')

    lines = [
        f'Event: {event_type}',
        f'Project: {project}',
        f'Target: {target}',
        f'Run time: {run_time}',
    ]
    if event_type == 'recovery':
        lines.append('Recovered finding(s): ' + (', '.join(finding_titles) or 'none recorded'))
    lines.append('Merged findings:')
    lines.extend(f'- {_finding_text(finding)}' for finding in findings)
    if event.summary:
        lines.append(f'Summary: {_display(event.summary)}')
    lines.append(f'Details: {detail_url}')
    return AlertMessage(
        title=title,
        text='\n'.join(lines),
        facts={
            'event_type': event_type,
            'project': project,
            'target': target,
            'run_time': run_time,
            'findings': ', '.join(finding_titles),
        },
        detail_url=detail_url,
    )
