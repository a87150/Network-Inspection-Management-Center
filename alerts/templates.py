"""Administrator-only task-summary template editor and local preview."""
from django import forms
from django.shortcuts import render
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from index.common.access import admin_required
from net.alerts.templates import (
    MAX_BODY_TEMPLATE_LENGTH, MODE_CHOICES, VARIABLES, DEVICE_VARIABLES,
    render_device_alert, render_task_summary,
    template_variables, validate_template,
)


TRIGGER_CHOICES = (('summary', '任务汇总'), ('device', '单设备告警'))


class AlertNotificationTemplateForm(forms.Form):
    name = forms.CharField(label='模板名称', max_length=64,
        widget=forms.TextInput(attrs={'class': 'form-control'}))
    trigger = forms.ChoiceField(label='通知时机', choices=TRIGGER_CHOICES,
        widget=forms.Select(attrs={'class': 'form-select'}))
    mode = forms.ChoiceField(label='展示模式', choices=MODE_CHOICES,
                            widget=forms.Select(attrs={'class': 'form-select'}))
    title_template = forms.CharField(label='自定义标题', max_length=255, required=False,
        widget=forms.TextInput(attrs={'class': 'form-control'}))
    body_template = forms.CharField(label='自定义正文', max_length=MAX_BODY_TEMPLATE_LENGTH,
        required=False, widget=forms.Textarea(attrs={'class': 'form-control', 'rows': 6}))

    def clean(self):
        cleaned = super().clean()
        # 变量集取决于通知时机：汇总用任务维度变量，单设备用设备维度变量。
        allowed = template_variables(cleaned.get('trigger') or 'summary')
        for field in ('title_template', 'body_template'):
            value = cleaned.get(field) or ''
            try:
                validate_template(value, allowed)
            except forms.ValidationError as exc:
                self.add_error(field, exc)
        return cleaned


DEVICE_PREVIEW_DATA = {
    'device_name': '示例服务器 A', 'device_ip': '192.0.2.10',
    'target_type': 'server', 'status': 'abnormal', 'tasks_name': '夜间巡检',
    'occurred_at': '2026-09-09 09:01:30', 'details_url': '/alerts/example/',
    'issues': ['磁盘使用率偏高', '采集失败'], 'recovered_count': 1,
}

PREVIEW_DATA = {
    'task_name': '示例服务器巡检', 'task_status': '部分成功', 'task_type': '服务器巡检',
    'total': 10, 'normal': 7, 'abnormal': 2, 'recovered': 1, 'failed': 1,
    'cancelled': 0, 'skipped': 0, 'info': 0,
    'started_at': '2026-09-09 09:00:00', 'finished_at': '2026-09-09 09:01:30',
    'duration': '90 秒', 'details_url': '/tasks/00000000-0000-0000-0000-000000000001/',
    'issues': ['示例服务器 A：磁盘使用率偏高', '示例服务器 B：采集失败'],
    'recoveries': ['示例服务器 C：CPU 使用率恢复正常'],
}


def _template_or_none(requested):
    from net.models import AlertNotificationTemplate
    if requested:
        row = AlertNotificationTemplate.objects.filter(pk=requested).first()
        if row is not None:
            return row
    # 没指定就落在这个时机的默认模板上（没有默认就取第一条）。
    return (AlertNotificationTemplate.objects.filter(is_default=True).order_by('trigger').first()
            or AlertNotificationTemplate.objects.order_by('trigger', 'name').first())


def _template_groups():
    """按通知时机分组，供弹窗顶部的切换列表使用。"""
    from net.models import AlertNotificationTemplate
    groups = []
    for value, label in TRIGGER_CHOICES:
        rows = AlertNotificationTemplate.objects.filter(trigger=value).order_by('-is_default', 'name')
        if rows:
            groups.append({'value': value, 'label': label, 'templates': list(rows)})
    return groups


