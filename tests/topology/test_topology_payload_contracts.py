"""拓扑快照的口径契约。

五个容易静默退化的地方：PC 的在线状态、跨场地网段挂载、首屏详情裁剪、
「另有 N 个未绘制」的差额、每台资产的最新巡检结果。
"""

import uuid
from datetime import UTC, datetime
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase

from net.models import Computer, Network_Device, Network_Device_Inspection
from topology.operations import _build_topology, _reachability
from topology.presentation import (
    _endpoint_nodes,
    _network_node,
    _subnet_parent,
    address_networks,
    build_enterprise_topology,
)


def backbone(pk, site, ip):
    return {
        'id': 'networks:%s' % pk,
        'role': 'access_switch',
        'tier': 3,
        'site': site,
        '_networks': address_networks(ip),
    }


def endpoint(site, ip):
    return {'id': 'computers:1', 'site': site, '_networks': address_networks(ip)}


class ComputerStatusTests(TestCase):
    """Computer 没有巡检记录，状态不能永远停在 unknown。"""

    def test_active_computer_is_not_unknown(self):
        computer = Computer.objects.create(
            computer_name='PC-001', ip_addresses='192.0.2.31', is_active=True,
        )

        node = _endpoint_nodes([computer], [], [], with_details=False)[0]

        self.assertNotEqual(node['status'], 'unknown')

    def test_inactive_computer_is_disabled(self):
        computer = Computer.objects.create(
            computer_name='PC-002', ip_addresses='192.0.2.32', is_active=False,
        )

        node = _endpoint_nodes([computer], [], [], with_details=False)[0]

        self.assertEqual(node['status'], 'disabled')


class SubnetParentSiteTests(SimpleTestCase):
    """分支 VPN 复用同一个 /24 时，终端必须挂回自己场地的交换机。"""

    def test_same_site_candidate_wins_over_foreign(self):
        foreign = backbone('a-remote', '分部', '192.168.7.1')
        local = backbone('z-local', '总部', '192.168.7.2')

        parent = _subnet_parent(endpoint('总部', '192.168.7.60'), [foreign, local])

        self.assertEqual(parent['id'], 'networks:z-local')

    def test_unique_foreign_candidate_is_still_used(self):
        only = backbone('only', '分部', '192.168.9.1')

        parent = _subnet_parent(endpoint('总部', '192.168.9.60'), [only])

        self.assertEqual(parent['id'], 'networks:only')

    def test_ambiguous_foreign_candidates_are_not_guessed(self):
        first = backbone('a', '分部', '192.168.11.1')
        second = backbone('b', '分部', '192.168.11.2')

        parent = _subnet_parent(endpoint('总部', '192.168.11.60'), [first, second])

        self.assertIsNone(parent)


class NetworkNodeDetailsTests(TestCase):
    """with_details=False 时不该为每个网络设备算 17 个详情字段再看都不看。"""

    def device(self, name, ip, **kwargs):
        return Network_Device.objects.create(
            device_name=name, ip=ip, device_type='switch', vendor='h3c', **kwargs,
        )

    def test_network_node_returns_empty_details_without_computing_them(self):
        """首屏不算详情：键仍在、值是空数组，且真的没有去算那十几个字段。

        键不能省——接口形状不该随请求方式变，dashboard 侧断言 details 恒为列表。
        """
        device = self.device('交换机', '192.0.2.20')
        with patch('topology.presentation._details') as details:
            node = _network_node(device, with_details=False)

        details.assert_not_called()
        self.assertEqual(node['details'], [])

    def test_network_node_keeps_details_by_default(self):
        node = _network_node(self.device('交换机2', '192.0.2.21'))

        self.assertIn('details', node)

    def test_topology_payload_keeps_empty_details_when_trimmed(self):
        device = self.device('交换机3', '192.0.2.22')
        computer = Computer.objects.create(
            computer_name='PC-003', ip_addresses='192.0.2.33', is_active=True,
        )

        topology = build_enterprise_topology(
            network_devices=[device], computers=[computer], servers=[], weak_current=[],
            physical={'links': []}, with_details=False,
        )

        for node in topology['nodes']:
            self.assertEqual(node['details'], [], node['id'])


class AssetTruncationTests(TestCase):
    """「另有 N 个设备未绘制」必须等于总数减真实画出来的数量。"""

    def setUp(self):
        self.devices = [
            Network_Device.objects.create(
                device_name='SW-%03d' % index,
                ip='198.51.%d.%d' % (index // 200, index % 200 + 1),
                device_type='switch',
                vendor='h3c',
            )
            for index in range(100)
        ]

    def disable(self, indexes):
        Network_Device.objects.filter(
            pk__in=[self.devices[index].pk for index in indexes],
        ).update(is_enabled=False)

    def links(self, pairs):
        return [
            {
                'local_device_id': str(self.devices[left].pk),
                'remote_device_id': str(self.devices[right].pk),
                'resolution_status': 'resolved',
                'status': 'current',
            }
            for left, right in pairs
        ]

    def drawn(self, topology):
        return sum(
            1 for node in topology['nodes'] if node['id'].startswith('networks:')
        )

    def test_truncation_matches_undrawn_count(self):
        # 90 台设备是链路端点，全部保留；剩下 10 台被截断。
        pairs = [(index * 2, index * 2 + 1) for index in range(45)]

        topology = _build_topology(physical={'links': self.links(pairs)})

        self.assertEqual(self.drawn(topology), 90)
        self.assertEqual(topology['asset_truncation']['networks'], 100 - self.drawn(topology))

    def test_truncation_counts_devices_dropped_after_selection(self):
        # 70 台是链路端点；剩下 30 台停用且没连线。配额只剩 10 台，选中的都是
        # 停用设备，presentation 一台都不画。差额要按画出来的 70 台算，不是 80 台。
        self.disable(range(70, 100))
        pairs = [(index * 2, index * 2 + 1) for index in range(35)]

        topology = _build_topology(physical={'links': self.links(pairs)})

        self.assertEqual(self.drawn(topology), 70)
        self.assertEqual(topology['asset_truncation']['networks'], 30)

    def test_retained_endpoints_reason_is_reported(self):
        # 端点数量超过每类上限时，差额的原因要能和普通截断分开。
        pairs = [(index * 2, index * 2 + 1) for index in range(45)]

        topology = _build_topology(physical={'links': self.links(pairs)})

        self.assertIn('networks_retained', topology['asset_truncation'])


class ReachabilitySnapshotTests(TestCase):
    """每台资产只认最后一条巡检记录，同一时刻取主键更大的那条。"""

    def test_latest_inspection_wins(self):
        device = Network_Device.objects.create(
            device_name='巡检机', ip='192.0.2.40', device_type='switch', vendor='h3c',
        )
        Network_Device_Inspection.objects.create(
            id=uuid.UUID(int=1), device=device, is_reachable=True,
        )
        Network_Device_Inspection.objects.create(
            id=uuid.UUID(int=2), device=device, is_reachable=False,
        )
        # created_at 是 auto_now_add，只能绕过 save 把两次巡检压到同一时刻。
        Network_Device_Inspection.objects.update(created_at=datetime(2026, 1, 1, tzinfo=UTC))

        self.assertIs(_reachability()['networks:%s' % device.pk], False)
