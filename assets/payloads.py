"""Detail payload for the shared asset detail page (people, servers, networks, ...)."""
from django.urls import reverse
from django.utils import timezone

from index.common.detail_payload import (
    detail_payload, field_section, text_section,
)


SWITCHABLE_KINDS = frozenset({'networks', 'servers', 'weakcurrent'})


def asset_row_actions(kind, admin):
    """列表行与右侧详情面板共用的按钮组。

    返回一个「记录 -> 动作列表」的工厂，行端点和首屏 payload 都调它，避免两处
    各写一套后按钮权限与跳转开始漂移。
    """
    device_kind = kind in SWITCHABLE_KINDS
    run_label = '手动执行分析' if kind == 'computers' else '手动执行巡检'

    def build(obj):
        # detail_modal 让前端就地弹窗；url 保留，JS 不可用时仍是普通链接。
        entries = [{'kind': 'link', 'label': '查看详情', 'detail_modal': True,
                    'url': reverse('asset_detail', args=[kind, obj.pk])}]
        if admin and device_kind:
            entries.append({'kind': 'link', 'label': '巡检设置', 'variant': 'primary',
                            'url': reverse('device_collection_settings', args=[kind, obj.pk]),
                            'modal_target': 'collectionTemplateModal'})
            # 改配置和手动执行都在弹窗里完成：改配置把 asset_edit 的表单搬进
            # 编辑弹窗，手动执行直接开 runTaskModal，两者都不离开当前页。
            entries.append({'kind': 'link', 'label': '修改配置',
                            'url': reverse('asset_edit', args=[kind, obj.pk]),
                            'modal_target': 'deviceFormModal'})
            entries.append({'kind': 'link', 'label': run_label, 'variant': 'primary',
                            'url': '?task_modal=run&task_single_target=%s' % obj.pk,
                            'single_device_run': True})
        if admin and device_kind:
            entries.append({
                'kind': 'form', 'label': '停用' if obj.is_enabled else '启用',
                'url': reverse('asset_toggle_enabled', args=[kind]),
                'fields': {'pk': str(obj.pk)},
            })
        return entries

    return build

def _latest_section(latest, latest_url):
    if latest is None:
        return text_section('最新执行结果', '尚无执行记录。')
    head = ' · '.join(part for part in (
        timezone.localtime(latest.created_at).strftime('%Y-%m-%d %H:%M:%S'),
        str(latest.execution_status or ''),
        str(latest.task_source or ''),
        '异常 %s' % latest.error_count,
    ) if part)
    body = '\n'.join(part for part in (
        head, str(latest.summary or ''), str(latest.key_metrics or ''),
    ) if part)
    return {
        'heading': '最新执行结果',
        'kind': 'text',
        'text': body,
        'link': None,
    }


def asset_detail_payload(*, kind, item_name, asset, detail_fields, latest_record,
                         latest_url, history_url, back_url, manual_action_label,
                         can_administer):
    # 详情在弹窗里看：跳转类按钮（查看记录 / 手动执行 / 返回列表 / 配置备份）
    # 一点就整页跑掉，全部去掉。弹窗里只留内容。
    actions = []
    sections = [
        field_section('基础资料', [(item['label'], item['value']) for item in detail_fields]),
    ]
    if history_url:
        sections.append(_latest_section(latest_record, latest_url))

    return detail_payload(
        title=item_name + '详情', eyebrow='基础信息', description=str(asset),
        actions=actions, sections=sections,
    )


def configuration_notice(kind):
    """The credential warning shown above the detail card."""
    if kind == 'weakcurrent':
        return (
            '配置备份历史保存设备原文，下载文件可能包含账号、密码等敏感凭据，请妥善保管。'
            '历史页仅展示版本信息，不预览原文；下载已保存版本不会连接设备。'
            '弱电设备目前仅支持 Network 配置节的部分 API，不能提供整机备份；'
            '整机备份需明确对应型号的备份 API 支持。'
        )
    if kind == 'networks':
        return (
            '配置备份历史保存设备原文，下载文件可能包含账号、密码等敏感凭据，请妥善保管。'
            '历史页仅展示版本信息，不预览原文；下载已保存版本不会连接设备。'
            '网络设备每日巡检自动备份一次当前运行配置，不含证书、私钥或固件，不是整机固件备份。'
        )
    return ''


