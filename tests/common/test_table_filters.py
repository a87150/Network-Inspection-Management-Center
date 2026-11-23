import csv
import json
import re
from datetime import datetime, timezone as dt_timezone

from tests import response_body
from html.parser import HTMLParser
from io import StringIO
from urllib.parse import parse_qs, urlsplit

from django.test import RequestFactory, TestCase
from django.urls import reverse
from tests.auth import login_reader
from pathlib import Path

from tests.payloads import payload_text
from tests.devices.pc.helpers import add_analysis_issue, create_log_file
from django.utils import timezone

from index.common.table_options import build_field_option_context, build_field_options
from index.common.table_query import apply_table_filters
from index.common.table_registry import (
    TABLE_DEFINITIONS,
    TableDefinition,
    TableField,
    get_table_definition,
)
from net.models import (
    Computer,
    ComputerAnalysis,
    ComputerAnalysisProfile,
    Network_Device,
    Network_Device_Inspection,
    People,
    RecordStatus,
    Server,
    TaskRun,
    TaskTargetRun,
)


def bootstrap_of(response, page_key):
    """五个工作区页只吐一份 bootstrap JSON：筛选值、列定义、首屏行都在里面。"""
    match = re.search(
        r'<script id="%s-bootstrap" type="application/json">(.*?)</script>'
        % page_key, response.content.decode(), re.S)
    if match is None:
        raise AssertionError(page_key + ' 缺少 bootstrap json_script')
    return json.loads(match.group(1))


def component_source(*relative_path):
    """控件本体已搬进 Vue 组件：标记与样式契约只能验源码。"""
    return (Path(__file__).resolve().parents[2] / 'static' / 'app' / 'vue'
            / Path(*relative_path)).read_text(encoding='utf-8')


class TableOptionGenerationTests(TestCase):
    def test_distinct_options_are_deduplicated_sorted_and_ignore_blanks(self):
        People.objects.bulk_create([
            People(name='甲', employee_id='P001', department='运维部'),
            People(name='乙', employee_id='P002', department='研发部'),
            People(name='丙', employee_id='P003', department='运维部'),
            People(name='丁', employee_id='P004', department=''),
            People(name='戊', employee_id='P005', department=None),
        ])

        options = build_field_options(
            People.objects.all(), get_table_definition('people'),
        )

        self.assertEqual(
            options['department'],
            (('研发部', '研发部'), ('运维部', '运维部')),
        )

    def test_distinct_options_fall_back_to_suggestions_above_limit(self):
        People.objects.bulk_create([
            People(
                name=f'人员{number:03d}',
                employee_id=f'P{number:03d}',
                department=f'部门{number:03d}',
            )
            for number in range(101)
        ])

        options, modes = build_field_option_context(
            People.objects.all(), get_table_definition('people'),
        )

        self.assertEqual(len(options['department']), 100)
        self.assertEqual(modes['department'], 'suggest')

    def test_fixed_options_use_registered_values_and_labels(self):
        options, modes = build_field_option_context(
            Server.objects.all(), get_table_definition('servers'),
        )

        self.assertEqual(
            options['server_type'],
            (('linux', 'Linux'), ('windows', 'Windows')),
        )
        self.assertEqual(modes['server_type'], 'fixed')

    def test_secret_fields_can_never_be_option_sources(self):
        secret_sources = {
            'password', 'api_password', 'api_token', 'bind_password',
        }

        for definition in TABLE_DEFINITIONS.values():
            with self.subTest(table=definition.key):
                self.assertFalse(
                    secret_sources & {field.source for field in definition.fields},
                )

    def test_option_metadata_uses_only_supported_modes_and_positive_limits(self):
        supported_modes = {'fixed', 'distinct', 'suggest', 'none'}

        for definition in TABLE_DEFINITIONS.values():
            for field in definition.fields:
                with self.subTest(table=definition.key, field=field.key):
                    self.assertIn(field.option_mode, supported_modes)
                    self.assertGreater(field.option_limit, 0)


