from datetime import date
from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse

from net.models import People
from tests.auth import login_reader
from tests.payloads import payload_text, vue_component


class PeopleStatisticsPageTests(TestCase):
    as_of = date(2026, 9, 2)

    def setUp(self):
        login_reader(self.client)
        People.objects.bulk_create([
            People(
                employee_id='P-001', name='甲', department='运维部',
                is_active=True, hire_date=date(2020, 1, 1),
            ),
            People(
                employee_id='P-002', name='乙', department='研发部',
                is_active=True, hire_date=date(2024, 1, 1),
            ),
            People(
                employee_id='P-003', name='丙', department='研发部',
                is_active=True, hire_date=date(2026, 2, 1),
            ),
            People(
                employee_id='P-004', name='丁', department='运维部',
                is_active=False, hire_date=date(2019, 1, 1),
                departure_date=date(2026, 3, 1),
            ),
            People(
                employee_id='P-005', name='戊', department='',
                is_active=False, departure_date=date(2026, 12, 1),
            ),
            People(
                employee_id='P-006', name='未来员工', department=None,
                is_active=True, hire_date=date(2026, 12, 1),
            ),
        ])

    @patch('django.utils.timezone.localdate', return_value=as_of)
    def test_statistics_page_uses_documented_people_metrics(self, _localdate):
        response = self.client.get('/people/statistics/')

        self.assertEqual(response.status_code, 200)
        metrics = response.context['metrics']
        expected_average = round(sum(
            (self.as_of - hired).days
            for hired in (date(2020, 1, 1), date(2024, 1, 1), date(2026, 2, 1))
        ) / 3 / 365.25, 1)
        self.assertEqual(metrics, {
            'total': 6,
            'active': 4,
            'departed': 2,
            'active_rate': 66.7,
            'average_active_tenure_years': expected_average,
            'tenure_sample_count': 3,
            'hires_this_year': 1,
            'departures_this_year': 1,
        })
        # 页面由 Vue 从 bootstrap JSON 渲染，数字与文案断言落在 JSON 上。
        body = payload_text(response, 'people-statistics-bootstrap')
        self.assertIn('人员统计', body)
        self.assertIn(f'{expected_average:.1f}', body)
        self.assertIn('仅统计 [[ tenure.sample ]] 名有有效入职日期的在职人员',
                      vue_component('pages/people_statistics.mjs'))

    @patch('django.utils.timezone.localdate', return_value=as_of)
    def test_department_table_merges_blank_departments_and_counts_status(self, _localdate):
        response = self.client.get('/people/statistics/')

        self.assertEqual(response.status_code, 200)
        departments = {
            row['department']: row for row in response.context['departments']
        }
        self.assertEqual(departments, {
            '研发部': {
                'department': '研发部', 'total': 2, 'active': 2,
                'departed': 0, 'active_rate': 100.0,
            },
            '运维部': {
                'department': '运维部', 'total': 2, 'active': 1,
                'departed': 1, 'active_rate': 50.0,
            },
            '未分配部门': {
                'department': '未分配部门', 'total': 2, 'active': 1,
                'departed': 1, 'active_rate': 50.0,
            },
        })
        main_content = response.content.decode(response.charset).split(
            '<main ', 1,
        )[1].split('</main>', 1)[0]
        self.assertNotIn('>人员列表</a>', main_content)

    def test_home_people_card_links_to_statistics_without_changing_list_entry(self):
        response = self.client.get(reverse('index'))
        people = next(
            item for item in response.context['items'] if item['key'] == 'people'
        )

        # 主按钮进人员，灰色按钮进部门，是同一页的两个视图。
        self.assertEqual(
            people['list_url'], reverse('asset_list', args=['people']),
        )
        self.assertEqual(
            people['department_url'],
            reverse('asset_list', args=['people']) + '?object=departments',
        )
        self.assertEqual(people['primary_action']['label'], '手动同步人员')
        # 统计并进人员工作区后，首页不再单列 /people/statistics/ 入口，部门视图
        # （?object=departments）承接它；直达路由本身仍在，访客汇总页也用它。
        self.assertIn(people['department_url'],
                      payload_text(response, 'dashboard-index-bootstrap'))
        self.assertEqual(
            self.client.get(reverse('people_statistics')).status_code, 200,
        )

    def test_empty_statistics_page_returns_zero_values(self):
        People.objects.all().delete()

        response = self.client.get('/people/statistics/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context['metrics']['total'], 0)
        self.assertEqual(response.context['metrics']['active_rate'], 0.0)
        self.assertEqual(
            response.context['metrics']['average_active_tenure_years'], 0.0,
        )
        self.assertEqual(response.context['departments'], [])
