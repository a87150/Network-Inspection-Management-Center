import copy
import logging
from dataclasses import dataclass

from django.contrib import messages
from index.common.access import admin_required, is_admin
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse

from assets.payloads import asset_detail_payload
from index.common.table_payload import attach_column_options
from index.common.table_payload import row_payloads as table_row_payloads
from index.common.table_payload import table_payload
from index.common.table_query import PAGE_SIZES, apply_table_filters, query_without_page
from index.common.table_registry import get_table_definition
from domain.forms import DomainControllerConfigForm, DomainOperationForm
from domain.connection_form import DomainInactivityForm
from net.models import (
    Domain_Account,
    Domain_Computer,
    Domain_Group,
    Domain_Controller_Config,
    Schedule, TaskRun,
)
from net.domain.sync import test_domain_connection
from net.domain.statistics import get_domain_statistics
from net.domain.sync_tasks import enqueue_domain_sync
from domain.schedule_form import DomainSyncScheduleForm


@dataclass(frozen=True)
class DomainObjectPage:
    model: type
    table_key: str
    export_key: str
    title: str
    detail_route: str


DOMAIN_OBJECT_PAGES = {
    'accounts': DomainObjectPage(
        Domain_Account,
        'domain_accounts',
        'accounts',
        '域账户',
        'domain_account_detail',
    ),
    'computers': DomainObjectPage(
        Domain_Computer,
        'domain_computers',
        'domain_computers',
        '域计算机',
        'domain_computer_detail',
    ),
    'groups': DomainObjectPage(
        Domain_Group,
        'domain_groups',
        'domain_groups',
        '域分组',
        'domain_group_detail',
    ),
}

DOMAIN_OPERATION_ACTIONS = {
    'account': (
        ('create_user', '新增用户'),
        ('move_ou', '移动到 OU'),
        ('add_group', '加入安全组'),
        ('reset_password', '重置密码'),
        ('must_change_password', '下次登录修改密码'),
        ('password_never_expires', '密码永不过期'),
        ('unlock', '解锁'),
        ('enable', '启用'),
        ('disable', '停用'),
    ),
    'computer': (
        ('move_ou', '移动到 OU'),
        ('add_group', '加入安全组'),
        ('enable', '启用'),
        ('disable', '停用'),
    ),
}


def _domain_page(object_type):
    try:
        return DOMAIN_OBJECT_PAGES[object_type]
    except KeyError as exc:
        raise Http404('未知的域对象类型') from exc


def _display_value(obj, field):
    value = getattr(obj, field.source, None)
    display_method = getattr(obj, f'get_{field.source}_display', None)
    return display_method() if callable(display_method) else value


@admin_required
def _domain_controller_settings_mutation(request):
    config, _ = Domain_Controller_Config.objects.get_or_create(pk=1)
    action = request.POST.get('action', 'save')
    if action == 'inactivity':
        inactivity_form = DomainInactivityForm(request.POST)
        if inactivity_form.is_valid():
            config.inactive_days = inactivity_form.cleaned_data['inactive_days']
            config.save(update_fields=['inactive_days'])
            messages.success(request, '未登录天数设置已保存，统计已更新。')
            return redirect(reverse('domain_controller_settings') + '?inactivity_modal=1')
        return _render_domain_settings(request, config, DomainControllerConfigForm(instance=config),
                                       inactivity_form=inactivity_form)
    if action == 'schedule':
        schedule = Schedule.objects.filter(domain_config=config).first()
        schedule_form = DomainSyncScheduleForm(request.POST, config=config, instance=schedule)
        if schedule_form.is_valid():
            schedule_form.save()
            messages.success(request, '域控定时同步设置已保存，后台 Worker 将按计划创建任务。')
        else:
            messages.error(request, '定时设置未保存：' + '；'.join(
                str(error) for errors in schedule_form.errors.values() for error in errors))
            return _render_domain_settings(request, config, DomainControllerConfigForm(instance=config),
                                           open_domain_modal=True, schedule_form=schedule_form)
        return redirect(reverse('domain_controller_settings') + '?modal=1')
    form_fields = DomainControllerConfigForm.base_fields
    if action == 'sync' and not any(field in request.POST for field in form_fields):
        try:
            enqueue_domain_sync()
            messages.success(
                request,
                '域控同步任务已加入后台队列，可在下方同步任务列表查看进度。',
            )
        except ValidationError as exc:
            messages.error(request, '；'.join(exc.messages))
        return redirect('domain_controller_settings')

    form = DomainControllerConfigForm(request.POST, instance=config)
    if form.is_valid():
        config = form.save()
        try:
            if action == 'test':
                messages.success(request, test_domain_connection(config))
            elif action == 'sync':
                enqueue_domain_sync()
                messages.success(
                    request,
                    '域控同步任务已加入后台队列，可在同步任务列表查看进度。',
                )
            else:
                messages.success(request, '域控配置已保存。')
        except Exception:
            # This wraps a real LDAP connect/bind and the enqueue call, so every TLS,
            # port, base_dn, permission and programming error used to surface as the
            # same one-liner with the exception discarded.
            logging.getLogger(__name__).exception(
                '域控配置操作失败 action=%s config=%s', action, config.pk)
            messages.error(request, '域控操作失败，请查看服务端日志。')
        return redirect(reverse('domain_controller_settings') + '?modal=1')

    return _render_domain_settings(request, config, form, open_domain_modal=True)


