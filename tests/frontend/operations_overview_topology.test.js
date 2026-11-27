const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

async function loadModule() {
  const source = readFileSync(
    resolve(__dirname, '../../static/app/js/operations-overview/topology.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function enterpriseSnapshot() {
  return {
    nodes: [
      { id: 'networks:access', kind: 'backbone', role: 'access_switch', tier: 3, label: 'ACCESS', child_count: 1 },
      { id: 'networks:firewall', kind: 'backbone', role: 'firewall', tier: 0, label: 'FIREWALL', child_count: 0 },
      { id: 'networks:ac', kind: 'backbone', role: 'wireless_controller', tier: 3, label: 'WLAN-AC', child_count: 1 },
      { id: 'networks:core', kind: 'backbone', role: 'core_switch', tier: 1, label: 'CORE', child_count: 0 },
      { id: 'computers:pc-1', kind: 'endpoint', role: 'computer', label: 'PC-01', parent_id: 'networks:access', attachment_source: 'inferred_subnet' },
      { id: 'networks:ap-1', kind: 'endpoint', role: 'access_point', label: 'AP-01', parent_id: 'networks:ac', attachment_source: 'physical_discovered' },
    ],
    attachment_edges: [
      { id: 'attach-pc', kind: 'endpoint_attachment', source: 'networks:access', target: 'computers:pc-1', attachment_source: 'inferred_subnet' },
      { id: 'attach-ap', kind: 'endpoint_attachment', source: 'networks:ac', target: 'networks:ap-1', attachment_source: 'physical_discovered' },
    ],
    interfaces: [
      { id: 'if-firewall', device_id: 'firewall', name: 'Eth1', speed_bps: 10000000000, vlan_ids: [10] },
      { id: 'if-core', device_id: 'core', name: 'XGE1', speed_bps: 10000000000, vlan_ids: [10] },
    ],
    physical_edges: [
      {
        id: 'forward', kind: 'physical_discovered', local_interface_id: 'if-firewall', local_device_id: 'firewall',
        remote_device_id: 'core', remote_interface_id: 'if-core', protocols: ['snmp_lldp'],
        evidence_direction: 'unilateral', resolution_status: 'resolved', status: 'stale',
        confidence: '0.80', last_seen_at: '2026-09-20T09:00:00Z',
      },
      {
        id: 'reverse', kind: 'physical_discovered', local_interface_id: 'if-core', local_device_id: 'core',
        remote_device_id: 'firewall', remote_interface_id: 'if-firewall', protocols: ['ssh_cdp'],
        evidence_direction: 'unilateral', resolution_status: 'resolved', status: 'current',
        confidence: '0.90', last_seen_at: '2026-09-20T09:01:00Z',
      },
    ],
  };
}

test('shows only backbone by default and expands one device deterministically', async () => {
  const { normalizeTopology, visibleTopology } = await loadModule();
  const graph = normalizeTopology(enterpriseSnapshot());

  assert.deepEqual(visibleTopology(graph, new Set()).nodes.map((node) => node.id), [
    'networks:firewall', 'networks:core', 'networks:access', 'networks:ac',
  ]);
  const accessExpanded = visibleTopology(graph, new Set(['networks:access']));
  assert.ok(accessExpanded.nodes.some((node) => node.id === 'computers:pc-1'));
  assert.ok(!accessExpanded.nodes.some((node) => node.id === 'networks:ap-1'));
  assert.equal(accessExpanded.attachmentEdges.length, 1);
  assert.equal(accessExpanded.attachmentEdges[0].attachmentSource, 'inferred_subnet');
});

test('locating a collapsed endpoint returns the parent that must be expanded', async () => {
  const { normalizeTopology, parentToExpand } = await loadModule();
  const graph = normalizeTopology(enterpriseSnapshot());
  const pc = graph.nodes.find((node) => node.id === 'computers:pc-1');

  // 默认收起时，这台 PC 不在可见图里——按 IP 定位必须先展开它的父节点，
  // 否则拿到的坐标属于旧布局，视口会平移到空白处。
  assert.equal(parentToExpand(pc, new Set()), 'networks:access');

  // 已经展开过就不需要再动展开状态，避免重复触发重排。
  assert.equal(parentToExpand(pc, new Set(['networks:access'])), '');

  // 主干节点本身一直可见，不该被当作"需要展开的目标"。
  const backbone = graph.nodes.find((node) => node.id === 'networks:core');
  assert.equal(parentToExpand(backbone, new Set()), '');
  assert.equal(parentToExpand(null, new Set()), '');
});

test('expanding the parent actually puts the located endpoint on the canvas', async () => {
  const { normalizeTopology, visibleTopology, parentToExpand } = await loadModule();
  const graph = normalizeTopology(enterpriseSnapshot());
  const pc = graph.nodes.find((node) => node.id === 'computers:pc-1');

  const before = new Set();
  assert.ok(!visibleTopology(graph, before).nodes.some((node) => node.id === pc.id));

  const expandId = parentToExpand(pc, before);
  const after = new Set([...before, expandId]);
  assert.ok(visibleTopology(graph, after).nodes.some((node) => node.id === pc.id));
});

test('reconciles expansions after refresh removes a backbone node', async () => {
  const { reconcileExpandedIds } = await loadModule();
  const graph = { nodes: [{ id: 'networks:core', kind: 'backbone' }] };

  assert.deepEqual(
    [...reconcileExpandedIds(new Set(['networks:gone', 'networks:core']), graph)],
    ['networks:core'],
  );
});

test('normalization keeps attachment and physical evidence distinct', async () => {
  const { normalizeTopology } = await loadModule();
  const graph = normalizeTopology(enterpriseSnapshot());

  assert.equal(graph.attachmentEdges.length, 2);
  assert.equal(graph.physicalEdges.length, 1);
  assert.deepEqual(graph.physicalEdges[0].protocols, ['snmp_lldp', 'ssh_cdp']);
  assert.equal(graph.physicalEdges[0].status, 'current');
  assert.equal(graph.physicalEdges[0].evidenceDirection, 'bidirectional');
  assert.equal(graph.nodes.find((node) => node.id === 'computers:pc-1').parentId, 'networks:access');
});

test('lays backbone tiers top-down and expanded children below their parent', async () => {
  const { layoutTopology, normalizeTopology, visibleTopology } = await loadModule();
  const graph = visibleTopology(
    normalizeTopology(enterpriseSnapshot()),
    new Set(['networks:access', 'networks:ac']),
  );
  const first = layoutTopology(graph, { width: 360, height: 620 });
  const second = layoutTopology(graph, { width: 360, height: 620 });
  const byId = new Map(first.nodes.map((node) => [node.id, node]));

  assert.deepEqual(first, second);
  assert.ok(byId.get('networks:firewall').y < byId.get('networks:core').y);
  assert.ok(byId.get('networks:core').y < byId.get('networks:access').y);
  assert.ok(byId.get('computers:pc-1').y > byId.get('networks:access').y);
  assert.ok(byId.get('networks:ap-1').y > byId.get('networks:ac').y);
  assert.deepEqual(first.legend, [
    { kind: 'physical', label: 'LLDP/CDP 物理链路' },
    { kind: 'vpn', label: '场地间 VPN' },
    { kind: 'inferred', label: '网段推断终端' },
    { kind: 'external', label: '未解析邻居' },
  ]);
  for (const node of first.nodes) {
    assert.ok(node.x >= first.bounds.minX && node.x <= first.bounds.maxX, node.id);
    assert.ok(node.y >= first.bounds.minY && node.y <= first.bounds.maxY, node.id);
  }
  assert.ok(first.bounds.maxX <= 360);
});

test('每次场地各占一列，单场地时只占一列', async () => {
  const { layoutTopology } = await loadModule();
  const single = layoutTopology(
    {
      nodes: [
        { id: 'networks:fw', kind: 'backbone', role: 'firewall', tier: 0, label: 'FW', siteId: 0, site: 'A' },
        { id: 'networks:core', kind: 'backbone', role: 'core_switch', tier: 1, label: 'CORE', siteId: 0, site: 'A' },
      ],
      attachmentEdges: [], physicalEdges: [], hierarchyEdges: [],
    },
    { width: 900, height: 620 },
  );
  assert.equal(single.sites.length, 1);

  const multi = layoutTopology(
    {
      nodes: [
        { id: 'networks:fw-a', kind: 'backbone', role: 'firewall', tier: 0, label: 'A-FW', siteId: 0, site: 'A' },
        { id: 'networks:fw-b', kind: 'backbone', role: 'firewall', tier: 0, label: 'B-FW', siteId: 1, site: 'B' },
      ],
      attachmentEdges: [], physicalEdges: [], hierarchyEdges: [],
    },
    { width: 900, height: 620 },
  );
  assert.equal(multi.sites.length, 2);
  const [left, right] = multi.sites;
  assert.ok(left.right < right.left, '两列不能重叠');
  const byId = new Map(multi.nodes.map((node) => [node.id, node]));
  assert.ok(byId.get('networks:fw-a').x < byId.get('networks:fw-b').x);
});

test('wraps dense backbone tiers on narrow screens without overlapping cards', async () => {
  const { layoutTopology } = await loadModule();
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    id: `networks:access-${index}`, kind: 'backbone', role: 'access_switch',
    tier: 3, label: `ACCESS-${index}`, childCount: 0,
  }));

  const layout = layoutTopology(
    { nodes, attachmentEdges: [], physicalEdges: [] },
    { width: 360, height: 760 },
  );
  const rows = Map.groupBy(layout.nodes, (node) => node.y);

  assert.ok(rows.size >= 3);
  for (const row of rows.values()) {
    const positions = row.map((node) => node.x).sort((left, right) => left - right);
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index] - positions[index - 1] >= 120);
    }
  }
});
