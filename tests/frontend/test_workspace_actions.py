from django.test import TestCase
from django.urls import reverse

from net.models import Network_Device, Server, WeakCurrentDevice
from tests.auth import login_admin

# Every action either page must offer, per asset kind. 返回列表 已从页头移除：
# 顶部导航和方块都能回到列表，页头留这个按钮只是占位置。
SHARED_LABELS = ('配置模板', '下载 Windows 脚本', '添加设备', '导入设备',
                 '告警配置')


class WorkspaceActionParityTests(TestCase):
    """列表页 and 巡检/分析页 must expose the same actions for a kind."""

    def setUp(self):
        login_admin(self.client)
        Network_Device.objects.create(device_name='核心', ip='192.0.2.1')
        Server.objects.create(name='应用', ip='192.0.2.2')
        WeakCurrentDevice.objects.create(device_name='前门摄像机', ip='192.0.2.3')

    def labels(self, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, url)
        return response

    def test_device_kinds_keep_their_own_action_sets(self):
        """每页按钮本来就不同：列表页有增删导入，记录页只有配置和执行。"""
        for kind, model in (('networks', Network_Device), ('servers', Server)):
            listing = self.labels(reverse('asset_list', args=[kind]))
            records = self.labels(reverse('record_list', args=[kind]))
            # 列表页：能管设备才谈得上增删导入。
            self.assertContains(listing, '>添加设备<', msg_prefix=kind + ' 列表页')
            self.assertContains(listing, '>导入设备<', msg_prefix=kind + ' 列表页')
            # 记录页：设备增删和导入不在这里，只留配置与执行。
            self.assertNotContains(records, '>添加设备<', msg_prefix=kind + ' 记录页')
            self.assertNotContains(records, '>导入设备<', msg_prefix=kind + ' 记录页')
            for label in ('巡检配置', '告警配置', '手动执行巡检'):
                self.assertContains(listing, '>' + label + '<', msg_prefix=kind + ' 列表页 ' + label)
                self.assertContains(records, '>' + label + '<', msg_prefix=kind + ' 记录页 ' + label)
            if model is Server:
                self.assertContains(records, '>下载 Windows 脚本<', msg_prefix='servers 记录页')
            self.assertNotContains(listing, '返回列表', msg_prefix=kind)
            self.assertNotContains(records, '返回列表', msg_prefix=kind)

    def test_pc_pages_match_and_offer_the_pc_only_actions(self):
        listing = self.labels(reverse('asset_list', args=['computers']))
        records = self.labels(reverse('computer_analysis_list'))
        self.assertContains(listing, '>问题等级设置<')
        self.assertContains(records, '>问题等级设置<')
        # PC data arrives from the collector, so neither page offers add/import.
        for page, name in ((listing, '列表页'), (records, '记录页')):
            self.assertNotContains(page, '>添加设备<', msg_prefix=name)
            self.assertNotContains(page, '>导入设备<', msg_prefix=name)
        self.assertNotContains(records, '返回列表')

    def test_weak_current_record_page_offers_add_and_import(self):
        """The record page gained the add/import modals; prove the buttons work."""
        records = self.labels(reverse('record_list', args=['weakcurrent']))
        self.assertContains(records, 'id="deviceFormModal"')
        self.assertContains(records, 'id="importModal"')
        self.assertContains(records, 'id="collectionTemplateModal"')