@never_cache
@admin_required
@require_http_methods(['GET', 'POST'])
@csrf_protect
def alert_template_settings(request):
    from net.models import AlertNotificationTemplate
    requested = (request.GET.get('template') or request.POST.get('template_id') or '').strip()
    if request.method == 'POST':
        # POST 没带 template_id 就是新建。带上才改现有那条。
        creating = not requested
    else:
        creating = request.GET.get('new') == '1'
    current = None if creating else _template_or_none(requested)
    initial = {
        'name': '' if creating else (getattr(current, 'name', '') or '默认任务汇总'),
        'trigger': getattr(current, 'trigger', 'summary') or 'summary',
        'mode': getattr(current, 'mode', 'compact') or 'compact',
        'title_template': getattr(current, 'title_template', '') or '',
        'body_template': getattr(current, 'body_template', '') or '',
    }
    form = AlertNotificationTemplateForm(
        request.POST if request.method == 'POST' else None,
        initial=initial, auto_id='alert-template-%s')
    saved, preview, status = False, None, 200
    if request.method == 'GET' and not creating and current is not None:
        # 预览走 GET：弹窗内容整体换一版，框不会关，也不会写库。
        if request.GET.get('preview') == '1':
            data = {
                'name': current.name, 'trigger': current.trigger, 'mode': current.mode,
                'title_template': current.title_template or '',
                'body_template': current.body_template or '',
            }
            preview = (render_device_alert(DEVICE_PREVIEW_DATA, template=data)
                       if data['trigger'] == 'device'
                       else render_task_summary(PREVIEW_DATA, template=data))
    if request.method == 'POST':
        action = request.POST.get('action', 'save')
        valid = form.is_valid()
        if action not in ('save', 'preview', 'delete'):
            form.add_error(None, '未知操作，请选择保存、预览或删除。')
            valid = False
        if action == 'delete':
            if current is None:
                status = 404
            elif current.is_default:
                form.add_error(None, '默认模板不能删除；先把别的模板设为默认。')
                status = 400
            else:
                current.delete()
                saved = True
                current = AlertNotificationTemplate.objects.filter(trigger='summary').first()
                form = AlertNotificationTemplateForm(initial={
                    'name': getattr(current, 'name', '') or '默认任务汇总',
                    'trigger': getattr(current, 'trigger', 'summary') or 'summary',
                    'mode': getattr(current, 'mode', 'compact') or 'compact',
                    'title_template': getattr(current, 'title_template', '') or '',
                    'body_template': getattr(current, 'body_template', '') or '',
                }, auto_id='alert-template-%s')
        elif valid:
            data = dict(form.cleaned_data)
            if action == 'save':
                if current is None:
                    current = AlertNotificationTemplate(
                        is_default=not AlertNotificationTemplate.objects.filter(
                            trigger=data['trigger'], is_default=True).exists())
                for field, value in data.items():
                    setattr(current, field, value)
                current.save()
                saved = True
            preview_data = PREVIEW_DATA
            rendered = (render_device_alert(DEVICE_PREVIEW_DATA, template=data)
                        if data['trigger'] == 'device'
                        else render_task_summary(preview_data, template=data))
            preview = rendered
        else:
            status = 400
    if status >= 400 and request.method == 'POST' and request.headers.get('X-Form-Ajax'):
        # 校验失败必须回 JSON：data-form-ajax 只认 application/json 才会把错误留在
        # 框里，回 HTML 会被当成功处理、直接把弹窗关掉，用户看到的就是「保存不了」。
        from django.http import JsonResponse
        errors = [message for messages_ in form.errors.values() for message in messages_]
        errors += [str(message) for message in form.non_field_errors()]
        return JsonResponse({'ok': False, 'errors': errors or ['保存失败，请检查填入内容。']},
                            status=status)
    return render(request, 'alerts/template_modal.html', {
        'template_form': form, 'template_saved': saved, 'template_preview': preview,
        'template_variables': (DEVICE_VARIABLES
                               if initial['trigger'] == 'device' else VARIABLES),
        'template_groups': _template_groups(),
        'current_template_id': str(current.pk) if current is not None else '',
        'template_is_new': creating,
        'template_can_delete': '0' if (current is None or current.is_default) else '1',
    }, status=status)
