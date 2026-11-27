'use strict';

/* app.js 是一个浏览器 ESM 岛：顶层读 document、import 浏览器版 Vue。
   这里把它的 Vue import 换成桩，其余源码逐字节搬进临时目录后用 data 方式导入，
   再用假 document/window 造一个组件实例直接调方法——测的是仓库里那份源码，
   不是复制品。 */

const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, after } = require('node:test');

const OVERVIEW_DIR = resolve(__dirname, '../../static/app/js/operations-overview');
const SIBLING_MODULES = ['state.js', 'topology.js', 'effects.js'];

const VUE_STUB = `export function createApp(options) {
  globalThis.__opsOverviewOptions = options;
  return { _instance: null, mount() { return undefined; } };
}
`;

let sandboxDir = '';
let launchCount = 0;

before(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), 'operations-overview-app-'));
  for (const name of SIBLING_MODULES) {
    copyFileSync(join(OVERVIEW_DIR, name), join(sandboxDir, name));
  }
  writeFileSync(join(sandboxDir, 'vue-stub.mjs'), VUE_STUB, 'utf8');
  const source = readFileSync(join(OVERVIEW_DIR, 'app.js'), 'utf8');
  const patched = source.replace(
    /import \{ createApp \} from '\.\.\/\.\.\/\.\.\/vendor\/vue\/vue\.esm-browser\.prod\.js';/,
    "import { createApp } from './vue-stub.mjs';",
  );
  // 替换没命中就说明 import 行被改过，后面所有断言会测到别的东西上。
  assert.notEqual(patched, source, 'app.js 的 Vue import 行没匹配上，沙箱拷贝已失效');
  writeFileSync(join(sandboxDir, 'app.js'), patched, 'utf8');
});

after(() => {
  if (sandboxDir) rmSync(sandboxDir, { recursive: true, force: true });
});

function createElement(doc, extra = {}) {
  return {
    isConnected: true,
    focusedCount: 0,
    focus() {
      this.focusedCount += 1;
      doc.activeElement = this;
    },
    ...extra,
  };
}

