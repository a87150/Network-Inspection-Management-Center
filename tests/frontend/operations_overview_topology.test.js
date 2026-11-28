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
    { kind: 'mac', label: 'MAC 表定位终端' },
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

test('折行后的行不从中间起，避免和上一行垂直对齐成假连线', async () => {
  const { layoutTopology } = await loadModule();
  const nodes = Array.from({ length: 7 }, (_, index) => ({
    id: `networks:access-${index}`, kind: 'backbone', role: 'access_switch',
    tier: 3, label: `ACCESS-${index}`, childCount: 0,
  }));

  const layout = layoutTopology(
    { nodes, attachmentEdges: [], physicalEdges: [] },
    { width: 420, height: 900 },
  );
  const rows = [...Map.groupBy(layout.nodes, (node) => node.y).values()];
  assert.ok(rows.length >= 2, '窄画布下应折行');

  // 两行的 x 集合不能有交集：重叠就意味着上一行某台的正下方站着下一行的某台，
  // 中间那条竖线（层级边）会被读成一条串联连线。
  const first = new Set(rows[0].map((node) => Math.round(node.x)));
  const second = rows[1].map((node) => Math.round(node.x));
  for (const x of second) {
    assert.equal(first.has(x), false, '第二行不应有节点正好落在第一行节点正下方：x=' + x);
  }
});

test('同一台交换机下的接入按端口序左右排，不是按设备名', async () => {
  const { layoutTopology } = await loadModule();
  const nodes = [
    { id: 'networks:core', kind: 'backbone', role: 'core_switch', tier: 1, label: 'CORE', childCount: 0 },
    { id: 'networks:a', kind: 'backbone', role: 'access_switch', tier: 3, label: '接入-甲', parentId: 'networks:core', childCount: 0 },
    { id: 'networks:b', kind: 'backbone', role: 'access_switch', tier: 3, label: '接入-乙', parentId: 'networks:core', childCount: 0 },
    { id: 'networks:c', kind: 'backbone', role: 'access_switch', tier: 3, label: '接入-丙', parentId: 'networks:core', childCount: 0 },
  ];
  // 设备名顺序是甲 < 乙 < 丙，端口顺序却是 c(1 号口) < b(2 号口) < a(10 号口)。
  // 按名字排会把 10 号口摆到最左边，三条线横着交叉。
  const physicalEdges = [
    { id: 'p1', source: 'networks:core', target: 'networks:a', localInterfaceLabel: 'XGE4/0/10', remoteInterfaceLabel: 'GE1/0/1' },
    { id: 'p2', source: 'networks:core', target: 'networks:b', localInterfaceLabel: 'XGE4/0/2', remoteInterfaceLabel: 'GE1/0/1' },
    { id: 'p3', source: 'networks:core', target: 'networks:c', localInterfaceLabel: 'XGE4/0/1', remoteInterfaceLabel: 'GE1/0/1' },
  ];

  const layout = layoutTopology(
    { nodes, attachmentEdges: [], physicalEdges, hierarchyEdges: [] },
    { width: 1200, height: 900 },
  );
  const x = (id) => layout.nodes.find((node) => node.id === id).x;

  assert.ok(x('networks:c') < x('networks:b'), '1 号口应该在 2 号口左边');
  assert.ok(x('networks:b') < x('networks:a'), '2 号口应该在 10 号口左边');
});

test('设备多的一行留出更宽的行距，给车道腾地方', async () => {
  const { layoutTopology } = await loadModule();
  const crowded = Array.from({ length: 12 }, (_, index) => ({
    id: `networks:a-${index}`, kind: 'backbone', role: 'access_switch',
    tier: 3, label: `A-${index}`, childCount: 0,
  }));
  const layout = layoutTopology(
    { nodes: crowded, attachmentEdges: [], physicalEdges: [] },
    { width: 420, height: 1200 },
  );
  const ys = [...new Set(layout.nodes.map((node) => node.y))].sort((a, b) => a - b);
  assert.ok(ys.length >= 2, '应该折成多行');
  const gap = ys[1] - ys[0];
  // 固定 118 时车道只有 28px，24 条线挤在 3px 一档。现在这一行有若干台，行距要更大。
  assert.ok(gap > 118, '行距应比原来的 118 宽，实际 ' + gap);
});

test('折出来的每一行都比上一行更靠右，同列设备的 x 不再重合', async () => {
  const { layoutTopology } = await loadModule();
  // 每行只放得下一台：不做递增错位时，三台设备的 x 全部相同，
  // 各自到核心的上联会叠成一条竖线。
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    id: `networks:n-${index}`, kind: 'backbone', role: 'access_switch',
    tier: 3, label: `N-${index}`, childCount: 0,
  }));
  const layout = layoutTopology(
    { nodes, attachmentEdges: [], physicalEdges: [] },
    { width: 300, height: 1400 },
  );
  // 每行的起始 x 按行序不递减；隔行错位（0, 56, 0）会让第 3 行退回第 1 行的位置，
  // 那种写法在这里必然失败。
  const byRow = new Map();
  for (const node of layout.nodes) {
    const y = Math.round(node.y);
    const previous = byRow.has(y) ? byRow.get(y) : Infinity;
    byRow.set(y, Math.min(previous, node.x));
  }
  const xs = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => Math.round(x));
  assert.ok(xs.length >= 2, '至少要折出两行，实际 ' + xs.length + ' 行');
  for (let index = 1; index < xs.length; index += 1) {
    assert.ok(
      xs[index] >= xs[index - 1],
      '第 ' + index + ' 行起点不应比上一行更左：' + xs[index - 1] + ' -> ' + xs[index],
    );
  }
});
