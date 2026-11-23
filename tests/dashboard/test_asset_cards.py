from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse
from tests.auth import login_admin, login_reader
from tests.payloads import payload_text, vue_component, workspace_detail_text

from net.models import Computer


class AssetDashboardUiTests(TestCase):
    def setUp(self):
        login_admin(self.client)
        self.pc = Computer.objects.create(
            computer_name='PC-DETAIL',
            cpu_model='Intel Core i7',
        )

    def test_home_uses_pc_copy_and_bottom_right_actions(self):
        """A card-layout regression must expose the latest-state copy and aligned actions."""
        response = self.client.get(reverse('index'))

        # 卡片由 Vue 从 bootstrap JSON 渲染：文案看 JSON，结构看组件模板。
        body = payload_text(response, 'dashboard-index-bootstrap')
        component = vue_component('pages/dashboard_index.mjs')
        self.assertIn('"name": "PC"', body)
        self.assertIn('人员总数', body)
        self.assertEqual(body.count('设备总数'), 3)
        self.assertIn('上次分析日期', body)
        self.assertIn('上次巡检日期', body)
        self.assertIn('"name": "域控管理"', body)
        for label in ('域账户', '域计算机', '域分组'):
            self.assertIn(label, component)
        self.assertIn('metric-card__footer metric-card__actions', component)
        self.assertIn('metric-card__last-run', component)

    def test_pc_detail_exposes_inventory_but_not_enabled(self):
        """PC details must retain static inventory while hiding collection-only enabled state."""
        login_reader(self.client)
        response = self.client.get(
            reverse('asset_detail', args=['computers', self.pc.pk]),
        )

        # 深链落进工作区，详情在 initialDetail 里。
        body = workspace_detail_text(response)
        self.assertIn('PC详情', body)
        self.assertIn('CPU 型号', body)
        self.assertNotIn('是否启用', body)

    def test_pc_list_uses_pc_copy_in_the_empty_state_and_data_note(self):
        """Replacing PC-facing text with ordinary-computer wording must be caught."""
        response = self.client.get(reverse('asset_list', args=['computers']))

        # 页头那行说明按设计去掉了，PC 口径仍由 context 提供、空态沿用它。
        self.assertEqual(
            response.context['data_source_note'],
            'PC 资料由终端采集器通过 API 上报日志后自动建立，无需导入设备清单。',
        )
        body = payload_text(response, 'pc-workspace-bootstrap')
        self.assertIn('请运行 PowerShell PC 信息采集脚本并上报。', body)
        self.assertNotIn('共享目录或 FTP', body)
class DashboardHierarchyTests(TestCase):
    def setUp(self):
        login_admin(self.client)

    def summaries(self):
        common = {'total': 10, 'normal': 10, 'abnormal': 0, 'unchecked': 0, 'last_run_at': None}
        return [
            {'key': 'people', **common},
            {'key': 'domain_accounts', **common},
            {'key': 'domain_computers', **common},
            {'key': 'domain_groups', **common},
            {'key': 'computers', **common},
            {'key': 'networks', **common, 'normal': 6, 'abnormal': 4},
            {'key': 'servers', **common, 'normal': 9, 'abnormal': 1},
            {'key': 'weakcurrent', **common},
        ]

    def test_cards_keep_the_original_fixed_order_even_when_attention_counts_change(self):
        with patch('index.dashboard.views.build_asset_card_summaries', return_value=self.summaries()):
            response = self.client.get(reverse('index'))

        keys = [item['key'] for item in response.context['items']]
        self.assertEqual(
            keys,
            ['people', 'domain', 'computers', 'networks', 'servers', 'weakcurrent'],
        )

    def test_every_card_has_one_primary_action_and_compact_secondary_actions(self):
        with patch('index.dashboard.views.build_asset_card_summaries', return_value=self.summaries()):
            response = self.client.get(reverse('index'))

        for item in response.context['items']:
            with self.subTest(card=item['key']):
                self.assertTrue(item['primary_action']['url'])
                self.assertIn('secondary_actions', item)
        # 一个卡片一个主按钮：数据在 JSON（每个 item 都有 primary_action），
        # 结构在组件模板里只写一次。
        component = vue_component('pages/dashboard_index.mjs')
        self.assertIn('metric-card__primary-action', component)
        self.assertIn('metric-card__secondary-actions', component)
        self.assertIn('dashboard-refreshed-at', component)
        self.assertEqual(
            len([item for item in response.context['items'] if item.get('primary_action')]), 6,
        )

        pc_item = next(item for item in response.context['items'] if item['key'] == 'computers')
        self.assertEqual(
            [action['label'] for action in pc_item['secondary_actions']],
            ['PC列表', '日志列表', '分析记录'],
        )

    def test_empty_task_region_is_collapsed_but_remains_available(self):
        with patch('index.dashboard.views.build_asset_card_summaries', return_value=self.summaries()):
            response = self.client.get(reverse('index'))

        # 任务栏是岛渲染的，空态由组件按 rows 判断。
        bar = response.context['index_bootstrap']['taskbar']
        self.assertEqual(bar['rows'], [])
        self.assertEqual(bar['empty_title'], '暂无巡检任务')
