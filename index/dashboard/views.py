from django.core.paginator import Paginator
from django.shortcuts import render
from django.middleware.csrf import get_token
from django.urls import reverse
from django.utils import timezone

from net.dashboard.assets import (
    DASHBOARD_SUMMARY_ERROR_MESSAGE,
    build_asset_card_summaries,
)
from index.common.access import is_admin
from index.common.workspace import task_block
from net.inspections.task_summary import inspection_task_queryset, summarize_tasks


def _card_summary_values(summary, *, static=False, waiting_label=''):
    if summary.get('error'):
        return {'error': summary['error']}
    values = {
        **summary,
        'checked': (
            summary['normal']
            if static else summary['total'] - summary['unchecked']
        ),
        'bad': summary['abnormal'],
    }
    if waiting_label:
        values['note'] = (
            f"{waiting_label} {summary['unchecked']} 台"
            if summary['unchecked'] > 0 else ''
        )
    return values


def _domain_summary_values(account_summary, computer_summary, group_summary):
    if any(summary.get('error') for summary in (
        account_summary, computer_summary, group_summary,
    )):
        return {'error': DASHBOARD_SUMMARY_ERROR_MESSAGE}
    return {
        'account_total': account_summary['total'],
        'account_normal': account_summary['normal'],
        'account_abnormal': account_summary['abnormal'],
        'computer_total': computer_summary['total'],
        'computer_normal': computer_summary['normal'],
        'computer_abnormal': computer_summary['abnormal'],
        'group_total': group_summary['total'],
        'security_group_total': group_summary['normal'],
        'distribution_group_total': group_summary['abnormal'],
    }



def _people_department_total():
    """首页人员卡片要显示部门数，和人员页部门视图同源。"""
    from assets.overview import department_totals

    return len(department_totals())


# 方块数字后面的单位：人是"人"，其余资产都是"台"，域控对象按"个"算。
CARD_UNITS = {'people': '人', 'domain': '个'}


def _with_card_actions(item, csrf=''):
    item = dict(item)
    item.setdefault('unit', CARD_UNITS.get(item.get('key'), '台'))
    secondary = []
    if item.get('manual_action_label'):
        primary = {
            'label': item['manual_action_label'],
            'url': item.get('manual_action_url') or f"{item['list_url']}?task_modal=run",
        }
        if item.get('manual_action_kind') == 'form':
            # 会改状态的动作走 POST，别用链接；也不额外补一个列表按钮，
            # 卡片自己的次要入口（域账户/域计算机/域分组）已经在 object_urls 里。
            primary['kind'] = 'form'
            primary['csrf'] = csrf
            primary['fields'] = dict(item.get('manual_action_fields') or {})
        else:
            if item.get('list_label'):
                secondary.append({'label': item['list_label'], 'url': item['list_url']})
            else:
                secondary.append({'label': f"{item['name']}列表", 'url': item['list_url']})
    elif item.get('target_url'):
        primary = {'label': '进入管理', 'url': item['target_url']}
    else:
        primary = {'label': f"查看{item['name']}", 'url': item['list_url']}
    if item.get('log_url'):
        secondary.append({'label': item['log_label'], 'url': item['log_url']})
    if item.get('record_url'):
        secondary.append({'label': item['record_label'], 'url': item['record_url']})
    if item.get('access_url'):
        secondary.append({'label': item.get('access_label', '门禁记录'), 'url': item['access_url']})
    if item.get('department_url'):
        secondary.append({'label': '部门', 'url': item['department_url']})
    if item.get('detail_url') and item.get('detail_label'):
        secondary.append({'label': item['detail_label'], 'url': item['detail_url']})
    if item.get('object_urls'):
        for label, key in (('域账户', 'accounts'), ('域计算机', 'computers'), ('域分组', 'groups')):
            secondary.append({'label': label, 'url': item['object_urls'][key]})
    if item.get('detail_url'):
        secondary.append({'label': item['detail_label'], 'url': item['detail_url']})
    item['primary_action'] = primary
    item['secondary_actions'] = secondary
    return item

def dashboard_tasks(request):
    """首页任务栏翻页：只回任务栏那一段，不整页刷新。"""
    from django.http import JsonResponse

    from django.core.paginator import Paginator

    task_page = Paginator(inspection_task_queryset(), 10).get_page(request.GET.get('task_page'))
    task_page.object_list = summarize_tasks(task_page.object_list)
    return JsonResponse(task_block(
        task_page,
        section_title='巡检任务栏',
        empty_title='暂无巡检任务',
        redact_profiles=not is_admin(request.user),
    ))


