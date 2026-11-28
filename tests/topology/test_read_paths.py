"""拓扑读取路径回归：参数兜底、证据截断、每设备最新、索引与查询形态。"""
import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from net.devices.network import observations
from net.models import (
    InspectionProfile,
    Monitor_Inspection,
    Network_Device,
    Network_Device_Inspection,
    NetworkTopologyInterface,
    NetworkTopologyLink,
    NetworkTopologyObservation,
    Server_Inspection,
    TaskRun,
    TaskTargetRun,
    TopologyDiscoveryBatch,
)


class TopologyReadFixture(TestCase):
    """设备 + 巡检任务 + 一个批次，视图测试共用。"""

    def setUp(self):
        self.user = get_user_model().objects.create_user(username="read-path", password="pw")
        self.device = Network_Device.objects.create(device_name="core", ip="192.0.2.50", vendor="cisco")
        profile = InspectionProfile.objects.create(
            name="read-path", device_type="network_device", selected_items=["lldp_neighbors"])
        self.task = TaskRun.objects.create(
            task_type="inspection", inspection_profile=profile, source="manual",
            selected_items_snapshot=["lldp_neighbors"], target_scope_snapshot={}, total_targets=1)
        self.target = TaskTargetRun.objects.create(
            task=self.task, target_type="network_device", target_id=str(self.device.pk), target_snapshot={})
        now = timezone.now()
        self.batch = TopologyDiscoveryBatch.objects.create(
            source_task=self.task, source_target=self.target, device=self.device,
            protocol="snmp_lldp", status="success", started_at=now, collected_at=now, finished_at=now)
        self.interface = NetworkTopologyInterface.objects.create(
            device=self.device, stable_key="ifindex:1", name="Gi1",
            first_seen_at=now, last_seen_at=now, last_batch=self.batch)