function createDom() {
  const elements = new Map();
  const listeners = new Map();
  const frames = [];
  let fetchHandler = () => {
    throw new Error('这个用例不该发请求');
  };
  let fetchCalls = [];

  const key = (bucket, type) => bucket + ':' + type;
  const add = (bucket, type, handler) => {
    const set = listeners.get(key(bucket, type)) || new Set();
    set.add(handler);
    listeners.set(key(bucket, type), set);
  };
  const remove = (bucket, type, handler) => listeners.get(key(bucket, type))?.delete(handler);

  const doc = {
    hidden: false,
    cookie: '',
    activeElement: null,
    querySelector: (selector) => elements.get(selector) || null,
    getElementById: (id) => elements.get('#' + id) || null,
    addEventListener: (type, handler) => add('document', type, handler),
    removeEventListener: (type, handler) => remove('document', type, handler),
    dispatch(type, event) {
      for (const handler of [...(listeners.get(key('document', type)) || [])]) handler(event);
    },
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: (type, handler) => add('window', type, handler),
    removeEventListener: (type, handler) => remove('window', type, handler),
    setTimeout: () => 0,
    clearTimeout: () => {},
  };

  return {
    doc,
    win,
    frames,
    get fetchCalls() { return fetchCalls; },
    register(selector, extra) {
      const element = createElement(doc, extra);
      elements.set(selector, element);
      return element;
    },
    get(selector) {
      return elements.get(selector) || null;
    },
    createElement(extra) {
      return createElement(doc, extra);
    },
    setFetch(handler) {
      fetchHandler = handler;
      fetchCalls = [];
    },
    callFetch(url, init) {
      fetchCalls.push({ url, init });
      return fetchHandler(url, init);
    },
    listenerCount(bucket, type) {
      return (listeners.get(key(bucket, type)) || new Set()).size;
    },
    runFrames() {
      const pending = frames.splice(0, frames.length);
      for (const callback of pending) callback();
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createInstance(options) {
  const instance = { ...options.data.call({}), ...options.methods };
  for (const [name, getter] of Object.entries(options.computed || {})) {
    Object.defineProperty(instance, name, {
      configurable: true,
      enumerable: true,
      get: () => getter.call(instance),
    });
  }
  instance.controller = {
    updates: [],
    updateUiState(patch) { this.updates.push(patch); },
  };
  instance.$nextTick = (callback) => Promise.resolve().then(() => (
    typeof callback === 'function' ? callback() : undefined
  ));
  return instance;
}

/* canvasWidth/canvasHeight 由拓扑包围盒推出来，这里直接钉住，
   才能断言方法读的是画布尺寸而不是布局盒子尺寸。 */
function pinCanvas(instance, width, height) {
  Object.defineProperty(instance, 'canvasWidth', { configurable: true, get: () => width });
  Object.defineProperty(instance, 'canvasHeight', { configurable: true, get: () => height });
}

async function loadComponent() {
  const dom = createDom();
  dom.register('#operations-overview-app', { dataset: { snapshotUrl: '/operations/overview/data/' } });
  dom.register('#operations-overview-bootstrap', { textContent: '{}' });
  dom.register('.topology-canvas-shell', { clientWidth: 1200 });
  dom.register('.topology-canvas', {});
  dom.register('#topology-ip-search', { value: '' });
  dom.register('.topology-drawer__close', {});
  dom.register('.topo-ledger__close', {});

  globalThis.document = dom.doc;
  globalThis.window = dom.win;
  globalThis.requestAnimationFrame = (callback) => {
    dom.frames.push(callback);
    return dom.frames.length;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id > 0 && id <= dom.frames.length) dom.frames[id - 1] = () => {};
  };
  globalThis.fetch = (url, init) => dom.callFetch(String(url), init);

  launchCount += 1;
  const url = pathToFileURL(join(sandboxDir, 'app.js')).href + '?launch=' + launchCount;
  delete globalThis.__opsOverviewOptions;
  await import(url);
  const options = globalThis.__opsOverviewOptions;
  assert.ok(options && options.methods && options.data, '没有拿到组件选项');
  return { dom, options, instance: createInstance(options) };
}

function singleNodeSnapshot() {
  return {
    generated_at: null,
    topology: {
      nodes: [
        {
          id: 'networks:fw', kind: 'backbone', role: 'firewall', tier: 0,
          label: 'FW-01', ip: '10.1.1.1', site_id: 0, site: '总部',
        },
      ],
      physical_edges: [],
      attachment_edges: [],
    },
  };
}

test('zoomBy 以视口中心为不动点，连点放大不会把视野甩出画布', async () => {
  const { instance } = await loadComponent();
  pinCanvas(instance, 2400, 1680);
  instance.viewport = { scale: 1, x: 130, y: 90 };

  const centerX = 1200;
  const centerY = 840;
  const contentX = (centerX - instance.viewport.x) / instance.viewport.scale;
  const contentY = (centerY - instance.viewport.y) / instance.viewport.scale;

  for (let index = 0; index < 8; index += 1) instance.zoomBy(0.15);

  assert.ok(instance.viewport.scale > 2, '连点 8 次应当放大到 2 倍以上');
  const projectedX = instance.viewport.x + contentX * instance.viewport.scale;
  const projectedY = instance.viewport.y + contentY * instance.viewport.scale;
  // 只允许 translate 保留一位小数带来的取整误差。
  assert.ok(Math.abs(projectedX - centerX) <= 1.5, '横向漂移 ' + (projectedX - centerX));
  assert.ok(Math.abs(projectedY - centerY) <= 1.5, '纵向漂移 ' + (projectedY - centerY));
  assert.equal(instance.controller.updates.at(-1).viewport, instance.viewport);
});

test('zoomBy 到达缩放上下限后不再改动视口', async () => {
  const { instance } = await loadComponent();
  pinCanvas(instance, 2400, 1680);
  instance.viewport = { scale: 1, x: 0, y: 0 };

  for (let index = 0; index < 12; index += 1) instance.zoomBy(-0.15);
  assert.equal(instance.viewport.scale, 0.6);
  const frozen = { ...instance.viewport };
  instance.zoomBy(-0.15);
  assert.deepEqual(instance.viewport, frozen);
});

test('locateByIp 用画布尺寸居中，而不是布局盒子尺寸', async () => {
  const { instance, dom } = await loadComponent();
  instance.snapshot = singleNodeSnapshot();
  instance.topologyWidth = 1100;
  instance.topologyHeight = 620;
  // 多场地横向排开 / 展开终端后的画布比布局盒子大。
  pinCanvas(instance, 2000, 1400);
  dom.get('#topology-ip-search').value = '10.1.1.1';

  await instance.locateByIp();

  const hit = instance.topology.nodes.find((node) => node.id === 'networks:fw');
  assert.ok(hit, '布局后应当能找到命中节点');
  const scale = instance.viewport.scale;
  const projectedX = instance.viewport.x + hit.x * scale;
  const projectedY = instance.viewport.y + hit.y * scale;
  assert.ok(Math.abs(projectedX - 1000) <= 2, '横向落点 ' + projectedX + '，应为画布中心 1000');
  assert.ok(Math.abs(projectedY - 700) <= 2, '纵向落点 ' + projectedY + '，应为画布中心 700');
  assert.equal(instance.searchHitId, 'networks:fw');
});

test('拖拽丢失 pointerup 时靠 buttons 收尾，且不重复挂 window 监听', async () => {
  const { instance, dom } = await loadComponent();
  instance.viewport = { scale: 1, x: 0, y: 0 };

  instance.startPan({ pointerId: 7, clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
  assert.equal(dom.listenerCount('window', 'pointermove'), 1);
  assert.equal(dom.listenerCount('window', 'pointerup'), 1);

  instance.movePan({ pointerId: 7, clientX: 60, clientY: 40, buttons: 1 });
  assert.equal(instance.panMoved, true);
  dom.runFrames();
  assert.deepEqual(instance.viewport, { scale: 1, x: 50, y: 30 });

  // 上一轮没收到 pointerup，又按下了一次：监听不能翻倍。
  instance.startPan({ pointerId: 8, clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
  assert.equal(dom.listenerCount('window', 'pointermove'), 1);
  assert.equal(dom.listenerCount('window', 'pointerup'), 1);
  assert.equal(dom.listenerCount('window', 'pointercancel'), 1);

  // 松手发生在窗口外：这一轮唯一的线索是 buttons 已经归零。
  instance.movePan({ pointerId: 8, clientX: 400, clientY: 400, buttons: 0 });
  assert.equal(instance.panStart, null);
  assert.equal(dom.listenerCount('window', 'pointermove'), 0);
  assert.equal(dom.listenerCount('window', 'pointerup'), 0);

  const frozen = { ...instance.viewport };
  instance.movePan({ pointerId: 8, clientX: 900, clientY: 900, buttons: 0 });
  assert.deepEqual(instance.viewport, frozen, '收尾之后不按键移动鼠标不该再平移');
});

test('正常松手（pointerup）也会拆掉 window 监听', async () => {
  const { instance, dom } = await loadComponent();
  instance.viewport = { scale: 1, x: 0, y: 0 };
  instance.startPan({ pointerId: 3, clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
  instance.movePan({ pointerId: 3, clientX: 30, clientY: 0, buttons: 1 });
  instance.endPan({ pointerId: 3 });
  assert.equal(dom.listenerCount('window', 'pointermove'), 0);
  assert.equal(dom.listenerCount('window', 'pointerup'), 0);
  assert.equal(instance.panStart, null);
});

test('subnetErrorMessage 把 DRF 各种错误形状都压成可读提示', async () => {
  const { instance } = await loadComponent();

  assert.equal(
    instance.subnetErrorMessage({ detail: '没有权限执行该操作' }, 403),
    '没有权限执行该操作',
  );
  assert.equal(
    instance.subnetErrorMessage({ cidr: ['该网段与已登记网段重叠'], vlan: ['该 VLAN 已被占用'] }, 400),
    '网段：该网段与已登记网段重叠；VLAN：该 VLAN 已被占用',
  );
  assert.equal(
    instance.subnetErrorMessage({ non_field_errors: ['同一网段不能重复登记'] }, 400),
    '同一网段不能重复登记',
  );
  assert.equal(instance.subnetErrorMessage({}, 500), '保存失败（HTTP 500）');
});

test('submitSubnet 把 400 的字段级错误显示出来，而不是只报 HTTP 400', async () => {
  const { instance, dom } = await loadComponent();
  dom.setFetch(async (url) => {
    if (url.includes('/api/v1/ip-subnets/')) return jsonResponse({ cidr: ['不是合法的 CIDR 前缀'] }, 400);
    return jsonResponse({ ledger: { rows: [], columns: [], counts: [] } }, 200);
  });
  instance.csrfToken = 'token';
  instance.subnetForm = {
    cidr: '10.0.0.0/33', purpose: 'office', vlan: '10',
    gateway: '', poolStart: '', poolEnd: '', note: '',
  };

  await instance.submitSubnet();

  assert.match(instance.subnetError, /网段：不是合法的 CIDR 前缀/);
  assert.equal(instance.subnetBusy, false);
});

test('取节点详情失败会在抽屉里说出来，而不是停在「未配置」', async () => {
  const { instance, dom } = await loadComponent();
  dom.setFetch(async () => jsonResponse({ detail: 'boom' }, 500));
  instance.drawerNodeId = 'networks:fw';
  instance.drawerFallback = { id: 'networks:fw', label: 'FW-01', ip: '' };

  await instance.loadNodeDetails({
    id: 'networks:fw', label: 'FW-01', detailsUrl: '/operations/overview/node/networks%3Afw/',
  });

  assert.equal(instance.drawerDetails.length, 1);
  assert.match(instance.drawerDetails[0].value, /读取失败（HTTP 500）/);
  assert.match(instance.liveStatus, /详情读取失败/);
  assert.equal(instance.nodeDetailsLoading['networks:fw'], undefined);
});

test('取节点详情失败不会挤掉快照里已有的资料', async () => {
  const { instance, dom } = await loadComponent();
  dom.setFetch(async () => jsonResponse({}, 502));
  instance.drawerNodeId = 'networks:fw';
  // 抽屉里的节点就是这一份（快照里带了基础资料），请求失败不能把它清掉。
  instance.drawerFallback = {
    id: 'networks:fw', label: 'FW-01', ip: '10.1.1.1',
    details: [{ label: '管理口', value: 'eth0' }],
  };

  await instance.loadNodeDetails({
    id: 'networks:fw', label: 'FW-01', ip: '10.1.1.1',
    details: [{ label: '管理口', value: 'eth0' }],
    detailsUrl: '/operations/overview/node/networks%3Afw/',
  });

  assert.deepEqual(instance.drawerDetails, [
    { label: '管理口', value: 'eth0' },
    { label: '详情读取失败', value: '读取失败（HTTP 502），请稍后重试' },
  ]);
});

test('A/B 两个节点交错打开时，先完成的不会清掉另一台的加载态', async () => {
  const { instance, dom } = await loadComponent();
  const pending = new Map();
  dom.setFetch((url) => new Promise((resolve) => { pending.set(url, resolve); }));

  instance.drawerNodeId = 'networks:a';
  instance.drawerFallback = { id: 'networks:a', label: 'A', ip: '' };
  const first = instance.loadNodeDetails({ id: 'networks:a', label: 'A', detailsUrl: '/node/a/' });
  instance.drawerNodeId = 'networks:b';
  instance.drawerFallback = { id: 'networks:b', label: 'B', ip: '' };
  const second = instance.loadNodeDetails({ id: 'networks:b', label: 'B', detailsUrl: '/node/b/' });

  assert.equal(instance.drawerDetails[0].label, '加载中');
  pending.get('/node/a/')(jsonResponse({ details: [{ label: '接口', value: 'Gi0/1' }] }));
  await first;
  assert.equal(instance.drawerDetails[0].label, '加载中', 'A 完成不该结束 B 的加载态');

  pending.get('/node/b/')(jsonResponse({ details: [{ label: 'VLAN', value: '20' }] }));
  await second;
  assert.deepEqual(instance.drawerDetails, [{ label: 'VLAN', value: '20' }]);
});

test('同一节点的旧响应晚到也不会覆盖新响应', async () => {
  const { instance, dom } = await loadComponent();
  const pending = [];
  dom.setFetch(() => new Promise((resolve) => { pending.push(resolve); }));
  const node = { id: 'networks:fw', label: 'FW-01', detailsUrl: '/node/fw/' };

  const first = instance.loadNodeDetails(node);
  const second = instance.loadNodeDetails(node);

  pending[0](jsonResponse({ details: [{ label: '旧', value: 'x' }] }));
  await first;
  pending[1](jsonResponse({ details: [{ label: '新', value: 'y' }] }));
  await second;

  assert.deepEqual(instance.nodeDetails['networks:fw'], [{ label: '新', value: 'y' }]);
  assert.equal(instance.nodeDetailsLoading['networks:fw'], undefined);
});

test('抽屉打开时焦点进入浮层，Esc 关闭并还回触发元素', async () => {
  const { instance, dom } = await loadComponent();
  const trigger = dom.createElement({ id: 'detail-pill' });
  dom.doc.activeElement = trigger;

  instance.openDrawer({ id: 'networks:fw', label: 'FW-01', ip: '' });
  await flush();

  assert.equal(dom.doc.activeElement, dom.get('.topology-drawer__close'), '焦点应进入抽屉');

  let prevented = 0;
  instance.handleKeydown({ key: 'Escape', preventDefault() { prevented += 1; } });

  assert.equal(instance.drawerNodeId, '');
  assert.equal(prevented, 1);
  assert.equal(dom.doc.activeElement, trigger, '关闭后焦点应回到打开它的元素');
});

test('从一个节点换到另一个节点时不会把回位目标记成抽屉里的按钮', async () => {
  const { instance, dom } = await loadComponent();
  const trigger = dom.createElement({ id: 'detail-pill' });
  dom.doc.activeElement = trigger;

  instance.openDrawer({ id: 'networks:fw', label: 'FW-01', ip: '' });
  await flush();
  instance.openDrawer({ id: 'networks:core', label: 'CORE-01', ip: '' });
  await flush();
  instance.closeDrawer();

  assert.equal(dom.doc.activeElement, trigger);
});

test('台账交出焦点，Esc 先关台账再关抽屉', async () => {
  const { instance, dom } = await loadComponent();
  dom.setFetch(async () => jsonResponse({ ledger: { rows: [], columns: [], counts: [] } }, 200));
  const opener = dom.createElement({ id: 'ledger-button' });
  dom.doc.activeElement = opener;

  await instance.openIpLedgerModal();
  await flush();
  assert.equal(instance.ledgerOpen, true);
  assert.equal(dom.doc.activeElement, dom.get('.topo-ledger__close'));

  instance.drawerNodeId = 'networks:fw';
  instance.handleKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(instance.ledgerOpen, false, '一次 Esc 只关最上面那层');
  assert.equal(instance.drawerNodeId, 'networks:fw');
  assert.equal(dom.doc.activeElement, opener, '关闭台账后焦点回到工具栏按钮');

  instance.handleKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(instance.drawerNodeId, '');
});

test('Esc 处理器在 mounted 挂上、beforeUnmount 摘掉', () => {
  const source = readFileSync(join(OVERVIEW_DIR, 'app.js'), 'utf8');
  assert.match(source, /document\.addEventListener\('keydown', this\.handleKeydown\)/);
  assert.match(source, /document\.removeEventListener\('keydown', this\.handleKeydown\)/);
});