def asset_table_payload(request, *, kind, admin, endpoint, detail_base,
                        empty_title, empty_message, prefix='', task=''):
    """资产表格块：列定义 + 首屏行 + 工具栏状态，工作区页面的资产表都走这里。

    prefix 只影响分页/排序/筛选参数名（日志表用 'logs'），接口层不带前缀。
    """
    from django.core.paginator import Paginator

    from assets.views import _asset_page  # views 顶层导入了本模块，这里延迟导入
    from index.common.table_payload import row_payloads, table_payload
    from index.common.table_query import PAGE_SIZES, _parameter, apply_table_filters
    from index.common.table_registry import get_table_definition

    page = _asset_page(kind)
    definition = get_table_definition(page.table_key)
    objects = page.model.objects.all()
    # 选了任务就只看那个任务的目标：任务栏在页头，点一条就把台账换成它涉及的设备。
    if task:
        from net.models import TaskTargetRun
        objects = objects.filter(
            pk__in=TaskTargetRun.objects.filter(task_id=task).values('target_id'),
        )
    objects, state = apply_table_filters(
        request, objects, definition,
        prefix=prefix, include_legacy_status=False,
    )
    page_obj = Paginator(objects, state['page_size']).get_page(
        request.GET.get(_parameter(prefix, 'page')),
    )
    payload = table_payload(page_obj, definition, row_payloads(
        page_obj.object_list, definition,
        actions=asset_row_actions(kind, admin),
        row_id=lambda obj: obj.pk,
    ), extra={
        'endpoint': endpoint,
        'detailBase': detail_base,
        'filters': state['filters'],
        'sort': state['sort'],
        'order': state['order'],
        'pageSizes': list(PAGE_SIZES),
        'emptyTitle': empty_title,
        'emptyMessage': empty_message,
    })
    payload['visibleColumns'] = {f.key: bool(f.default_visible) for f in definition.fields}
    # 默认常驻的筛选项，加上地址栏里已经带值的：否则用户带参数进来时勾选态是空的。
    payload['shownFilters'] = {
        f.key: bool(f.default_filter) or f.key in state['filters']
        for f in definition.fields if f.filterable
    }
    # 筛选控件要按列的模式渲染：fixed 出下拉，distinct/suggest 出可编辑候选。
    # 候选来自 apply_table_filters 的 field_options，列定义本身不携带候选值。
    options = state.get('field_options') or {}
    modes = state.get('field_option_modes') or {}
    field_modes = {f.key: f.option_mode for f in definition.fields}
    for column in payload['columns']:
        column['options'] = [
            {'value': value, 'label': label}
            for value, label in (options.get(column['key']) or ())
        ]
        column['optionMode'] = modes.get(column['key']) or field_modes.get(column['key'], 'none')
    # 配置备份 ZIP：只有网络设备与弱电设备有，且只有管理员能拿。
    if admin and kind in {'networks', 'weakcurrent'}:
        payload['configurationZip'] = reverse('configuration_zip', args=[kind])
    # 工具栏只有拿到 exportUrl 才渲染「导出筛选结果」，缺了按钮会整块消失。
    # 带上当前筛选、去掉页码：导出的是整个结果集，不是当前这一页。
    from index.common.table_query import query_without_page
    export_url = reverse('table_export', args=[page.table_key])
    export_query = query_without_page(request, _parameter(prefix, 'page'))
    payload['exportUrl'] = export_url + ('?' + export_query if export_query else '')
    return payload
