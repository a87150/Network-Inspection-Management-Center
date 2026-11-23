from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from tests.auth import login_reader
from tests.inspections import test_latest_analysis_statistics as statistics_tests


class AnalysisProblemListTests(TestCase):
    task = statistics_tests.LatestAnalysisStatisticsTests.task
    analysis = statistics_tests.LatestAnalysisStatisticsTests.analysis

    def setUp(self):
        login_reader(self.client)
        self.run = self.task()
        self.url = f'/computers/analyses/tasks/{self.run.pk}/problems/'

    def bootstrap(self, response):
        """弹窗表格的数据全在 bootstrap 里，断言走它。"""
        self.assertEqual(response.status_code, 200)
        return response.context['problems_bootstrap']

    def test_reader_sees_only_requested_category_and_task_including_info(self):
        record = self.analysis(self.run, [
            {'analysis_item': 'software', 'severity': 'info', '问题类型': '软件未采集', '详细问题': '没有软件清单'},
            {'analysis_item': 'cpu_health', 'severity': 'critical', '详细问题': 'UNRELATED-HARDWARE'},
        ])
        self.analysis(self.task(), [{'analysis_item': 'software', '详细问题': 'OLD-TASK-ISSUE'}])
        data = self.bootstrap(self.client.get(self.url, {'category': '软件'}))
        self.assertEqual([c['key'] for c in data['columns']],
                         ['asset', 'user', 'issue', 'severity', 'metrics'])
        self.assertEqual(data['count'], 1)
        row = data['rows'][0]['cells']
        self.assertEqual(row['asset']['text'], record.computer.computer_name)
        self.assertIn('没有软件清单', row['issue']['text'])
        self.assertEqual(row['severity']['text'], '提示')
        body = str(data['rows'])
        self.assertNotIn('UNRELATED-HARDWARE', body)
        self.assertNotIn('OLD-TASK-ISSUE', body)

    def test_guest_cannot_read_details(self):
        self.client.logout()
        response = self.client.get(self.url, {'category': '软件'})
        self.assertEqual(response.status_code, 302)
        self.assertIn('/login/', response.url)

    def test_category_requires_exact_token(self):
        self.analysis(self.run, [{'analysis_item': 'software', '详细问题': 'PRIVATE-ISSUE'}])
        data = self.bootstrap(self.client.get(self.url, {'category': '软'}))
        self.assertEqual(data['count'], 0)
        self.assertNotIn('PRIVATE-ISSUE', str(data['rows']))

    def test_database_paginates_before_loading_findings(self):
        for i in range(21):
            self.analysis(self.run, [{'analysis_item': 'software', '详细问题': f'问题-{i}'}])
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(self.url, {'category': '软件', 'page': 2})
        data = self.bootstrap(response)
        self.assertEqual(data['count'], 21)
        self.assertEqual(len(data['rows']), 1)
        # 列名的引号随后端而变，用 connection.ops 引一遍再断言。
        quoted = connection.ops.quote_name
        detail_queries = [q['sql'] for q in queries if quoted('exceptions') in q['sql']]
        self.assertEqual(len(detail_queries), 1)
        self.assertIn('LIMIT 1 OFFSET 20', detail_queries[0])
        self.assertNotIn(quoted('payload'), detail_queries[0])
        self.assertNotIn(quoted('details'), detail_queries[0])

    def test_untrusted_issue_content_is_escaped(self):
        self.analysis(self.run, [{'analysis_item': 'software', '详细问题': '<script>alert(1)</script>'}])
        response = self.client.get(self.url, {'category': '软件'})
        data = self.bootstrap(response)
        # 数据走 json_script，尖括号被转成 \u003C，不会当成标签执行。
        self.assertNotContains(response, '<script>alert(1)</script>')
        self.assertIn('\\u003Cscript\\u003E', response.content.decode())
        self.assertIn('<script>alert(1)</script>', str(data['rows'][0]['cells']['issue']['text']))

    def test_summary_renders_clickable_category_without_preloading_details(self):
        self.analysis(self.run, [{'analysis_item': 'software', '详细问题': 'NOT-PRELOADED'}])
        response = self.client.get(reverse('computer_analysis_list'))
        self.assertContains(response, 'data-bs-target="#analysisProblemsModal"')
        self.assertContains(response, self.url)
        self.assertNotContains(response, 'NOT-PRELOADED')

    def test_metrics_column_replaces_detail_button_when_available(self):
        record = self.analysis(self.run, [
            {'analysis_item': 'cpu_health', 'severity': 'critical', '问题类型': '硬件', '详细问题': 'CPU温度问题'},
        ])
        type(record).objects.filter(pk=record.pk).update(
            report_metrics='CPU 78%、温度 91 °C、磁盘 C: 93%',
        )
        data = self.bootstrap(self.client.get(self.url, {'category': '硬件'}))
        metrics = data['rows'][0]['cells']['metrics']['text']
        self.assertIn('CPU 78%', metrics)
        self.assertIn('温度 91 °C', metrics)

    def test_sort_and_filter_reach_the_query_instead_of_being_ignored(self):
        """排序/筛选落在 SQL 层：换 order 或 filter 会真的改变命中行，不是空转参数。"""
        first = self.analysis(self.run, [
            {'analysis_item': 'software', 'severity': 'warning', '问题类型': '软件未采集', '详细问题': 'A'},
        ])
        second = self.analysis(self.run, [
            {'analysis_item': 'software', 'severity': 'info', '问题类型': '软件未采集', '详细问题': 'B'},
        ])
        # 等级筛选/排序读 report_severity；行里的中文等级仍由 exceptions 现算。
        type(first).objects.filter(pk=first.pk).update(report_severity='warning')
        type(second).objects.filter(pk=second.pk).update(report_severity='info')

        descending = self.bootstrap(self.client.get(self.url, {
            'category': '软件', 'sort': 'asset', 'order': 'desc',
        }))
        self.assertEqual(
            [row['cells']['asset']['text'] for row in descending['rows']],
            [second.computer.computer_name, first.computer.computer_name],
        )

        filtered = self.bootstrap(self.client.get(self.url, {
            'category': '软件', 'filter_severity': 'warning',
        }))
        self.assertEqual(filtered['count'], 1)
        self.assertEqual(filtered['rows'][0]['cells']['asset']['text'],
                         first.computer.computer_name)

    def test_island_requests_get_json_with_the_same_rows(self):
        """弹窗内翻页/排序/筛选打同一个地址，Accept 是 JSON 时只换数据格式。"""
        self.analysis(self.run, [
            {'analysis_item': 'software', 'severity': 'warning', '问题类型': '软件未采集'},
        ])
        response = self.client.get(
            self.url, {'category': '软件'}, HTTP_ACCEPT='application/json',
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['count'], 1)
        self.assertEqual(payload['results'], payload['rows'])
        severity = next(column for column in payload['columns'] if column['key'] == 'severity')
        self.assertEqual(severity['optionMode'], 'fixed')
        self.assertEqual(
            [option['label'] for option in severity['options']],
            ['正常', '提示', '警告', '严重'],
        )

    def test_metrics_column_falls_back_to_detail_button_when_empty(self):
        record = self.analysis(self.run, [
            {'analysis_item': 'cpu_health', 'severity': 'critical', '问题类型': '硬件', '详细问题': 'CPU温度问题'},
        ])
        type(record).objects.filter(pk=record.pk).update(report_metrics='')
        data = self.bootstrap(self.client.get(self.url, {'category': '硬件'}))
        self.assertEqual(data['rows'][0]['cells']['metrics']['text'], '—')
