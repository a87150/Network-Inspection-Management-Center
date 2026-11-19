"""Short, idempotent database writes for inspection-driven topology."""
from __future__ import annotations

import hashlib
import json

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from net.infrastructure.sanitization import sanitize
from net.models import (
    NetworkTopologyInterface, NetworkTopologyLink,
    NetworkTopologyObservation, TaskTargetRun, TopologyDiscoveryBatch,
)
from net.topology.discovery import stable_interface_key

MAX_EVIDENCE_BYTES = 64 * 1024


def _protocol(values):
    values = set(values or [])
    if len(values) > 1:
        return TopologyDiscoveryBatch.Protocol.MIXED
    return next(iter(values), TopologyDiscoveryBatch.Protocol.SNMP_LLDP)


def begin_topology_batch(target_id, started_at):
    with transaction.atomic():
        target = TaskTargetRun.objects.select_related('task').select_for_update().filter(pk=target_id).first()
        if target is None or target.target_type != TaskTargetRun.TargetType.NETWORK_DEVICE:
            return None
        existing = TopologyDiscoveryBatch.objects.filter(source_target=target).first()
        if existing:
            return existing.pk
        return TopologyDiscoveryBatch.objects.create(
            source_task=target.task, source_target=target, device_id=target.target_id,
            protocol=TopologyDiscoveryBatch.Protocol.MIXED,
            status=TopologyDiscoveryBatch.Status.RUNNING, started_at=started_at,
        ).pk


def _evidence_text(evidence, neighbor):
    value = sanitize({'evidence': evidence, 'neighbor': neighbor})
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')
    if len(encoded) <= MAX_EVIDENCE_BYTES:
        return encoded.decode('utf-8')
    digest = hashlib.sha256(encoded).hexdigest()
    return json.dumps({'truncated': True, 'sha256': digest, 'bytes': len(encoded)}, ensure_ascii=False)


