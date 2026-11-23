"""人员部门页的 bootstrap JSON。

页面形状与其它工作区页一致：Django 只吐这一份数据，整页交给 Vue 渲染。
数字全部来自 assets/overview.py，列定义与首屏行来自 assets/payloads.py，
这里只做拼接，不另算口径。
"""
from django.db.models import Max
from django.urls import reverse

from assets.overview import department_totals, people_overview
from assets.payloads import asset_table_payload
from index.common import workspace
from index.common.access import is_admin
from net.data_exchange.inventory_csv import IMPORTABLE_ENTITIES
from net.models import People

PAGE = {'key': 'people', 'title': '人员·部门', 'heading': '人员·部门'}
# 方块即视图：?object=departments 直接落在部门视图，和首页卡片的分部入口对齐。
VIEWS = frozenset({'people', 'departments'})
EMPTY_TITLE = '暂无人员数据'
EMPTY_MESSAGE = '可点击右上角“导入人员”添加人员。'


def _people_block():
    """唯一的一张方块：规模、在职率、今年进出、平均司龄。"""
    overview = people_overview()
    return workspace.block(
        key='people',
        title='人员',
        badge='台账',
        metric=overview['total'],
        unit='人',
        lines=[
            [
                {'text': '在职 '},
                {'text': overview['active'], 'tone': 'success'},
                {'text': ' 人（%s%%） · 离职 ' % overview['active_rate']},
                {'text': overview['departed'],
                 'tone': 'danger' if overview['departed'] else ''},
                {'text': ' 人'},
            ],
            [{'text': '今年入职 %s 人 · 今年离职 %s 人' % (
                overview['hires_this_year'], overview['departures_this_year'])}],
            [{'text': '平均司龄 %s 年（%s 人有入职日期）' % (
                overview['average_active_tenure_years'], overview['tenure_sample_count'])}],
        ],
        # 人员没有「上报时间」这种单点时间，用最近一次目录同步代替，避免空占位。
        latest=People.objects.aggregate(latest=Max('last_synced_at'))['latest'],
        latest_label='最近同步',
        entry='查看人员',
    )


def _department_block():
    """第二个方块：部门规模。明细列表放在表格下面，顶部保持两块并排。"""
    rows = department_totals()
    total = sum(row['total'] for row in rows)
    top = rows[0] if rows else None
    lines = [[{'text': '覆盖 %s 人 · 平均每部门 %s 人' % (
        total, round(total / len(rows), 1) if rows else 0)}]]
    if top:
        lines.append([{'text': '人数最多 %s（%s 人）' % (top['department'], top['total'])}])
    return workspace.block(
        key='departments',
        title='部门',
        badge='台账',
        metric=len(rows),
        unit='个',
        lines=lines,
        entry='查看部门',
    )


def statistics_bootstrap(*, metrics, departments, as_of):
    """人员统计页：整页交给 Vue，口径仍在 assets.views.people_statistics 里算。"""
    return {
        'page': {
            'key': 'people-statistics',
            'eyebrow': '人员概况',
            'title': '人员统计',
            'description': '统计日期：%s。在职年限仅使用有效入职日期计算。' % as_of.isoformat(),
        },
        'metrics': metrics,
        'departments': departments,
    }


def people_bootstrap(request):
    admin = is_admin(request.user)
    rows_url = reverse('asset-row-list', args=['people'])
    detail_base = reverse('asset_list', args=['people'])
    requested = request.GET.get('object') or 'people'
    page = {**PAGE, 'view': requested if requested in VIEWS else 'people'}
    return workspace.bootstrap(
        page=page,
        blocks=[_people_block(), _department_block()],
        table={
            **asset_table_payload(
                request, kind='people', admin=admin, endpoint=rows_url,
                detail_base=detail_base, empty_title=EMPTY_TITLE,
                empty_message=EMPTY_MESSAGE,
            ),
            # 每张表都能勾选：全选、反选、导出所选是通用能力。
            'selectAttr': 'data-device-selection-target',
        },
        urls={
            'rows': rows_url,
            'detail': detail_base,
            'export': reverse('table_export', args=['people']),
        },
        departments=department_totals(),
        # 同步入口走 Django include 的导入弹窗，只有管理员能看到那个弹窗。
        sync_label='同步人员' if admin and 'people' in IMPORTABLE_ENTITIES else '',
    )
