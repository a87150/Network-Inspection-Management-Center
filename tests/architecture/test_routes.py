import hashlib
import uuid
from html.parser import HTMLParser

from django.test import TestCase
from django.urls import reverse
from tests.auth import login_admin, login_reader
from tests.payloads import bootstrap, payload_text, workspace_detail_text, workspace_text
from tests.devices.pc.helpers import analysis_task_url
from django.utils import timezone

from net.models import (
    Computer,
    ComputerAnalysis,
    ComputerLogFile,
    Domain_Account,
    Domain_Computer,
    WeakCurrentDevice,
    Monitor_Inspection,
    Network_Device,
    Network_Device_Inspection,
    People,
    Server,
    Server_Inspection,
)


class HiddenFormFieldParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = {}

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'input' and attributes.get('type') == 'hidden':
            name = attributes.get('name')
            if name:
                self.fields[name] = attributes.get('value', '')


def submitted_hidden_fields(response):
    parser = HiddenFormFieldParser()
    parser.feed(response.content.decode(response.charset))
    return parser.fields


class DetailRouteTests(TestCase):
    def setUp(self):
        login_reader(self.client)
        self.person = People.objects.create(
            name='张三', employee_id='EMP-001', department='运维部',
        )
        self.computer = Computer.objects.create(
            computer_name='PC-ROUTE-01', ip_addresses='192.0.2.11',
        )
        self.network = Network_Device.objects.create(
            device_name='SW-ROUTE-01', ip='192.0.2.21', vendor='Cisco',
        )
        self.server = Server.objects.create(
            name='SRV-ROUTE-01', ip='192.0.2.31', server_type='linux',
        )
        self.monitor = WeakCurrentDevice.objects.create(
            device_name='CAM-ROUTE-01', ip='192.0.2.41', vendor='Hikvision',
        )
        self.domain_account = Domain_Account.objects.create(
            account_name='域用户', login_name='EXAMPLE\\domain-user',
        )
        self.domain_computer = Domain_Computer.objects.create(
            computer_name='DOMAIN-PC-01', os='Windows 11',
        )

        payload = {'computer_name': self.computer.computer_name}
        self.log_file = ComputerLogFile.objects.create(
            computer=self.computer, collected_date=timezone.localdate(),
            collected_at=timezone.now(), platform='windows',
            content_hash=hashlib.sha256(b'route-test').hexdigest(),
            payload=payload,
        )
        self.analysis = ComputerAnalysis.objects.create(
            computer=self.computer,
            log_file=self.log_file,
            summary='CPU 使用率异常',
            details={'cpu': {'usage_percent': 88}},
        )
        self.network_record = Network_Device_Inspection.objects.create(
            device=self.network,
            summary='CPU 使用率异常',
            details={'cpu': {'usage_percent': 88}},
        )
        self.server_record = Server_Inspection.objects.create(
            server=self.server,
            summary='服务器巡检完成',
        )
        self.monitor_record = Monitor_Inspection.objects.create(
            monitor=self.monitor,
            summary='弱电设备巡检完成',
        )

    def test_every_asset_kind_has_list_and_detail(self):
        cases = (
            ('people', self.person.pk),
            ('computers', self.computer.pk),
            ('networks', self.network.pk),
            ('servers', self.server.pk),
            ('weakcurrent', self.monitor.pk),
        )

        for kind, pk in cases:
            with self.subTest(kind=kind):
                list_response = self.client.get(reverse('asset_list', args=[kind]))
                detail_url = reverse('asset_detail', args=[kind, pk])
                self.assertEqual(list_response.status_code, 200)
                self.assertContains(list_response, detail_url)
                self.assertEqual(self.client.get(detail_url).status_code, 200)

    def test_person_has_a_named_detail_route(self):
        detail_url = reverse('person_detail', args=[self.person.pk])

        response = self.client.get(detail_url)

        self.assertEqual(response.status_code, 200)
        # 深链落在工作区里，人还是那个人，只是详情与列表同屏。
        self.assertIn(self.person.employee_id, workspace_detail_text(response))

    def test_unknown_asset_kinds_and_missing_assets_return_404(self):
        self.assertEqual(
            self.client.get(reverse('asset_list', args=['unknown'])).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                reverse('asset_detail', args=['people', uuid.uuid4()]),
            ).status_code,
            404,
        )

    def test_asset_list_contains_only_static_fields(self):
        response = self.client.get(reverse('asset_list', args=['networks']))

        self.assertContains(response, self.network.device_name)
        self.assertNotContains(response, '最近巡检时间')
        self.assertNotContains(response, '最新状态')
        self.assertNotContains(response, self.network_record.summary)

    def test_asset_detail_links_to_history_and_shows_latest_summary(self):
        response = self.client.get(
            reverse('asset_detail', args=['networks', self.network.pk]),
        )

        history_url = reverse('asset_list', args=['networks']) + '?object=records'
        # 详情和工作区同屏：payload 在 initialDetail 里。
        body = workspace_detail_text(response)
        # 弹窗里的跳转按钮已移除，历史链接不该再出现；摘要仍然要给。
        self.assertNotIn(f'{history_url}&target={self.network.pk}', body)
        self.assertIn(self.network_record.summary, body)

    def test_infrastructure_history_filter_submission_keeps_asset_scope(self):
        other = Network_Device.objects.create(
            device_name='SW-ROUTE-OTHER', ip='192.0.2.22',
        )
        Network_Device_Inspection.objects.create(
            device=other, summary='另一台设备巡检完成',
        )
        history_url = reverse('asset_list', args=['networks'])
        # 筛选表单搬进组件后没有可回传的隐藏字段，提交的参数由调用方显式给出；
        # 这里守的还是同一件事：target 决定范围，筛选只在该范围内收窄。
        submitted = {
            'object': 'records', 'target': str(self.network.pk),
            'filter_asset': 'SW-ROUTE', 'page_size': '50',
        }
        initial = self.client.get(history_url, submitted)

        self.assertEqual(initial.status_code, 200)
        self.assertEqual(
            [record['asset'] for record in initial.context['page_obj']],
            [str(self.network)],
        )

        # 面板自己的筛选走 bootstrap 声明的表格端点：filter_category 钉住本页
        # 设备类别，提交筛选不会退回全站记录列表。
        records_table = bootstrap(initial, 'network-workspace-bootstrap')['logs']
        self.assertIn('filter_category=', records_table['endpoint'])
        response = self.client.get(
            records_table['endpoint'],
            {'filter_asset': str(self.network), 'page_size': '50'},
        )

        self.assertEqual(
            [row['cells']['asset']['text'] for row in response.json()['results']],
            [str(self.network)],
        )

    def test_computer_history_filter_submission_keeps_asset_scope(self):
        other_computer = Computer.objects.create(computer_name='PC-ROUTE-OTHER')
        other_log = ComputerLogFile.objects.create(
            computer=other_computer, collected_date=timezone.localdate(),
            collected_at=timezone.now(), platform='windows',
            content_hash=hashlib.sha256(b'route-test-other').hexdigest(),
            payload={'computer_name': other_computer.computer_name},
        )
        ComputerAnalysis.objects.create(
            computer=other_computer,
            log_file=other_log,
            summary='另一台计算机分析完成',
        )
        history_url = analysis_task_url(self.analysis)
        initial = self.client.get(history_url, {'target': self.computer.pk})
        submitted = submitted_hidden_fields(initial)
        submitted.update({'filter_computer_name': 'PC-ROUTE', 'page_size': '50'})

        response = self.client.get(history_url, submitted)

        self.assertEqual(
            list(response.context['page_obj'].object_list),
            [self.analysis],
        )

    def test_each_infrastructure_record_kind_has_list_and_detail(self):
        cases = (
            ('networks', self.network_record),
            ('servers', self.server_record),
            ('weakcurrent', self.monitor_record),
        )

        for kind, record in cases:
            with self.subTest(kind=kind):
                list_response = self.client.get(reverse('record_list', args=[kind]))
                detail_url = reverse('record_detail', args=[kind, record.pk])
                self.assertEqual(list_response.status_code, 200)
                self.assertContains(list_response, detail_url)
                self.assertEqual(self.client.get(detail_url).status_code, 200)

    def test_computer_record_copy_uses_log_analysis_record_wording(self):
        task_url = analysis_task_url(self.analysis)
        list_response = self.client.get(reverse('computer_analysis_list'))
        detail_url = reverse('computer_analysis_detail', args=[self.analysis.pk])

        self.assertEqual(list_response.status_code, 200)
        self.assertContains(list_response, '分析记录')
        self.assertNotContains(list_response, '计算机巡检')
        self.assertContains(list_response, task_url)
        self.assertNotContains(list_response, detail_url)
        # 任务详情的操作列现在直接给原始日志，分析详情不再从那里进。
        log_url = reverse('computer_log_detail', args=[self.analysis.log_file_id])
        self.assertIn(log_url, payload_text(self.client.get(task_url), 'detail-bootstrap'))

        detail_response = self.client.get(detail_url)
        self.assertEqual(detail_response.status_code, 200)
        self.assertContains(detail_response, '分析详情')
        self.assertNotContains(detail_response, '巡检详情')

    def test_old_computer_statistics_route_is_deleted(self):
        self.assertEqual(self.client.get('/detail/computers/').status_code, 404)

    def test_homepage_project_cards_expose_separate_workspace_entries(self):
        login_admin(self.client)
        response = self.client.get(reverse('index'))
        items = {item['key']: item for item in response.context['items']}
        expected = {
            'computers': (
                reverse('asset_list', args=['computers']),
                reverse('asset_list', args=['computers']) + '?object=analyses',
            ),
            # 记录视图现在是同一个页面上的方块视图，链接带 view 参数。
            'networks': (
                reverse('asset_list', args=['networks']),
                reverse('asset_list', args=['networks']) + '?object=records',
            ),
            'servers': (
                reverse('asset_list', args=['servers']),
                reverse('asset_list', args=['servers']) + '?object=records',
            ),
            'weakcurrent': (
                reverse('asset_list', args=['weakcurrent']),
                reverse('asset_list', args=['weakcurrent']) + '?object=records',
            ),
        }

        # 人员和部门合并成一页的两个视图：主按钮走人员，灰色按钮给部门。
        self.assertEqual(
            items['people']['list_url'],
            reverse('asset_list', args=['people']),
        )
        self.assertEqual(
            items['people']['department_url'],
            reverse('asset_list', args=['people']) + '?object=departments',
        )
        # 卡片是服务端模板渲染，入口直接看 HTML。
        body = response.content.decode()
        for key, (list_url, record_url) in expected.items():
            with self.subTest(key=key):
                self.assertEqual(items[key]['list_url'], list_url)
                self.assertEqual(items[key]['record_url'], record_url)
                self.assertIn(list_url, body)
                self.assertIn(record_url, body)

        # 人员统计已经并进人员页，首页不再单列入口。
        self.assertNotIn('巡检此类设备', body)
        self.assertNotIn('人员巡检', body)

    def test_homepage_uses_the_inspection_taskbar_instead_of_activity_panels(self):
        login_admin(self.client)
        response = self.client.get(reverse('index'))

        # 任务栏在 bootstrap 里，页面由岛渲染。
        self.assertEqual(response.context['index_bootstrap']['taskbar']['section_title'], '巡检任务栏')
        self.assertNotContains(response, '最新巡检与分析记录')
        self.assertNotContains(response, '全部设备最新异常')

    def test_consolidated_workspace_uses_neutral_execution_wording(self):
        response = self.client.get(reverse('inspection_records'))

        self.assertContains(response, '巡检与分析记录')
        self.assertContains(response, '执行时间')
        self.assertContains(response, '执行结果')
        self.assertContains(response, 'PC 分析')
        self.assertContains(
            response,
            reverse('computer_analysis_detail', args=[self.analysis.pk]),
        )
        self.assertNotContains(response, '全部巡检记录')

    def test_domain_objects_have_named_detail_routes(self):
        account_url = reverse(
            'domain_account_detail', args=[self.domain_account.pk],
        )
        computer_url = reverse(
            'domain_computer_detail', args=[self.domain_computer.pk],
        )

        account_list = self.client.get(reverse('domain_account_list'))
        computer_list = self.client.get(reverse('domain_computer_list'))

        self.assertContains(account_list, account_url)
        self.assertContains(computer_list, computer_url)
        self.assertEqual(self.client.get(account_url).status_code, 200)
        self.assertEqual(self.client.get(computer_url).status_code, 200)