def complete_topology_batch(batch_id, payload, *, collection_status, collected_at):
    with transaction.atomic():
        batch = TopologyDiscoveryBatch.objects.select_for_update().select_related('source_target').get(pk=batch_id)
        if batch.status != TopologyDiscoveryBatch.Status.RUNNING:
            return batch
        now = timezone.now()
        interface_rows = {}
        interface_defaults = {}
        for candidate in payload.interfaces:
            key = stable_interface_key(candidate)
            defaults = {
                'if_index': candidate.if_index, 'name': candidate.name[:255],
                'description': candidate.description[:1000], 'mac_address': candidate.mac_address[:64],
                'admin_status': candidate.admin_status if candidate.admin_status in dict(NetworkTopologyInterface.STATUS_CHOICES) else 'unknown',
                'oper_status': candidate.oper_status if candidate.oper_status in dict(NetworkTopologyInterface.STATUS_CHOICES) else 'unknown',
                'speed_bps': candidate.speed_bps, 'vlan_ids': list(candidate.vlan_ids),
                'last_seen_at': collected_at, 'last_batch': batch, 'is_stale': False,
            }
            interface_defaults[key] = defaults
            interface_rows[key] = None
            if candidate.stable_key_hint:
                interface_rows[candidate.stable_key_hint] = None
            if candidate.name:
                interface_rows['name:' + ''.join(candidate.name.casefold().split())] = None
        # 每台设备几百个接口，逐条 update_or_create 会把行锁持有时间拉成线性的。
        # 改成"一次查、一次建、一次改、一次回查"，查询数固定为 5 次。
        existing_interfaces = {
            row.stable_key: row for row in NetworkTopologyInterface.objects.filter(
                device=batch.device, stable_key__in=list(interface_defaults),
            )
        }
        to_create = []
        to_update = []
        for key, defaults in interface_defaults.items():
            row = existing_interfaces.get(key)
            if row is None:
                to_create.append(NetworkTopologyInterface(
                    device=batch.device, stable_key=key,
                    first_seen_at=collected_at, **defaults,
                ))
            else:
                for field, value in defaults.items():
                    setattr(row, field, value)
                to_update.append(row)
        if to_create:
            NetworkTopologyInterface.objects.bulk_create(to_create, batch_size=500)
        if to_update:
            NetworkTopologyInterface.objects.bulk_update(
                to_update, list(next(iter(interface_defaults.values())).keys()), batch_size=500,
            )
        # bulk_create 在 MariaDB 上不回填主键，需要再查一次拿到全部行。
        for row in NetworkTopologyInterface.objects.filter(
            device=batch.device, stable_key__in=list(interface_defaults),
        ):
            interface_rows[row.stable_key] = row
        for candidate in payload.interfaces:
            row = interface_rows.get(stable_interface_key(candidate))
            if candidate.stable_key_hint:
                interface_rows[candidate.stable_key_hint] = row
            if candidate.name:
                interface_rows['name:' + ''.join(candidate.name.casefold().split())] = row
        observed_keys = set()
        resolved = unresolved = conflicts = 0
        remote_keys = {
            (observation.remote_device_id, observation.remote_interface_key)
            for observation in payload.observations
            if observation.remote_device_id and observation.remote_interface_key
        }
        remote_interfaces = {
            (row.device_id, row.stable_key): row
            for row in NetworkTopologyInterface.objects.filter(
                device_id__in={device_id for device_id, _ in remote_keys},
                stable_key__in={key for _, key in remote_keys},
            )
        } if remote_keys else {}
        existing_links = {
            row.stable_link_key: row for row in NetworkTopologyLink.objects.filter(
                stable_link_key__in=[o.stable_link_key for o in payload.observations],
            )
        }
        links_to_create = []
        links_to_update = []
        link_sequence = []
        for observation in payload.observations:
            local = interface_rows.get(observation.local_interface_key)
            if local is None:
                continue
            remote_interface = remote_interfaces.get(
                (observation.remote_device_id, observation.remote_interface_key),
            ) if observation.remote_device_id and observation.remote_interface_key else None
            protocol = 'ssh_cdp' if observation.protocol == 'cdp' else (
                'snmp_lldp' if 'snmp_lldp' in payload.protocols else 'ssh_lldp'
            )
            defaults = {
                'local_interface': local, 'remote_device_id': observation.remote_device_id,
                'remote_interface': remote_interface,
                'remote_chassis_id': observation.remote_chassis_id[:255],
                'remote_port_id': observation.remote_port_id[:255],
                'remote_port_description': observation.remote_port_description[:1000],
                'remote_system_name': observation.remote_system_name[:255],
                'remote_management_addresses': list(observation.remote_management_addresses),
                'protocols': list(payload.protocols), 'resolution_status': observation.resolution_status,
                'status': 'current', 'confidence': observation.confidence,
                'last_seen_at': collected_at, 'last_batch': batch, 'missing_complete_batches': 0,
            }
            link = existing_links.get(observation.stable_link_key)
            if link:
                if link.local_interface.device_id != batch.device_id:
                    defaults['evidence_direction'] = 'bidirectional'
                    # Keep the canonical orientation created by the first side.
                    defaults['local_interface'] = link.local_interface
                    defaults['remote_device_id'] = link.remote_device_id
                    defaults['remote_interface'] = link.remote_interface
                    defaults['remote_chassis_id'] = link.remote_chassis_id
                    defaults['remote_port_id'] = link.remote_port_id
                    defaults['remote_port_description'] = link.remote_port_description
                    defaults['remote_system_name'] = link.remote_system_name
                    defaults['remote_management_addresses'] = link.remote_management_addresses
                for field, value in defaults.items():
                    setattr(link, field, value)
                links_to_update.append(link)
                pending_link = ('update', link)
            else:
                link = NetworkTopologyLink(
                    stable_link_key=observation.stable_link_key,
                    first_seen_at=collected_at, evidence_direction='unilateral', **defaults,
                )
                links_to_create.append(link)
                pending_link = ('create', link)
            link_sequence.append((observation, local, protocol, pending_link))
            observed_keys.add(observation.stable_link_key)
            if observation.resolution_status == 'resolved': resolved += 1
            elif observation.resolution_status == 'conflict': conflicts += 1
            else: unresolved += 1
        if links_to_create:
            NetworkTopologyLink.objects.bulk_create(links_to_create, batch_size=500)
        if links_to_update:
            NetworkTopologyLink.objects.bulk_update(
                links_to_update, list(defaults.keys()), batch_size=500,
            )
        observation_rows = []
        for observation, local, protocol, pending_link in link_sequence:
            link = pending_link[1]
            neighbor = {
                'remote_chassis_id': observation.remote_chassis_id,
                'remote_port_id': observation.remote_port_id,
                'remote_port_description': observation.remote_port_description,
                'remote_system_name': observation.remote_system_name,
                'remote_management_addresses': list(observation.remote_management_addresses),
                'resolution_status': observation.resolution_status,
            }
            evidence = _evidence_text(observation.evidence, neighbor)
            digest = hashlib.sha256((protocol + '\n' + evidence).encode('utf-8')).hexdigest()
            observation_rows.append(NetworkTopologyObservation(
                batch=batch, evidence_sha256=digest,
                source_target=batch.source_target, local_device=batch.device,
                local_interface=local, link=link, protocol=protocol,
                neighbor=neighbor, evidence=evidence, collected_at=collected_at,
            ))
        if observation_rows:
            seen_digests = set(NetworkTopologyObservation.objects.filter(
                batch=batch,
                evidence_sha256__in=[row.evidence_sha256 for row in observation_rows],
            ).values_list('evidence_sha256', flat=True))
            fresh = []
            for row in observation_rows:
                if row.evidence_sha256 in seen_digests:
                    continue
                seen_digests.add(row.evidence_sha256)
                fresh.append(row)
            if fresh:
                NetworkTopologyObservation.objects.bulk_create(fresh, batch_size=500)
        authoritative = bool(payload.complete and collection_status == 'success')
        if authoritative:
            stale_candidates = NetworkTopologyLink.objects.select_for_update().filter(
                Q(local_interface__device=batch.device) | Q(remote_device=batch.device), status='current',
            ).exclude(stable_link_key__in=observed_keys)
            for link in stale_candidates:
                link.missing_complete_batches += 1
                if link.missing_complete_batches >= 2:
                    link.status = 'stale'
                link.save(update_fields=('missing_complete_batches', 'status'))
        final_status = 'success' if authoritative else 'partial' if collection_status in {'success', 'partial'} else 'failed'
        batch.protocol = _protocol(payload.protocols)
        batch.status = final_status
        batch.collected_at = collected_at
        batch.finished_at = now
        batch.message = (payload.message or '')[:1000]
        batch.interface_count = len(set(row.pk for row in interface_rows.values()))
        batch.observation_count = NetworkTopologyObservation.objects.filter(batch=batch).count()
        batch.resolved_count, batch.unresolved_count, batch.conflict_count = resolved, unresolved, conflicts
        batch.save()
        from net.infrastructure.page_cache import invalidate_page_cache_namespace
        transaction.on_commit(invalidate_page_cache_namespace)
        return batch


def fail_topology_batch(batch_id, *, status='failed', message='', finished_at=None):
    if not batch_id:
        return
    with transaction.atomic():
        batch = TopologyDiscoveryBatch.objects.select_for_update().filter(pk=batch_id).first()
        if batch is None or batch.status != TopologyDiscoveryBatch.Status.RUNNING:
            return
        batch.status = status if status in {'failed', 'cancelled'} else 'failed'
        batch.message = str(message)[:1000]
        batch.finished_at = finished_at or timezone.now()
        batch.save(update_fields=('status', 'message', 'finished_at'))