def _render_domain_settings(request, config, form, *, open_domain_modal=False, schedule_form=None, inactivity_form=None):
    can_manage_domain = is_admin(request.user)
    return render(request, 'domain/controller_settings.html', {
        'form': form if can_manage_domain else None,
        'config': config if can_manage_domain else None,
        'open_domain_modal': open_domain_modal or request.GET.get('modal') == '1',
        'domain_schedule': Schedule.objects.filter(domain_config=config).first() if can_manage_domain else None,
        'domain_schedule_form': (schedule_form if schedule_form is not None else DomainSyncScheduleForm(config=config, instance=Schedule.objects.filter(domain_config=config).first())) if can_manage_domain else None,
        'domain_sync_tasks': Paginator(TaskRun.objects.filter(task_type='domain_sync').order_by('-created_at'), 10).get_page(request.GET.get('sync_page')),
        'can_manage_domain': can_manage_domain,
        'inactivity_form': inactivity_form if inactivity_form is not None else DomainInactivityForm(initial={'inactive_days': config.inactive_days if config else 60}),
        'open_inactivity_modal': inactivity_form is not None or request.GET.get('inactivity_modal') == '1',
        **get_domain_statistics(inactive_days=config.inactive_days if config else 60),
        **_domain_panels(request),
    })


def _domain_panels(request):
    """页面上方三个方块对应的三份列表，点哪个就显示哪个。"""
    selected = request.GET.get('object', 'accounts')
    if selected not in DOMAIN_OBJECT_PAGES:
        selected = 'accounts'
    # 岛内用的是 resource_table，它只渲染表体和翻页、没有工具栏；岛接管工具栏的
    # 那套开关（showToolbar）在这三张表上等于把筛选和导出一并藏掉，所以这里让
    # 服务端工具栏照常渲染，和域对象列表页保持同一套筛选/导出。
    panels = [
        _domain_panel(request, kind, active=(kind == selected))
        for kind in DOMAIN_OBJECT_PAGES
    ]
    active = next(p for p in panels if p['active'])
    # 批量操作栏跟着当前方块走：账户和计算机有动作清单，分组没有。
    singular = {'accounts': 'account', 'computers': 'computer'}.get(selected)
    return {
        'domain_panels': panels,
        'active_domain_panel': active,
        'selected_domain_object': selected,
        'domain_object_type': active['context']['domain_object_type'],
        'domain_operation_form': (
            DomainOperationForm() if is_admin(request.user) else None
        ),
        'domain_operation_actions': (
            DOMAIN_OPERATION_ACTIONS.get(singular, ())
            if is_admin(request.user) else ()
        ),
    }


def domain_controller_settings(request):
    if request.method == 'POST':
        return _domain_controller_settings_mutation(request)
    if not is_admin(request.user):
        return _render_domain_settings(request, None, None)
    config, _ = Domain_Controller_Config.objects.get_or_create(pk=1)
    form = DomainControllerConfigForm(instance=config)
    return _render_domain_settings(request, config, form)


LEGACY_TABLE_PARAMETERS = frozenset({'sort', 'order', 'page', 'page_size', 'q', 'status', 'category'})


def _alias_legacy_parameters(request, object_type):
    """旧链接用的是无前缀参数（filter_department、page），映射到当前页签的命名空间。

    三个页签共用一页后参数必须带前缀才不打架，但外部书签和旧链接还是无前缀写法；
    这里补一层别名，两种都能用，不必要求重新发链接。
    """
    get = request.GET
    legacy = [key for key in get
              if key in LEGACY_TABLE_PARAMETERS or key.startswith('filter_')]
    if not legacy:
        return request
    alias = copy.copy(request)
    data = get.copy()
    for key in legacy:
        data.setdefault(f'{object_type}_{key}', get[key])
    alias.GET = data
    return alias


def _export_href(request, table_key, object_type):
    """导出筛选结果：带上当前筛选、去掉页码，导的是整个结果集而不是这一页。"""
    query = query_without_page(request, f'{object_type}_page')
    url = reverse('table_export', args=[table_key])
    return url + ('?' + query if query else '')


