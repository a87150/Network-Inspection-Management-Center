"""页头按钮按页面职责拆开：每页一份片段，按钮集合互不相同。"""
import re

from django.test import TestCase
from django.urls import reverse

from net.models import (
    ComputerAnalysisProfile, InspectionProfile, Network_Device, PCUploadConfig,
    People, Server, WeakCurrentDevice,
)
from tests.auth import login_admin
from tests.frontend.template_root import TemplateRoot


# 模板 -> 它自己的 action 片段。共享层 common/workspace_actions.html 只留 class 规则。
PAGE_FRAGMENTS = {
    'devices/list.html': 'devices/_actions_list.html',
    'inspections/record_list.html': 'inspections/_actions_records.html',
    'people/people.html': 'people/_actions_people.html',
    'pc/pc.html': 'pc/_actions_pc.html',
    'network/network.html': 'network/_actions_network.html',
    'server/server.html': 'server/_actions_server.html',
    'weakcurrent/weakcurrent.html': 'weakcurrent/_actions_weakcurrent.html',
}

CONFIG_LABELS = ('配置模板', '巡检配置', '分析配置', '告警配置', '问题等级设置')
ACTION_LABELS = ('添加设备', '导入设备', '导入人员', '手动执行巡检', '手动执行分析',
                 '下载 Windows 脚本', '下载 Windows 采集包', '下载 macOS 采集脚本')
NAV_LABELS = ('人员统计',)

EXPECTED_ACTIONS = {
    'networks': ['配置模板', '巡检配置', '告警配置', '添加设备', '导入设备', '手动执行巡检'],
    'servers': ['配置模板', '巡检配置', '告警配置', '下载 Windows 脚本', '添加设备',
                '导入设备', '手动执行巡检'],
    'weakcurrent': ['巡检配置', '告警配置', '添加设备', '导入设备', '手动执行巡检'],
    'computers': ['问题等级设置', '分析配置', '告警配置', '下载 Windows 采集包',
                  '下载 macOS 采集脚本', '手动执行分析'],
    'people': ['导入人员', '人员统计'],
    'records': ['配置模板', '巡检配置', '告警配置', '手动执行巡检'],
    'record_servers': ['配置模板', '巡检配置', '告警配置', '下载 Windows 脚本', '手动执行巡检'],
    'analysis_records': ['问题等级设置', '分析配置', '告警配置', '手动执行分析'],
}


