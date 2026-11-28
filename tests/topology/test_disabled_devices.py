"""停用的设备：拓扑画灰不可点，巡检不拉。

停用表示设备已不在用（拆机、下架、报废）。它还留在台账里以保住历史记录和配置
备份。拓扑上要画出来但标成 disabled —— 直接摘掉会让「停用」和「掉线」长得一样，
前者是人为下架，后者是故障，两者必须能分开。巡检则不拉，因为它连不上，拉进去
只会白跑一趟再留一条失败告警。
"""

from django.http import QueryDict
from django.utils import timezone
from django.test import TestCase

from inspections.tasks import _filtered_queryset
from net.models import InspectionProfile, Network_Device, Server
from net.models import NetworkTopologyInterface, NetworkTopologyLink
from topology.operations import _asset_sources
from topology.presentation import _endpoint_nodes, _network_node, build_enterprise_topology


def device(name, ip, *, enabled=True):
    return Network_Device.objects.create(
        device_name=name, ip=ip, device_type='switch', vendor='h3c', is_enabled=enabled,
    )


class TopologyMarksDisabledDevicesTests(TestCase):
    def node(self, **kwargs):
        return _network_node(device('待测交换机', '192.0.2.10', **kwargs))

    def test_disabled_device_is_still_drawn(self):
        node = self.node(enabled=False)
        self.assertEqual(node['label'], '待测交换机')
        self.assertEqual(node['status'], 'disabled')

    def test_enabled_device_is_unknown_until_inspected(self):
        """没有巡检记录时是 unknown，不是 normal —— 没查过和查过了必须能分开。"""
        self.assertEqual(self.node()['status'], 'unknown')

    def test_enabled_and_reachable_is_normal(self):
        node = _network_node(device('已巡检', '192.0.2.13'), reachable=True)
        self.assertEqual(node['status'], 'normal')

    def test_disabled_strategy_keeps_the_device_in_the_queryset(self):
        """不摘掉：查全，由 presentation 标状态。"""
        device('在用', '192.0.2.11')
        device('停用', '192.0.2.12', enabled=False)

        names = list(dict(_asset_sources())['networks'].values_list('device_name', flat=True))

        self.assertIn('在用', names)
        self.assertIn('停用', names)

    def test_disabled_server_is_marked_too(self):
        server = Server.objects.create(
            name='停用旧服务器', ip='192.0.2.22', server_type='linux', is_enabled=False)
        nodes = _endpoint_nodes([], [server], [], with_details=False)
        self.assertEqual(nodes[0]['status'], 'disabled')


class InspectionSkipsDisabledDevicesTests(TestCase):
    def setUp(self):
        self.profile = InspectionProfile.objects.create(
            name='停用口径', device_type='network_device', selected_items=['cpu'],
        )

    def test_filtered_targets_exclude_disabled_devices(self):
        device('在用交换机', '192.0.2.51')
        device('停用旧交换机', '192.0.2.52', enabled=False)

        queryset, _state = _filtered_queryset(QueryDict(''), self.profile)
        names = list(queryset.values_list('device_name', flat=True))

        self.assertIn('在用交换机', names)
        self.assertNotIn('停用旧交换机', names)



class DisabledWithoutLinkTests(TestCase):
    """停用且没有任何链路的设备不画；停用但还有链路的要画（灰）。"""

    def build(self, devices, links=()):
        from net.topology.read_model import link_payload

        return build_enterprise_topology(
            network_devices=devices, computers=[], servers=[], weak_current=[],
            physical={'links': [link_payload(link) for link in links]},
            with_details=False,
        )

    def link(self, left, right):
        now = timezone.now()
        left_if = NetworkTopologyInterface.objects.create(
            device=left, stable_key='if-%s' % left.pk, name='XGE1/0/1',
            first_seen_at=now, last_seen_at=now)
        NetworkTopologyInterface.objects.create(
            device=right, stable_key='if-%s' % right.pk, name='XGE1/0/2',
            first_seen_at=now, last_seen_at=now)
        return NetworkTopologyLink.objects.create(
            local_interface=left_if, remote_device=right,
            remote_port_id='XGE1/0/2', status='current', resolution_status='resolved',
            stable_link_key=str(left.pk)[:12],
            first_seen_at=now, last_seen_at=now,
        )

    def labels(self, topo):
        return {node['label']: node['status'] for node in topo['nodes']}

    def test_disabled_device_without_any_link_is_dropped(self):
        alive = device('在用', '192.0.2.61')
        dead = device('停用且没连线', '192.0.2.62', enabled=False)

        labels = self.labels(self.build([alive, dead]))

        self.assertIn('在用', labels)
        self.assertNotIn('停用且没连线', labels)

    def test_disabled_device_with_a_link_is_kept_and_greyed(self):
        alive = device('在用', '192.0.2.63')
        dead = device('停用但还有线', '192.0.2.64', enabled=False)
        link = self.link(alive, dead)

        labels = self.labels(self.build([alive, dead], [link]))

        self.assertEqual(labels.get('停用但还有线'), 'disabled')



class NodeStatusTests(TestCase):
    """四种状态各自有明确含义：停用 / 异常 / 正常 / 未知。"""

    counter = 0

    def status_for(self, *, enabled, reachable, linked=True):
        type(self).counter += 1
        base = 100 + type(self).counter * 2
        alive = device('对端', '192.0.2.%d' % base)
        target = device('被测', '192.0.2.%d' % (base + 1), enabled=enabled)
        links = []
        if linked:
            links.append(self.link(alive, target))
        topo = build_enterprise_topology(
            network_devices=[alive, target], computers=[], servers=[], weak_current=[],
            physical={'links': links}, with_details=False,
            reachability={'networks:%s' % target.pk: reachable},
        )
        return {node['label']: node['status'] for node in topo['nodes']}.get('被测')

    def link(self, left, right):
        from net.topology.read_model import link_payload

        now = timezone.now()
        left_if = NetworkTopologyInterface.objects.create(
            device=left, stable_key='if-%s' % left.pk, name='XGE1/0/1',
            first_seen_at=now, last_seen_at=now)
        NetworkTopologyInterface.objects.create(
            device=right, stable_key='if-%s' % right.pk, name='XGE1/0/2',
            first_seen_at=now, last_seen_at=now)
        return link_payload(NetworkTopologyLink.objects.create(
            local_interface=left_if, remote_device=right,
            remote_port_id='XGE1/0/2', status='current', resolution_status='resolved',
            stable_link_key=str(left.pk)[:12],
            first_seen_at=now, last_seen_at=now,
        ))

    def test_abnormal_is_not_disabled(self):
        self.assertEqual(self.status_for(enabled=True, reachable=False), 'abnormal')
        self.assertEqual(self.status_for(enabled=False, reachable=False), 'disabled')

    def test_reachable_device_is_normal(self):
        self.assertEqual(self.status_for(enabled=True, reachable=True), 'normal')

    def test_never_inspected_device_is_unknown(self):
        self.assertEqual(self.status_for(enabled=True, reachable=None), 'unknown')

    def test_disabled_wins_over_reachability(self):
        """停用的设备即使上次巡检失败，也不该报异常——它本来就不该被扫。"""
        self.assertEqual(self.status_for(enabled=False, reachable=False), 'disabled')