class TopologyLimitFallbackTests(TopologyReadFixture):
    def test_bad_limit_returns_200(self):
        """?limit=abc 以前直接 ValueError -> 500；现在回落默认值。"""
        self.client.force_login(self.user)
        response = self.client.get(reverse("topology_data"), {"limit": "abc"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["links_truncated"], False)
        self.assertEqual([row["stable_key"] for row in body["interfaces"]], ["ifindex:1"])

    def test_out_of_range_limit_is_clamped(self):
        self.client.force_login(self.user)
        for raw in ("0", "-7", "999999", "", "1.5"):
            with self.subTest(limit=raw):
                self.assertEqual(
                    self.client.get(reverse("topology_data"), {"limit": raw}).status_code, 200)


class EvidenceTruncationTests(TopologyReadFixture):
    def test_overlong_evidence_is_parseable_and_marked(self):
        """超长证据以前是 JSON 字符串硬切 65536，前端 parse 必炸。"""
        oversized = json.dumps({"blob": "x" * 200000})
        observation = NetworkTopologyObservation.objects.create(
            batch=self.batch, source_target=self.target, local_device=self.device,
            local_interface=self.interface, protocol="snmp_lldp", neighbor={"remote_system_name": "edge"},
            evidence=oversized, evidence_sha256="b" * 64, collected_at=timezone.now())
        self.user.user_permissions.add(Permission.objects.get(codename="view_topology_evidence"))
        self.client.force_login(self.user)
        response = self.client.get(reverse("topology_evidence", args=[observation.pk]))
        self.assertEqual(response.status_code, 200)
        evidence = response.json()["evidence"]
        self.assertLessEqual(len(evidence.encode()), 65536)
        parsed = json.loads(evidence)
        self.assertTrue(parsed["truncated"])
        self.assertEqual(parsed["bytes"], len(oversized))
        self.assertIn("blob", parsed["preview"])
        self.assertEqual(len(parsed["preview"]), 4096)

    def test_short_evidence_keeps_the_original_text(self):
        observation = NetworkTopologyObservation.objects.create(
            batch=self.batch, source_target=self.target, local_device=self.device,
            local_interface=self.interface, protocol="snmp_lldp", neighbor={"remote_system_name": "edge"},
            evidence='{"community":"removed","safe":"value"}', evidence_sha256="b" * 64,
            collected_at=timezone.now())
        self.user.user_permissions.add(Permission.objects.get(codename="view_topology_evidence"))
        self.client.force_login(self.user)
        response = self.client.get(reverse("topology_evidence", args=[observation.pk]))
        parsed = json.loads(response.json()["evidence"])
        self.assertEqual(parsed["safe"], "value")
        self.assertNotIn("truncated", parsed)


class LatestInspectionTests(TopologyReadFixture):
    # 旧实现的全局行上限。超过它以后，按 created_at 排在后面的设备一条都留不下。
    LEGACY_MAX_RECORDS = 5000

    def test_every_device_keeps_its_newest_record(self):
        devices = [self.device] + [
            Network_Device.objects.create(
                device_name="sw%d" % index, ip="192.0.2.%d" % (100 + index), vendor="cisco")
            for index in (1, 2)]
        bulk = [Network_Device_Inspection(device_id=devices[0].pk, status="success", details={})
                for _ in range(2500)]
        bulk += [Network_Device_Inspection(device_id=devices[1].pk, status="success", details={})
                 for _ in range(2500)]
        bulk.append(Network_Device_Inspection(device_id=devices[2].pk, status="success", details={}))
        Network_Device_Inspection.objects.bulk_create(bulk)
        self.assertGreater(len(bulk), self.LEGACY_MAX_RECORDS)

        now = timezone.now()
        # 前两台设备各留一条最新的，其余压到 5 分钟前；第三台只有一条，且排在最后。
        for device in devices[:2]:
            Network_Device_Inspection.objects.filter(device_id=device.pk).update(
                created_at=now - timedelta(minutes=5))
            newest = Network_Device_Inspection.objects.filter(device_id=device.pk).first()
            Network_Device_Inspection.objects.filter(pk=newest.pk).update(
                created_at=now - timedelta(minutes=1))
        Network_Device_Inspection.objects.filter(device_id=devices[2].pk).update(
            created_at=now - timedelta(days=6))

        latest = observations.latest_inspections()
        self.assertEqual(set(latest), {device.pk for device in devices})
        for device in devices:
            self.assertEqual(latest[device.pk].device_id, device.pk)
        self.assertGreater(latest[devices[2].pk].created_at, now - timedelta(days=7))

    def test_latest_inspections_ignores_failed_rows(self):
        Network_Device_Inspection.objects.create(device_id=self.device.pk, status="failed", details={})
        oldest = Network_Device_Inspection.objects.create(
            device_id=self.device.pk, status="success", details={"kept": True})
        later_failed = Network_Device_Inspection.objects.create(
            device_id=self.device.pk, status="failed", details={})
        Network_Device_Inspection.objects.filter(pk=oldest.pk).update(
            created_at=timezone.now() - timedelta(hours=2))
        Network_Device_Inspection.objects.filter(pk=later_failed.pk).update(
            created_at=timezone.now())
        latest = observations.latest_inspections()
        self.assertEqual(latest[self.device.pk].pk, oldest.pk)


class InspectionIndexTests(TestCase):
    TABLES = (
        (Network_Device_Inspection, "device", "net_netdevinsp_dev_time_idx",
         "net_netdevinsp_stat_time_idx"),
        (Server_Inspection, "server", "net_serverinsp_dev_time_idx",
         "net_serverinsp_stat_time_idx"),
        (Monitor_Inspection, "monitor", "net_monitorinsp_dev_time_idx",
         "net_monitorinsp_stat_time_idx"),
    )

    def test_three_inspection_tables_cover_device_and_status(self):
        for model, field, device_index, status_index in self.TABLES:
            with self.subTest(model=model.__name__):
                declared = {index.name: index.fields for index in model._meta.indexes}
                self.assertEqual(declared[device_index], [field, "-created_at"])
                self.assertEqual(declared[status_index], ["status", "-created_at"])
                with connection.cursor() as cursor:
                    built = connection.introspection.get_constraints(cursor, model._meta.db_table)
                self.assertIn(device_index, built)
                self.assertIn(status_index, built)


class TopologyQueryShapeTests(TopologyReadFixture):
    def setUp(self):
        super().setUp()
        now = timezone.now()
        link = NetworkTopologyLink.objects.create(
            stable_link_key="a" * 64, local_interface=self.interface, remote_system_name="edge",
            protocols=["snmp_lldp"], confidence="0.60", first_seen_at=now, last_seen_at=now,
            last_batch=self.batch)
        self.link = link

    def test_interface_list_skips_device_join(self):
        """interface_payload 只读 device_id 列值，select_related("device") 是多余 JOIN。"""
        self.client.force_login(self.user)
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(reverse("topology_interfaces"))
        self.assertEqual(response.status_code, 200)
        sql = " ".join(entry["sql"] for entry in captured.captured_queries)
        self.assertNotIn("net_network_device", sql)

    def test_link_list_count_is_not_a_distinct_derived_table(self):
        """device_id 过滤以前 | 拼接后 distinct()，Paginator 计数变成 COUNT(*) FROM (SELECT DISTINCT ...)。"""
        self.client.force_login(self.user)
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(reverse("topology_links"), {"device_id": str(self.device.pk)})
        self.assertEqual(response.status_code, 200)
        counts = [entry["sql"] for entry in captured.captured_queries if "COUNT(" in entry["sql"]]
        self.assertEqual(len(counts), 1)
        self.assertNotIn("DISTINCT", counts[0].upper())
        self.assertNotIn("FROM (SELECT", counts[0].upper())

    def test_link_list_still_returns_one_row_when_both_sides_match(self):
        """local 和 remote 命中同一台设备时，去掉 distinct() 也不能出重复行。"""
        self.link.remote_device = self.device
        self.link.save(update_fields=["remote_device"])
        self.client.force_login(self.user)
        response = self.client.get(reverse("topology_links"), {"device_id": str(self.device.pk)})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["pagination"]["count"], 1)
        self.assertEqual(len(body["results"]), 1)