class WorkspaceButtonStyleTests(TestCase):
    """按钮规则：执行动作=蓝底白字且靠右，仅配置=白底蓝字，导航=白底灰字。"""

    def setUp(self):
        login_admin(self.client)
        Network_Device.objects.create(device_name='核心', ip='192.0.2.1')
        Server.objects.create(name='应用', ip='192.0.2.2')
        WeakCurrentDevice.objects.create(device_name='前门摄像机', ip='192.0.2.3')
        People.objects.create(name='张三', employee_id='E1')
        InspectionProfile.objects.create(
            name='网络默认', device_type='network_device', selected_items=['cpu'],
        )
        InspectionProfile.objects.create(
            name='服务器默认', device_type='server', selected_items=['cpu'],
        )
        InspectionProfile.objects.create(
            name='弱电默认', device_type='weak_current', selected_items=['channel_status'],
        )
        ComputerAnalysisProfile.objects.create(name='PC 默认分析', is_enabled=True)
        # 采集包入口只在有上传配置和默认档案时出现，这里配齐。
        PCUploadConfig.objects.create(pk=1, endpoint_url='https://example.invalid/api/pc/logs/')

    def page_urls(self):
        return {
            'networks': reverse('asset_list', args=['networks']),
            'servers': reverse('asset_list', args=['servers']),
            'weakcurrent': reverse('asset_list', args=['weakcurrent']),
            'computers': reverse('asset_list', args=['computers']),
            'people': reverse('asset_list', args=['people']),
            'records': reverse('record_list', args=['networks']),
            'record_servers': reverse('record_list', args=['servers']),
            'analysis_records': reverse('computer_analysis_list'),
        }

    def buttons(self, url):
        """页头 page-heading__actions 里的 (开标签, 文字)。"""
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, url)
        html = response.content.decode()
        at = html.index('class="page-heading__actions"')
        block = html[at:html.index('</header>', at)]
        return re.findall(r'(<(?:a|button)\b[^>]*>)([^<]*)<', block), block

    def labels(self, url):
        return [text.strip() for _tag, text in self.buttons(url)[0]]

    def tag_for(self, url, label):
        tags, _block = self.buttons(url)
        for tag, text in tags:
            if text.strip() == label:
                return tag
        self.fail(url + ' 页头没有按钮：' + label)

    def test_each_page_includes_its_own_action_fragment(self):
        for template, fragment in PAGE_FRAGMENTS.items():
            with self.subTest(template=template):
                source = (TemplateRoot.default() / template).read_text(encoding='utf-8')
                self.assertIn("{% include '" + fragment + "' %}", source)
                self.assertNotIn('common/workspace_actions.html', source)

    def test_shared_layer_keeps_only_the_class_rule(self):
        source = (TemplateRoot.default() / 'common' / 'workspace_actions.html').read_text(
            encoding='utf-8',
        )
        for rule in ('btn-outline-primary', 'btn-primary', 'btn-outline-secondary'):
            self.assertIn(rule, source)
        for label in CONFIG_LABELS + ACTION_LABELS + NAV_LABELS:
            self.assertNotIn(label, source)
        self.assertNotIn('<button', source)
        self.assertNotIn('<a class=', source)

    def test_every_page_renders_its_own_button_set(self):
        rendered = {}
        for key, url in self.page_urls().items():
            with self.subTest(page=key):
                rendered[key] = self.labels(url)
                self.assertEqual(rendered[key], EXPECTED_ACTIONS[key], key + ' 页头按钮')
        # 每页互不相同：没有哪两页还共用同一套按钮。
        sets = [frozenset(labels) for labels in rendered.values()]
        self.assertEqual(len(sets), len(set(sets)), '页面之间不该共用同一套按钮：' + repr(rendered))

    def test_button_class_rule(self):
        for key, url in self.page_urls().items():
            for label in self.labels(url):
                tag = self.tag_for(url, label)
                where = key + ' 页 ' + label
                if label in CONFIG_LABELS:
                    self.assertIn('btn-outline-primary', tag, where + ' 应为白底蓝字')
                elif label in NAV_LABELS:
                    self.assertIn('btn-outline-secondary', tag, where + ' 应为白底灰字')
                else:
                    self.assertIn('btn-primary', tag, where + ' 应为蓝底白字')
                    self.assertNotIn('btn-outline', tag, where + ' 不该是白底')

    def test_config_buttons_sit_left_of_action_buttons_and_nav_last(self):
        for key, url in self.page_urls().items():
            labels = self.labels(url)
            configs = [labels.index(label) for label in labels if label in CONFIG_LABELS]
            actions = [labels.index(label) for label in labels if label in ACTION_LABELS]
            if configs and actions:
                self.assertLess(max(configs), min(actions), key + '：配置按钮应在动作按钮之前')
            navs = [labels.index(label) for label in labels if label in NAV_LABELS]
            if navs:
                self.assertEqual(max(navs), len(labels) - 1, key + '：导航按钮应在最后')

    def test_record_views_still_render_header_buttons(self):
        """记录类视图曾把 header 开关全清零，页头一个按钮也没有。"""
        for url in (
            reverse('asset_list', args=['networks']) + '?object=records',
            reverse('asset_list', args=['computers']) + '?object=analyses',
            reverse('record_list', args=['servers']),
        ):
            with self.subTest(url=url):
                self.assertTrue(self.labels(url), url + ' 页头不该是空的')