def _domain_panel(request, object_type, *, active, operation_form=None):
    """一个域对象视图渲染所需的全部数据；三个页签各取一份。

    三张表各用带前缀的查询参数（accounts_page、groups_filter_department 之类），
    互不干扰——表查询层本来就有 prefix 支持，这里只是把它用起来。
    """
    page = _domain_page(object_type)
    table_definition = get_table_definition(page.table_key)
    scoped = _alias_legacy_parameters(request, object_type)
    objects, table_state = apply_table_filters(
        scoped, page.model.objects.all(), table_definition, prefix=object_type,
    )
    page_obj = Paginator(objects, table_state['page_size']).get_page(
        scoped.GET.get(f'{object_type}_page'),
    )
    admin = is_admin(request.user)
    can_select = admin and object_type != 'groups'
    can_manage = object_type != 'groups' and admin

    def row_actions(obj):
        actions = [{
            'kind': 'link', 'label': '查看详情',
            'url': reverse(page.detail_route, args=[obj.pk]),
            # 详情不再跳页，前端就地弹窗。
            'detail_modal': True,
        }]
        if object_type == 'groups' and admin:
            actions.append({
                'kind': 'link', 'label': '成员管理', 'variant': 'primary',
                'url': reverse('domain_group_members', args=[obj.pk]),
                'modal_target': 'domainGroupMembersModal',
            })
        if object_type == 'computers' and can_manage:
            actions.append({
                'kind': 'modal', 'label': '获取 BitLocker 密钥', 'variant': 'primary',
                'url': reverse('domain_computer_bitlocker', args=[obj.pk]),
                'modal_target': 'domainBitLockerModal',
                'computer_name': obj.computer_name,
            })
        return actions

    domain_objects = attach_column_options(table_payload(
        page_obj, table_definition,
        table_row_payloads(
            page_obj.object_list, table_definition,
            row_id=lambda obj: obj.pk, actions=row_actions,
        ),
        extra={
            'endpoint': f'/api/v1/domain-{object_type}/',
            # 岛内是 resource_table，没有工具栏；False 让模板渲染服务端那一份。
            'showToolbar': False,
            # 筛选栏、列选择和导出都在服务端工具栏里，参数带页签前缀。
            'tableKey': table_definition.key,
            'exportUrl': _export_href(request, table_definition.key, object_type),
            # 首屏就把服务端算好的筛选态交给表格，选中的筛选框、排序箭头才对得上。
            'filters': table_state['filters'],
            'sort': table_state['sort'],
            'order': table_state['order'],
            'shownFilters': {
                field.key: bool(field.default_filter) or field.key in table_state['filters']
                for field in table_definition.fields if field.filterable
            },
            'visibleColumns': {
                field.key: bool(field.default_visible) for field in table_definition.fields
            },
            'label': page.title,
            'region_label': f'{page.title}数据表',
            'select_attr': 'data-domain-target-checkbox' if can_select else '',
            'select_value_key': 'id',
        },
    ), table_definition, table_state)

    return {
        'object_type': object_type,
        'singular': {'accounts': 'account', 'computers': 'computer',
                     'groups': 'group'}[object_type],
        'title': page.title,
        'active': active,
        'payload': domain_objects,
        'context': {
            'domain_objects': domain_objects,
            'item_key': page.export_key,
            'export_key': page.export_key,
            'item_name': page.title,
            'table_definition': table_definition,
            'table_state': table_state,
            'page_obj': page_obj,
            'page_sizes': PAGE_SIZES,
            'table_export_path': reverse('table_export', args=[page.table_key]),
            'pagination_query': query_without_page(request, f'{object_type}_page'),
            'detail_route': page.detail_route,
            'can_manage_domain': can_manage,
            'domain_object_type': {'accounts': 'account', 'computers': 'computer',
                                   'groups': 'group'}[object_type],
            'domain_operation_form': (
                operation_form if operation_form is not None
                else DomainOperationForm()
            ) if is_admin(request.user) else None,
            'domain_operation_actions': DOMAIN_OPERATION_ACTIONS.get(
                {'accounts': 'account', 'computers': 'computer'}.get(object_type),
                (),
            ) if is_admin(request.user) else (),
        },
    }


def domain_object_list(request, object_type, *, operation_form=None):
    """三个域对象视图同屏渲染，页签只切显示，不再换页。"""
    panels = [
        _domain_panel(request, kind, active=(kind == object_type),
                      operation_form=operation_form)
        for kind in DOMAIN_OBJECT_PAGES
    ]
    active = next(panel for panel in panels if panel['active'])
    return render(request, 'domain/object_list.html', {
        **active['context'],
        'panels': panels,
    })



def domain_object_detail(request, object_type, pk):
    page = _domain_page(object_type)
    domain_object = get_object_or_404(page.model, pk=pk)
    table_definition = get_table_definition(page.table_key)
    detail_fields = [
        {
            'label': field.label,
            'value': _display_value(domain_object, field),
            'kind': field.kind,
        }
        for field in table_definition.fields
    ]
    list_route = {
        'accounts': 'domain_account_list',
        'computers': 'domain_computer_list',
        'groups': 'domain_group_list',
    }[object_type]
    back_url = reverse(list_route)
    return render(request, 'devices/detail.html', {
        'asset': domain_object,
        'item_name': page.title,
        'back_url': back_url,
        'detail': asset_detail_payload(
            kind=object_type,
            item_name=page.title,
            asset=domain_object,
            detail_fields=detail_fields,
            latest_record=None,
            latest_url='',
            history_url='',
            back_url=back_url,
            manual_action_label='',
            can_administer=False,
        ),
    })


def domain_account_detail(request, pk):
    return domain_object_detail(request, 'accounts', pk)


def domain_computer_detail(request, pk):
    return domain_object_detail(request, 'computers', pk)


def domain_group_detail(request, pk):
    return domain_object_detail(request, 'groups', pk)