class CompactFilterWorkspaceTests(TestCase):
    def setUp(self):
        login_reader(self.client)
        People.objects.bulk_create([
            People(
                name='张三', employee_id='P001', department='研发部',
                email='zhang@example.test', leader='李经理',
            ),
            People(
                name='李四', employee_id='P002', department='运维部',
                email='li@example.test', leader='王经理',
            ),
        ])

    def test_workspace_renders_free_text_filters_without_a_candidate_list(self):
        response = self.client.get(reverse('asset_list', args=['people']))

        self.assertEqual(response.status_code, 200)
        table = bootstrap_of(response, 'people-workspace')['table']
        toolbar = component_source('components', 'table_toolbar.mjs')

        # 筛选栏与两个折叠块由工具栏组件渲染，服务端只给列定义。
        self.assertIn('table-filter-bar', toolbar)
        self.assertIn('<summary>更多筛选</summary>', toolbar)
        self.assertIn('<summary>自定义表格</summary>', toolbar)
        # 自由文本字段渲染普通输入框，不给候选下拉：否则会列出全部 77 个设备名/IP，
        # 以及 os_version 这种尚未采集、只能给出空下拉的列。
        name_column = next(column for column in table['columns'] if column['key'] == 'name')
        self.assertEqual(name_column['kind'], 'text')
        self.assertTrue(name_column['default_filter'])
        self.assertIn('type="text"', toolbar)
        self.assertNotContains(response, 'name="filter_name"')
        self.assertNotContains(response, 'data-filter-input="people-name-filter-input"')
        self.assertNotContains(response, 'list="people-name-options"')
        # 部门是 choice 列：候选仍由服务端按 distinct 口径算好。
        department = next(column for column in table['columns'] if column['key'] == 'department')
        self.assertEqual(department['kind'], 'choice')
        self.assertEqual(
            response.context['table_state']['field_option_modes']['department'],
            'distinct',
        )

    def test_workspace_keeps_accessible_filter_table_summary_and_pagination_order(self):
        People.objects.bulk_create([
            People(name=f'分页人员{index:02d}', employee_id=f'PAGE-{index:02d}')
            for index in range(25)
        ])

        response = self.client.get(reverse('asset_list', args=['people']))
        table = bootstrap_of(response, 'people-workspace')['table']
        toolbar = component_source('components', 'table_toolbar.mjs')

        # 三个动作按钮的顺序由工具栏模板决定，服务端不再输出按钮本身。
        filter_position = toolbar.index('>筛选</button>')
        reset_position = toolbar.index('>重置查询</button>')
        # 按钮文案会随「有没有勾选显示列」在两种之间切换，按 data 属性定位更稳。
        export_position = toolbar.index('data-filtered-export')
        self.assertLess(filter_position, reset_position)
        self.assertLess(reset_position, export_position)
        # 结果条的可访问播报仍在组件模板里，条数来自服务端算好的分页数据。
        self.assertIn('table-result-bar', toolbar)
        self.assertIn('aria-live="polite"', toolbar)
        self.assertEqual(table['count'], 27)
        self.assertEqual((table['start_index'], table['end_index']), (1, 20))
        # 表格与分页由组件渲染：区域语义和分页控件只能验组件源码。
        self.assertIn('role="region"', component_source('components', 'data_table.mjs'))
        self.assertIn('<page-pagination', component_source('components', 'workspace_table.mjs'))

    def test_free_text_filter_keeps_the_typed_value_and_still_filters(self):
        response = self.client.get(reverse('asset_list', args=['people']), {
            'filter_name': '张三',
        })

        table = bootstrap_of(response, 'people-workspace')['table']
        # 输入框由组件按 table.filters 回填，用户敲的值必须原样回来。
        self.assertEqual(table['filters']['name'], '张三')
        self.assertNotContains(response, 'data-filter-input="people-name-filter-input"')
        self.assertEqual(
            [person.employee_id for person in response.context['page_obj']],
            ['P001'],
        )
        self.assertEqual(
            [row['cells']['employee_id']['text'] for row in table['rows']], ['P001'],
        )

    def test_non_default_filter_still_uses_allowlisted_backend_filter(self):
        definition = get_table_definition('people')
        email = next(field for field in definition.fields if field.key == 'email')
        self.assertTrue(email.filterable)
        self.assertFalse(email.default_filter)

        response = self.client.get(reverse('asset_list', args=['people']), {
            'filter_email': 'li@example.test',
        })

        self.assertEqual(
            [person.employee_id for person in response.context['page_obj']],
            ['P002'],
        )

    def test_unregistered_filters_and_orm_traversal_sort_are_ignored(self):
        response = self.client.get(reverse('asset_list', args=['people']), {
            'filter_password': 'anything',
            'filter_department__contains': '研发',
            'sort': 'analyses__details',
            'order': 'desc',
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context['table_state']['sort'], 'name')
        # 这里要验的是「非法排序被忽略、回落到默认列」，不是中文名的排序规则：
        # 字节序(MariaDB utf8mb4_bin / PostgreSQL LC_COLLATE=C) 和 locale 序对
        # 「甲」「乙」的先后正好相反，两种后端各按各的来，比集合更稳。
        self.assertCountEqual(
            [person.employee_id for person in response.context['page_obj']],
            ['P001', 'P002'],
        )

    def test_invalid_value_for_allowlisted_numeric_choice_does_not_crash(self):
        Server.objects.create(name='应用服务器', ip='192.0.2.30', port=22)

        response = self.client.get(reverse('asset_list', args=['servers']), {
            'filter_port': 'not-a-number',
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context['page_obj'].paginator.count, 1)
        self.assertNotIn('port', response.context['table_state']['filters'])

    def test_target_scoped_history_builds_options_from_only_that_asset(self):
        first = Network_Device.objects.create(
            device_name='核心交换机', ip='192.0.2.10',
        )
        second = Network_Device.objects.create(
            device_name='接入交换机', ip='192.0.2.11',
        )
        Network_Device_Inspection.objects.create(
            device=first,
            status=RecordStatus.SUCCESS,
            summary='正常',
        )
        Network_Device_Inspection.objects.create(
            device=second,
            status=RecordStatus.SUCCESS,
            summary='正常',
        )

        response = self.client.get(reverse('record_list', args=['networks']), {
            'target': str(first.pk),
        })

        self.assertEqual(
            response.context['table_state']['field_options']['asset'],
            (('核心交换机 (192.0.2.10)', '核心交换机 (192.0.2.10)'),),
        )

    def test_shared_filter_interface_handles_querysets_and_record_lists(self):
        request = RequestFactory().get('/', {'filter_department': '运维部'})
        people, people_state = apply_table_filters(
            request, People.objects.all(), get_table_definition('people'),
        )
        records, record_state = apply_table_filters(
            RequestFactory().get('/', {'filter_category': '网络设备'}),
            [
                {
                    'category': '网络设备', 'asset': '交换机', 'time': None,
                    'ok': True, 'summary': '正常',
                },
                {
                    'category': '服务器', 'asset': '应用服务器', 'time': None,
                    'ok': True, 'summary': '正常',
                },
            ],
            get_table_definition('inspection_records'),
        )

        self.assertEqual([person.employee_id for person in people], ['P002'])
        self.assertEqual([record['category'] for record in records], ['网络设备'])
        self.assertEqual(people_state['filters']['department'], '运维部')
        self.assertEqual(record_state['filters']['category'], '网络设备')

    def test_direct_url_optional_filter_is_visible_and_enabled(self):
        response = self.client.get(reverse('asset_list', args=['people']), {
            'filter_email': 'missing@example.invalid',
        })
        table = bootstrap_of(response, 'people-workspace')['table']
        toolbar = component_source('components', 'table_toolbar.mjs')

        email = next(column for column in table['columns'] if column['key'] == 'email')
        # 非默认筛选项不进常驻区，但带值时照样回填并显示，不能因为不是默认项被藏掉。
        self.assertFalse(email['default_filter'])
        self.assertEqual(table['filters']['email'], 'missing@example.invalid')
        self.assertIn('shown[column.key] || draft[column.key]', toolbar)
        # 可选筛选区默认收起，这一次因为有值而自动展开（moreOpen = hasActiveOptional()）。
        # 初始展开状态改在 created() 里设：data() 阶段 computed 还没就绪，
        # 在那里调 hasActiveOptional() 会拿到 undefined 并让整页白屏。
        self.assertIn('this.moreOpen = this.hasActiveOptional()', toolbar)
        self.assertIn(':open="moreOpen"', toolbar)

    def test_stale_distinct_value_stays_editable_and_available_as_a_candidate(self):
        response = self.client.get(reverse('asset_list', args=['people']), {
            'filter_department': '已撤销部门',
        })
        table = bootstrap_of(response, 'people-workspace')['table']

        # 已撤销的部门不在候选里，但当前筛选值必须原样留在输入框里，不能被清空。
        self.assertEqual(table['filters']['department'], '已撤销部门')
        department = next(column for column in table['columns'] if column['key'] == 'department')
        self.assertEqual(department['kind'], 'choice')
        # 候选仍按 distinct 口径由服务端生成；「（当前筛选）」标注与下拉控件在浏览器里。
        self.assertEqual(
            response.context['table_state']['field_option_modes']['department'],
            'distinct',
        )

    def test_infrastructure_reset_query_preserves_target_scope(self):
        device = Network_Device.objects.create(
            device_name='核心交换机', ip='192.0.2.40',
        )
        response = self.client.get(reverse('record_list', args=['networks']), {
            'target': str(device.pk),
            'filter_summary': '异常',
        })
        parser = _WorkspaceMarkupParser()
        parser.feed(response.content.decode())

        self.assertEqual(len(parser.reset_links), 1)
        reset = urlsplit(parser.reset_links[0])
        self.assertEqual(reset.path, reverse('record_list', args=['networks']))
        self.assertEqual(parse_qs(reset.query), {'target': [str(device.pk)]})

    def test_computer_analysis_statistics_have_no_record_filter_controls(self):
        computer = Computer.objects.create(computer_name='PC-RESET')
        response = self.client.get(reverse('computer_analysis_list'), {
            'target': str(computer.pk),
            'filter_status': 'abnormal',
        })
        parser = _WorkspaceMarkupParser()
        parser.feed(response.content.decode())

        self.assertEqual(len(parser.reset_links), 0)
        self.assertContains(response, '最新任务统计')

    def test_global_and_project_record_workspaces_have_distinct_preference_keys(self):
        cases = (
            (reverse('inspection_records'), 'inspection_records-global'),
            (
                reverse('record_list', args=['networks']),
                'inspection_records-networks',
            ),
            (
                reverse('record_list', args=['servers']),
                'inspection_records-servers',
            ),
            (
                reverse('record_list', args=['weakcurrent']),
                'inspection_records-weakcurrent',
            ),
        )
        observed = []

        for url, expected_key in cases:
            with self.subTest(url=url):
                parser = _WorkspaceMarkupParser()
                parser.feed(self.client.get(url).content.decode())
                self.assertEqual(parser.workspace_keys, [expected_key])
                observed.append(parser.workspace_keys[0])

        self.assertEqual(len(set(observed)), 4)


class _ExportLinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'a' and 'data-filtered-export' in attributes:
            self.links.append(attributes.get('href', ''))


class _WorkspaceMarkupParser(HTMLParser):
    """只给仍由 Django 渲染的列表页用：工作区页的标记已搬到 Vue 组件。"""

    def __init__(self):
        super().__init__()
        self.workspace_keys = []
        self.reset_links = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if 'data-table-key' in attributes:
            self.workspace_keys.append(attributes['data-table-key'])
        if tag == 'a' and 'data-query-reset' in attributes:
            self.reset_links.append(attributes.get('href', ''))


class FilteredCsvExportTests(TestCase):
    def setUp(self):
        login_reader(self.client)

    def test_export_uses_all_filtered_rows_and_escapes_formula_prefixes(self):
        People.objects.bulk_create([
            People(
                name='=2+3' if number == 0 else f'运维人员{number:02d}',
                employee_id=f'OPS{number:03d}',
                department='运维部',
            )
            for number in range(25)
        ] + [
            People(
                name=f'研发人员{number:02d}',
                employee_id=f'RD{number:03d}',
                department='研发部',
            )
            for number in range(3)
        ])

        response = self.client.get(reverse('table_export', args=['people']), {
            'filter_department': '运维部',
            'sort': 'employee_id',
            'order': 'asc',
            'page': '2',
            'page_size': '20',
        })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response_body(response).startswith(b'\xef\xbb\xbf'))
        rows = list(csv.DictReader(StringIO(response_body(response).decode('utf-8-sig'))))
        self.assertEqual(len(rows), 25)
        self.assertEqual({row['部门'] for row in rows}, {'运维部'})
        self.assertEqual(rows[0]['姓名'], "'=2+3")
        self.assertNotIn('password', response_body(response).decode('utf-8-sig').lower())

    def test_target_scope_is_preserved_in_infrastructure_record_export(self):
        first = Network_Device.objects.create(
            device_name='核心交换机', ip='192.0.2.20',
        )
        second = Network_Device.objects.create(
            device_name='接入交换机', ip='192.0.2.21',
        )
        Network_Device_Inspection.objects.create(
            device=first, status=RecordStatus.SUCCESS, summary='核心正常',
        )
        Network_Device_Inspection.objects.create(
            device=second, status=RecordStatus.FAILED, summary='接入异常',
        )

        response = self.client.get(
            reverse(
                'table_export_scoped',
                args=['inspection_records', 'networks'],
            ),
            {'target': str(first.pk)},
        )

        rows = list(csv.DictReader(StringIO(response_body(response).decode('utf-8-sig'))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['设备名称'], '核心交换机 (192.0.2.20)')
        self.assertEqual(rows[0]['摘要'], '核心正常')

    def test_each_table_workspace_has_independent_export_link_with_query(self):
        cases = (
            (reverse('domain_account_list'), reverse('table_export', args=['domain_accounts'])),
            (reverse('inspection_records'), reverse('table_export', args=['inspection_records'])),
            (reverse('error_records'), reverse('table_export', args=['error_records'])),
            (reverse('computer_error_list'), reverse('table_export', args=['computer_errors'])),
            (
                reverse('record_list', args=['networks']),
                reverse('table_export_scoped', args=['inspection_records', 'networks']),
            ),
        )

        for page_url, export_path in cases:
            with self.subTest(page=page_url):
                response = self.client.get(page_url, {
                    'q': '交换机', 'page': '3', 'page_size': '50',
                })
                parser = _ExportLinkParser()
                parser.feed(response.content.decode())
                # 同屏多份表格时每个工作区各有自己的导出链接，取目标那份。
                matching = [link for link in parser.links
                            if urlsplit(link).path == export_path]
                self.assertEqual(len(matching), 1)
                export_url = urlsplit(matching[0])
                self.assertEqual(export_url.path, export_path)
                self.assertEqual(parse_qs(export_url.query), {
                    'q': ['交换机'], 'page_size': ['50'],
                })

    def test_people_workspace_export_link_carries_the_current_filters(self):
        """人员页的导出入口随整页搬进 bootstrap，但仍必须带上当前筛选。

        原断言在服务端 HTML 里找 data-filtered-export 链接；现在链接地址由
        bootstrap 的 table.exportUrl 给出，判定标准不变：带上筛选参数、丢掉页码。
        """
        response = self.client.get(reverse('asset_list', args=['people']), {
            'q': '交换机', 'page': '3', 'page_size': '50',
        })
        table = bootstrap_of(response, 'people-workspace')['table']

        export_url = urlsplit(table['exportUrl'])
        self.assertEqual(export_url.path, reverse('table_export', args=['people']))
        self.assertEqual(parse_qs(export_url.query), {
            'q': ['交换机'], 'page_size': ['50'],
        })
        # 组件直接拿这个地址渲染链接，别处不能再拼一遍或丢掉。
        self.assertIn(':href="exportUrl"',
                      component_source('components', 'table_toolbar.mjs'))

    def test_unknown_table_and_scope_are_rejected(self):
        self.assertEqual(
            self.client.get(reverse('table_export', args=['passwords'])).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(reverse(
                'table_export_scoped', args=['inspection_records', 'unknown'],
            )).status_code,
            404,
        )


class ComputerAnalysisOutcomeTests(TestCase):
    def setUp(self):
        login_reader(self.client)
        computer = Computer.objects.create(computer_name='PC-OUTCOME')
        abnormal_log = create_log_file(
            source_path='abnormal.json',
            modified_at=timezone.now(),
            content_hash='a' * 64,
            import_status='success',
        )
        normal_log = create_log_file(
            source_path='normal.json',
            modified_at=timezone.now(),
            content_hash='b' * 64,
            import_status='success',
        )
        self.abnormal = ComputerAnalysis.objects.create(
            computer=computer,
            log_file=abnormal_log,
            status=RecordStatus.SUCCESS,
            summary='执行成功但发现异常',
        )
        self.normal = ComputerAnalysis.objects.create(
            computer=computer,
            log_file=normal_log,
            status=RecordStatus.SUCCESS,
            summary='未发现异常',
        )
        add_analysis_issue(self.abnormal, '磁盘异常', '磁盘剩余空间不足')
        profile = ComputerAnalysisProfile.objects.create(name='Outcome details', analysis_items=['resource'])
        self.task = TaskRun.objects.create(task_type='computer_analysis', source='manual', analysis_profile=profile)
        for record in (self.normal, self.abnormal):
            record.task_target = TaskTargetRun.objects.create(task=self.task, target_type='computer_log',
                target_id=str(record.log_file_id), result_type='computer_analysis', result_id=str(record.pk))
            record.save(update_fields=['task_target'])

    def test_anomaly_outcome_is_consistent_in_html_filter_options_and_csv(self):
        abnormal_response = self.client.get(
            reverse('task_detail', args=[self.task.pk]),
            {'filter_status': 'warning'},
        )
        normal_response = self.client.get(
            reverse('task_detail', args=[self.task.pk]),
            {'filter_status': 'normal'},
        )

        self.assertEqual(
            list(abnormal_response.context['page_obj'].object_list),
            [self.abnormal],
        )
        self.assertEqual(
            list(normal_response.context['page_obj'].object_list),
            [self.normal],
        )
        # 任务详情的筛选下拉由岛渲染，选项和选中值都在 bootstrap 里。
        abnormal_payload = payload_text(abnormal_response, 'detail-bootstrap')
        self.assertIn('warning', abnormal_payload)
        self.assertIn('警告', abnormal_payload)
        self.assertIn('warning', payload_text(abnormal_response, 'detail-bootstrap'))
        self.assertEqual(
            abnormal_response.context['table_state']['field_options']['status'],
            (('normal', '正常'), ('info', '提示'), ('warning', '警告'), ('critical', '严重')),
        )

        export_response = self.client.get(
            reverse('table_export', args=['computer_inspections']),
            {'filter_status': 'warning'},
        )
        rows = list(csv.DictReader(StringIO(
            response_body(export_response).decode('utf-8-sig'),
        )))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['分析结果'], '警告')
class PaginationWindowTests(TestCase):
    def test_page_window_keeps_neighbors_between_first_and_last_pages(self):
        from django.core.paginator import Paginator
        from index.templatetags.extras import page_window

        page = Paginator(list(range(200)), 10).page(10)

        self.assertEqual(page_window(page, radius=2), (8, 9, 10, 11, 12))

    def test_page_window_clamps_near_the_start(self):
        from django.core.paginator import Paginator
        from index.templatetags.extras import page_window

        page = Paginator(list(range(200)), 10).page(1)

        self.assertEqual(page_window(page, radius=2), (2, 3))


class DatetimeFilterSqlTests(TestCase):
    # P0-1: datetime 筛选必须留在原始列上做半开区间，不能用 __date。
    # 两层结果一样，差别在 SQL：__date 让 MariaDB 走 CONVERT_TZ(...)+DATE()，列索引失效；
    # mysql.time_zone_name 为空时 CONVERT_TZ 返回 NULL，整列筛选静默失效且不报错。
    definition = TableDefinition(
        'datetime_probe', '时间筛选探针',
        (TableField('at', '时间', 'started_at', 'datetime', True, True, True, False),),
        'at', 'desc', (), 25,
    )

    def test_datetime_range_compares_the_column_without_a_date_cast(self):
        request = RequestFactory().get('/', {
            'filter_at_from': '2026-10-01', 'filter_at_to': '2026-10-03',
        })
        queryset, _ = apply_table_filters(request, TaskRun.objects.all(), self.definition)
        sql = str(queryset.query).upper()
        self.assertNotIn('CONVERT_TZ', sql)
        self.assertNotIn('DATE(', sql)
        self.assertIn('>=', sql)

    def test_the_to_bound_is_exclusive_at_the_next_local_midnight(self):
        request = RequestFactory().get('/', {'filter_at_to': '2026-10-03'})
        queryset, _ = apply_table_filters(request, TaskRun.objects.all(), self.definition)
        sql, params = queryset.query.get_compiler(using='default').as_sql()
        self.assertNotIn('<=', sql)
        expected = timezone.make_aware(
            datetime(2026, 10, 4), timezone.get_current_timezone(),
        ).astimezone(dt_timezone.utc).replace(tzinfo=None)

        def instant(value):
            # MySQL 驱动给的是 UTC naive 字符串，psycopg 给的是带 +08:00 偏移的
            # datetime，两者表示同一瞬间。统一折算成 UTC naive 的字符串再比。
            if isinstance(value, datetime) and value.utcoffset() is not None:
                value = value.astimezone(dt_timezone.utc).replace(tzinfo=None)
            return str(value)

        self.assertIn(str(expected), [instant(value) for value in params])