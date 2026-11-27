"""停用的设备不画拓扑、不进巡检。

停用表示这台设备已经不在用了：拆机、下架、报废。它留在台账里是为了保住历史
记录和配置备份，但不该再出现在拓扑图上（画出来会让人以为链路还在），也不该被
拉进巡检任务（白跑一趟再留一条失败告警）。
"""

from django.test import TestCase

from inspections.tasks import _filtered_queryset
from net.models import InspectionProfile, Network_Device, Server
from topology.operations import _asset_sources


def device(name, ip, *, enabled=True):
    return Network_Device.objects.create(
        device_name=name, ip=ip, device_type='switch', vendor='h3c', is_enabled=enabled,
    )


class TopologySkipsDisabledDevicesTests(TestCase):
    def test_disabled_network_device_is_not_an_asset_node(self):
        device('在用交换机', '192.0.2.11')
        device('停用旧交换机', '192.0.2.12', enabled=False)

        rows = dict(_asset_sources())
        names = [row.device_name for row in rows['networks']]

        self.assertIn('在用交换机', names)
        self.assertNotIn('停用旧交换机', names)

    def test_disabled_server_is_not_an_asset_node(self):
        Server.objects.create(name='在用服务器', ip='192.0.2.21', server_type='linux')
        Server.objects.create(
            name='停用旧服务器', ip='192.0.2.22', server_type='linux', is_enabled=False)

        rows = dict(_asset_sources())
        names = [row.name for row in rows['servers']]

        self.assertIn('在用服务器', names)
        self.assertNotIn('停用旧服务器', names)

    def test_disabled_device_does_not_inflate_the_truncation_count(self):
        """被排除的设备不该算进「另有 N 台未绘制」。"""
        for index in range(3):
            device('在用-%d' % index, '192.0.2.%d' % (30 + index))
        device('停用', '192.0.2.40', enabled=False)

        _rows, truncated = _asset_sources_count()

        self.assertEqual(truncated, 0)


def _asset_sources_count():
    from topology.operations import _selected_rows

    queryset = dict(_asset_sources())['networks']
    return _selected_rows('networks', queryset, set())


class InspectionSkipsDisabledDevicesTests(TestCase):
    def setUp(self):
        self.profile = InspectionProfile.objects.create(
            name='停用口径', device_type='network_device', selected_items=['cpu'],
        )

    def test_filtered_targets_exclude_disabled_devices(self):
        from django.http import QueryDict

        device('在用交换机', '192.0.2.51')
        device('停用旧交换机', '192.0.2.52', enabled=False)

        queryset, _state = _filtered_queryset(QueryDict(''), self.profile)
        names = list(queryset.values_list('device_name', flat=True))

        self.assertIn('在用交换机', names)
        self.assertNotIn('停用旧交换机', names)
