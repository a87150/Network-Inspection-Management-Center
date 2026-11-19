from datetime import timedelta
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from net.models import InspectionProfile, Network_Device, NetworkTopologyLink, NetworkTopologyObservation, TaskRun, TaskTargetRun
from net.topology.discovery import build_discovery_payload
from net.topology.service import begin_topology_batch, complete_topology_batch


class TopologyServiceTests(TestCase):
    def setUp(self):
        self.device = Network_Device.objects.create(device_name='access', ip='192.0.2.1', vendor='cisco')
        self.remote = Network_Device.objects.create(device_name='core', ip='192.0.2.2', vendor='cisco')
        self.profile = InspectionProfile.objects.create(name='topology',device_type='network_device',selected_items=['lldp_neighbors'])

    def target(self):
        task=TaskRun.objects.create(task_type='inspection',inspection_profile=self.profile,source='manual',status='success',finished_at=timezone.now(),progress=100,selected_items_snapshot=['lldp_neighbors'],target_scope_snapshot={},total_targets=1,completed_targets=1,successful_targets=1)
        return TaskTargetRun.objects.create(task=task,target_type='network_device',target_id=str(self.device.pk),target_snapshot={'ip':self.device.ip})

    def payload(self, when=None, neighbors=True, complete=True):
        when=when or timezone.now()
        return build_discovery_payload(self.device,[{'status':'success' if complete else 'partial','complete':complete,'protocols':['snmp_lldp'],
            'interfaces':[{'if_index':1,'name':'Gi1/0/1'}],
            'neighbors':([{'local_key_hint':'ifindex:1','remote_system_name':'core','remote_port_id':'Gi1/0/2','protocol':'lldp'}] if neighbors else []),'evidence':{'safe':'value'}}],
            [self.remote],[],when)

    def test_completion_is_idempotent_and_evidence_is_bounded(self):
        target=self.target(); batch_id=begin_topology_batch(target.pk,timezone.now())
        payload=self.payload()
        first=complete_topology_batch(batch_id,payload,collection_status='success',collected_at=payload.collected_at)
        second=complete_topology_batch(batch_id,payload,collection_status='success',collected_at=payload.collected_at)
        self.assertEqual(first.pk,second.pk)
        self.assertEqual(NetworkTopologyObservation.objects.count(),1)
        self.assertEqual(NetworkTopologyLink.objects.count(),1)
        self.assertLessEqual(len(NetworkTopologyObservation.objects.get().evidence.encode()),65536)

    def test_two_complete_misses_mark_stale_but_partial_does_not_age(self):
        first_target=self.target(); first=self.payload(); complete_topology_batch(begin_topology_batch(first_target.pk,timezone.now()),first,collection_status='success',collected_at=first.collected_at)
        link=NetworkTopologyLink.objects.get(); self.assertEqual(link.status,'current')
        partial_target=self.target(); partial=self.payload(neighbors=False,complete=False)
        complete_topology_batch(begin_topology_batch(partial_target.pk,timezone.now()),partial,collection_status='partial',collected_at=partial.collected_at)
        link.refresh_from_db(); self.assertEqual(link.missing_complete_batches,0)
        for _ in range(2):
            target=self.target(); empty=self.payload(neighbors=False)
            complete_topology_batch(begin_topology_batch(target.pk,timezone.now()),empty,collection_status='success',collected_at=empty.collected_at)
        link.refresh_from_db(); self.assertEqual(link.status,'stale'); self.assertEqual(link.missing_complete_batches,2)

    def test_interface_rediscovery_preserves_first_seen(self):
        target=self.target(); payload=self.payload(); first=payload.collected_at
        complete_topology_batch(begin_topology_batch(target.pk,first),payload,collection_status='success',collected_at=first)
        target=self.target(); later=first+timedelta(hours=1); payload=self.payload(when=later)
        complete_topology_batch(begin_topology_batch(target.pk,later),payload,collection_status='success',collected_at=later)
        interface=self.device.topology_interfaces.get()
        self.assertEqual(interface.first_seen_at,first)
        self.assertEqual(interface.last_seen_at,later)

    def test_rediscovery_recovers_stale_link(self):
        target=self.target(); payload=self.payload(); complete_topology_batch(begin_topology_batch(target.pk,timezone.now()),payload,collection_status='success',collected_at=payload.collected_at)
        link=NetworkTopologyLink.objects.get(); link.status='stale'; link.missing_complete_batches=2; link.save()
        target=self.target(); payload=self.payload(); complete_topology_batch(begin_topology_batch(target.pk,timezone.now()),payload,collection_status='success',collected_at=payload.collected_at)
        link.refresh_from_db(); self.assertEqual(link.status,'current'); self.assertEqual(link.missing_complete_batches,0)

    def test_write_query_count_does_not_grow_with_interface_count(self):
        """几百台设备时逐条 update_or_create 会把行锁持有时间拉长，批次就超时。

        这里锁死"每次提交的查询数有上限"：接口和链路都批量写，
        所以 1 个接口和 40 个接口的查询数必须一样。
        """
        def payload_with(count):
            interfaces = [{'if_index': index, 'name': f'Gi1/0/{index}'} for index in range(1, count + 1)]
            neighbors = [{
                'local_key_hint': f'ifindex:{index}', 'remote_system_name': 'core',
                'remote_port_id': f'Gi1/0/{index}', 'protocol': 'lldp',
            } for index in range(1, count + 1)]
            return build_discovery_payload(
                self.device,
                [{'status': 'success', 'complete': True, 'interfaces': interfaces, 'neighbors': neighbors}],
                [self.remote], [], timezone.now(),
            )

        def count_queries(amount):
            target = self.target()
            payload = payload_with(amount)
            with CaptureQueriesContext(connection) as captured:
                complete_topology_batch(
                    begin_topology_batch(target.pk, timezone.now()), payload,
                    collection_status='success', collected_at=payload.collected_at,
                )
            return len(captured)

        # 批量写之后查询数是常数级；旧实现是每个接口 2 次以上，40 个接口会到 100+。
        self.assertLessEqual(count_queries(40), count_queries(1) + 6)