def index(request):
    summaries = {
        summary['key']: summary for summary in build_asset_card_summaries()
    }
    items = [
        {
            'key': 'people',
            'name': '人员部门',
            **_card_summary_values(summaries['people'], static=True),
            'total_label': '人员总数',
            'normal_label': '在职人数',
            'abnormal_label': '离职人数',
            'checked_label': '在职人数',
            'bad_label': '离职人数',
            # 人员和部门现在是同一页的两个视图，卡片直接落到部门视图。
            'list_url': reverse('asset_list', args=['people']),
            'list_label': '人员',
            'department_url': reverse('asset_list', args=['people']) + '?object=departments',
            'department_total': _people_department_total(),
            'note': '',
            # 人员没有"巡检"这种一次性任务，蓝色按钮给的是目录同步。
            'manual_action_label': '手动同步人员',
            'manual_action_url': reverse('asset_list', args=['people']) + '?sync_modal=1',
        },
        {
            'key': 'domain',
            'name': '域控管理',
            **_domain_summary_values(
                summaries['domain_accounts'], summaries['domain_computers'],
                summaries['domain_groups'],
            ),
            'target_url': reverse('domain_controller_settings'),
            # 首页直接触发一次域控同步，不必先进设置页。
            'manual_action_label': '手动同步域控',
            'manual_action_url': reverse('domain_controller_settings'),
            'manual_action_kind': 'form',
            'manual_action_fields': {'action': 'sync'},
            # 三个对象列表现在是域控页里的方块视图，链接直接带 object 参数。
            'object_urls': {
                'accounts': reverse('domain_controller_settings') + '?object=accounts',
                'computers': reverse('domain_controller_settings') + '?object=computers',
                'groups': reverse('domain_controller_settings') + '?object=groups',
            },
        },
        {
            'key': 'computers',
            'name': 'PC',
            **_card_summary_values(
                summaries['computers'], waiting_label='等待首次分析',
            ),
            'total_label': 'PC 总数',
            'normal_label': '正常',
            'abnormal_label': '异常',
            'last_run_label': '上次分析日期',
            'checked_label': '已分析设备',
            'bad_label': '异常设备',
            'list_url': reverse('asset_list', args=['computers']),
            'log_url': reverse('asset_list', args=['computers']) + '?object=logs',
            'log_label': '日志列表',
            'record_url': reverse('asset_list', args=['computers']) + '?object=analyses',
            'record_label': '分析记录',
            'manual_action_label': '手动执行分析',
        },
        {
            'key': 'networks',
            'name': '网络设备',
            **_card_summary_values(
                summaries['networks'], waiting_label='等待首次巡检',
            ),
            'manual_action_label': '手动执行巡检',
            'normal_label': '巡检正常',
            'total_label': '设备总数',
            'abnormal_label': '巡检异常',
            'last_run_label': '上次巡检日期',
            'checked_label': '已巡检设备',
            'bad_label': '巡检异常',
            'list_url': reverse('asset_list', args=['networks']),
            'record_url': reverse('asset_list', args=['networks']) + '?object=records',
            'record_label': '巡检记录',
        },
        {
            'key': 'servers',
            'name': '服务器',
            **_card_summary_values(
                summaries['servers'], waiting_label='等待首次巡检',
            ),
            'manual_action_label': '手动执行巡检',
            'normal_label': '巡检正常',
            'total_label': '设备总数',
            'abnormal_label': '巡检异常',
            'last_run_label': '上次巡检日期',
            'checked_label': '已巡检设备',
            'bad_label': '巡检异常',
            'list_url': reverse('asset_list', args=['servers']),
            'record_url': reverse('asset_list', args=['servers']) + '?object=records',
            'record_label': '巡检记录',
        },
        {
            'key': 'weakcurrent',
            'name': '弱电设备',
            **_card_summary_values(
                summaries['weakcurrent'], waiting_label='等待首次巡检',
            ),
            'manual_action_label': '手动执行巡检',
            'normal_label': '巡检正常',
            'total_label': '设备总数',
            'abnormal_label': '巡检异常',
            'last_run_label': '上次巡检日期',
            'checked_label': '已巡检设备',
            'bad_label': '巡检异常',
            'list_url': reverse('asset_list', args=['weakcurrent']),
            'record_url': reverse('asset_list', args=['weakcurrent']) + '?object=records',
            'record_label': '巡检记录',
            'access_url': reverse('asset_list', args=['weakcurrent']) + '?object=access',
            'access_label': '门禁记录',
        },
    ]
    items = [_with_card_actions(item, get_token(request)) for item in items]
    task_page = Paginator(inspection_task_queryset(), 10).get_page(
        request.GET.get('task_page'),
    )
    task_page.object_list = summarize_tasks(task_page.object_list)
    refreshed_at = timezone.now()
    return render(request, 'dashboard/index.html', {
        'items': items,
        'task_page': task_page,
        'has_tasks': bool(task_page.object_list),
        'refreshed_at': refreshed_at,
        # 页头、概览条、卡片网格由 Vue 渲染；任务栏仍是 Django 片段（旧脚本管翻页）。
        # 卡片样式沿用 dashboard/card.html 的那套，不并入其它页的 metric-card 规格。
        'index_bootstrap': {
            'page': {
                'eyebrow': '工作台',
                'title': '设备状态概览',
                'description': '全部资产、最新执行记录与异常统一总览',
                'refreshed_at': timezone.localtime(refreshed_at).strftime('%Y-%m-%d %H:%M:%S'),
            },
            'items': items,
            # 任务栏也走岛渲染：翻页只换这一段，不动地址栏。
            'taskbar': {
                **task_block(
                    task_page,
                    section_title='巡检任务栏',
                    empty_title='暂无巡检任务',
                    redact_profiles=not is_admin(request.user),
                ),
                'endpoint': reverse('dashboard_tasks'),
                'selected_id': '',
            },
        },
    })
