"""主干父子关系：链路是网状，树只是呈现，父必须比子更靠近出口。"""

from django.test import SimpleTestCase

from topology.presentation import backbone_parents, network_role as network_role_of


def node(pk, *, tier, label, role='access_switch'):
    return {'id': f'networks:{pk}', 'kind': 'backbone', 'tier': tier, 'label': label, 'role': role}


def link(local, remote, status='resolved'):
    return {
        'local_device_id': local, 'remote_device_id': remote,
        'resolution_status': status, 'status': 'current',
    }


class BackboneHierarchyTests(SimpleTestCase):
    def test_parent_is_the_hop_closer_to_the_exit(self):
        exit_node = node('fw', tier=0, label='FW', role='firewall')
        core_node = node('core', tier=1, label='CORE', role='core_switch')
        access_node = node('access', tier=3, label='ACCESS')

        parents = backbone_parents(
            [access_node, exit_node, core_node],
            [link('fw', 'core'), link('core', 'access')],
        )

        self.assertEqual(parents[core_node['id']], exit_node['id'])
        self.assertEqual(parents[access_node['id']], core_node['id'])
        self.assertNotIn(exit_node['id'], parents)

    def test_unresolved_links_do_not_create_edges(self):
        left = node('a', tier=1, label='A', role='core_switch')
        right = node('b', tier=3, label='B')

        parents = backbone_parents([left, right], [link('a', 'b', status='unresolved')])

        self.assertEqual(parents, {})

    def test_mesh_becomes_a_spanning_tree_without_cycles(self):
        nodes = [
            node('fw', tier=0, label='FW', role='firewall'),
            node('core1', tier=1, label='CORE-1', role='core_switch'),
            node('core2', tier=1, label='CORE-2', role='core_switch'),
            node('access', tier=3, label='ACCESS'),
        ]
        links = [
            link('fw', 'core1'), link('fw', 'core2'), link('core1', 'core2'),
            link('core1', 'access'), link('core2', 'access'),
        ]

        parents = backbone_parents(nodes, links)

        self.assertEqual(len(parents), 3)
        for child, parent in parents.items():
            self.assertNotEqual(child, parent)
        # 顺着父指针一定能走到根，不会绕圈。
        for start in parents:
            seen = set()
            current = start
            while current in parents:
                self.assertNotIn(current, seen)
                seen.add(current)
                current = parents[current]

    def test_chinese_ledger_words_pick_the_right_tier(self):
        class Device:
            def __init__(self, device_type, device_name='', model=''):
                self.device_type, self.device_name, self.model = device_type, device_name, model

        self.assertEqual(network_role_of(Device('接入', 'A-2F')), 'access_switch')
        self.assertEqual(network_role_of(Device('POE交换机', 'POE-1')), 'access_switch')
        self.assertEqual(network_role_of(Device('汇聚', 'AGG-1')), 'distribution_switch')
        self.assertEqual(network_role_of(Device('核心', 'CORE-1')), 'core_switch')


class NetworkRoleFieldTests(SimpleTestCase):
    """台账显式标注的 network_role 优先于按名称猜。

    device_type 只能说「这是台交换机」，分不出核心/汇聚/接入；靠 device_name
    里的字猜层级是运气——设备叫 Core-01 或者 SW-CORE 时就猜不出来，会悄悄
    从核心层掉到接入层。所以层级改成独立字段，由用户按现场实际填。
    """

    def role(self, device_type, device_name='', model='', network_role=''):
        from types import SimpleNamespace
        return network_role_of(SimpleNamespace(
            device_type=device_type, device_name=device_name, model=model,
            network_role=network_role,
        ))

    def test_explicit_role_wins_over_the_name(self):
        # 名字像接入，但台账标的是核心：以台账为准。
        self.assertEqual(self.role('switch', '接入-01', network_role='core_switch'), 'core_switch')
        self.assertEqual(
            self.role('switch', '接入-01', network_role='distribution_switch'),
            'distribution_switch')

    def test_explicit_role_does_not_need_a_name_hint(self):
        """Core-01 这种命名以前猜不出层级，现在按字段走。"""
        self.assertEqual(self.role('switch', 'Core-01', network_role='core_switch'), 'core_switch')
        self.assertEqual(self.role('switch', 'SW-CORE', network_role='core_switch'), 'core_switch')

    def test_blank_role_falls_back_to_the_name(self):
        self.assertEqual(self.role('switch', '演示-核心交换机'), 'core_switch')
        self.assertEqual(self.role('switch', '演示-园区汇聚交换机'), 'distribution_switch')
        self.assertEqual(self.role('switch', '演示-接入交换机'), 'access_switch')
        self.assertEqual(self.role('firewall', ''), 'firewall')

    def test_blank_role_and_no_hint_still_lands_somewhere_usable(self):
        self.assertEqual(self.role('switch', 'SW-1'), 'access_switch')
        self.assertEqual(self.role('', 'X'), 'network_other')
