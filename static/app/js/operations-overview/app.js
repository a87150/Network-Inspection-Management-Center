import { createApp } from '../../../vendor/vue/vue.esm-browser.prod.js';
import { createRefreshController } from './state.js';
import {
  normalizeTopology, visibleTopology, reconcileExpandedIds, layoutTopology, parentToExpand,
} from './topology.js';
import { createAmbientEffects } from './effects.js';

/* 抽屉/台账打开前的焦点位置按组件实例存。
   不放进 data()：DOM 节点一旦进了响应式代理，之后访问 isConnected、调用
   focus() 在部分浏览器会抛 Illegal invocation（方法里的 this 变成了 Proxy）。
   WeakMap 既不参与响应式，也不会把节点留到组件销毁之后。 */
const focusReturnTargets = new WeakMap();

function focusMemory(instance) {
  let memory = focusReturnTargets.get(instance);
  if (!memory) {
    memory = { drawer: null, ledger: null };
    focusReturnTargets.set(instance, memory);
  }
  return memory;
}

/* 两个 Set 内容一致就返回 true。用来判断 reconcileExpandedIds 的结果是不是
   真的变了——每次 notify 都换新引用会让所有依赖它的 computed 失效。 */
function sameIdSet(left, right) {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

/* DRF 的字段级错误里只有英文键（cidr/pool_start…），直接拼给用户看等于
   让他去猜是哪个输入框。这里换成模板里显示的中文标签。 */
const SUBNET_FIELD_LABELS = {
  cidr: '网段',
  purpose: '用途',
  vlan: 'VLAN',
  gateway: '网关',
  pool_start: 'DHCP 池起始',
  pool_end: 'DHCP 池结束',
  note: '备注',
};

const mountElement = document.querySelector('#operations-overview-app');
const bootstrapElement = document.querySelector('#operations-overview-bootstrap');

if (mountElement && bootstrapElement) {
  const initialSnapshot = JSON.parse(bootstrapElement.textContent);
  const endpoint = mountElement.dataset.snapshotUrl;

  const application = createApp({
    delimiters: ['[[', ']]'],
    data() {
      return {
        snapshot: initialSnapshot,
        refreshing: false,
        stale: false,
        error: '',
        manualPaused: false,
        hidden: document.hidden,
        filter: 'all',
        viewport: { scale: 1, x: 0, y: 0 },
        topologyWidth: 1100,
        topologyHeight: 620,
        selectedEdgeId: '',
        expandedNodeIds: new Set(),
        drawerNodeId: '',
        drawerFallback: null,
        csrfToken: '',
        ledgerOpen: false,
        subnetFormOpen: false,
        subnetBusy: false,
        subnetError: '',
        subnetForm: { cidr: '', purpose: 'office', vlan: '', gateway: '', poolStart: '', poolEnd: '', note: '' },
        subnetPurposes: [
          { value: 'office', label: '办公' },
          { value: 'management', label: '管理' },
          { value: 'server', label: '服务器' },
          { value: 'wireless', label: '无线' },
          { value: 'other', label: '其他' },
        ],
        ledgerLoading: false,
        ledgerError: '',
        ledger: { columns: [], rows: [], counts: [], empty_title: '', empty_message: '' },
        // 节点详情点开抽屉时才取，首屏 snapshot 不带。
        nodeDetails: {},
        // 在途与失败状态按节点 id 记。原来是一个全局 busy 布尔：A、B 两个节点
        // 交错打开时，先回来的 A 会把 busy 置 false，B 的抽屉立刻从「加载中」
        // 变成「未配置」，看上去像这台设备没有资料。
        nodeDetailsLoading: {},
        nodeDetailsErrors: {},
        nodeDetailSeq: {},
        liveStatus: '网络拓扑已就绪',
        controller: null,
        unsubscribe: null,
        ambientEffects: null,
        requestAbortController: null,
        panStart: null,
        // 当前这轮拖动挂在 window 上的监听拆除函数。存在实例上而不是闭包里，
        // 才能在下一次 startPan 或漏掉的 pointerup 之后把它收掉。
        panCleanup: null,
      panMoved: false,
        // 按 IP 定位：输入的查询串和命中的节点 id，模板据此高亮。
        ipQuery: '',
        searchHitId: '',
        // 悬停的边：和选中一样露出端口/VLAN 标签，移开就收。
        hoveredEdgeId: '',
      };
    },
    computed: {
      generatedLabel() {
        return this.formatTime(this.snapshot.generated_at);
      },
      topology() {
        const fullGraph = normalizeTopology(this.snapshot.topology || {});
        const graph = visibleTopology(fullGraph, this.expandedNodeIds);
        if (this.filter !== 'all') {
          graph.physicalEdges = graph.physicalEdges.filter((edge) => (
            this.filter === 'unresolved'
              ? edge.resolutionStatus === 'unresolved'
              : edge.status === this.filter
          ));
        }
        return layoutTopology(graph, { width: this.topologyWidth, height: this.topologyHeight });
      },
      /* asset_truncation 里既有计数也有说明性的字符串（链路超上限、端点顶破上限）。
         计数走 truncationCount，说明文字走这里，两路都要显示，否则那几句永远不出现。 */
      truncationNotes() {
        return Object.values(this.snapshot.topology?.asset_truncation || {})
          .filter((value) => typeof value === 'string' && value.trim())
          .map((value) => value.trim());
      },
      truncationCount() {
        // asset_truncation 里混着非计数字段（operations.py 会写 links: '...' 之类的字符串）。
        // 直接 Number() 它们得到 NaN，reduce 一路传染成 NaN，v-if 判假，
        // 「另有 N 个设备未绘制」整块就再也不显示了。这里只累加真正的数字。
        return Object.values(this.snapshot.topology?.asset_truncation || {})
          .reduce((total, value) => {
            const count = typeof value === 'number' ? value : Number.NaN;
            return Number.isFinite(count) ? total + count : total;
          }, 0);
      },
      /* 层间带上的车道分配。
         原来每条边都把水平段放在「上下两点正中」，同一层之间的边 from/to 完全
         相同，于是所有水平段落在同一条 y 上，叠成一根横线——图上看不出谁连谁。
         这里按「上沿 → 下沿」把边分组，同组内按横向跨度排序后依次错开。 */
      edgeLanes() {
        const lanes = new Map();
        const groups = new Map();
        const nudge = (y) => Math.round(y * 2) / 2;  // 同一层的小数差不算不同层
        for (const edge of this.topology.physicalEdges || []) {
          const source = this.topologyNodes.get(edge.source);
          const target = this.topologyNodes.get(edge.target);
          if (!source || !target) continue;
          if (Math.abs(source.y - target.y) < 12) continue;  // 同层互联另走一条规则
          const upper = source.y < target.y ? source : target;
          const lower = source.y < target.y ? target : source;
          const from = nudge(upper.y + this.nodeBottom(upper));
          const to = nudge(lower.y + this.nodeTop(lower));
          if (to - from < 24) continue;  // 带子太窄，错开会挤在一起
          const key = from + '|' + to;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ id: edge.id, from, to, span: Math.abs(source.x - target.x) });
        }
        for (const list of groups.values()) {
          if (list.length < 2) continue;
          // 跨度大的排外侧：长线走外圈，短线在中间，交叉最少。
          list.sort((left, right) => right.span - left.span || (left.id < right.id ? -1 : 1));
          const band = list[0].to - list[0].from;
          const step = Math.min(12, Math.max(3, band / (list.length + 1)));
          const middle = list[0].from + band / 2;
          list.forEach((item, index) => {
            lanes.set(item.id, middle + (index - (list.length - 1) / 2) * step);
          });
        }
        return lanes;
      },
      /* 同一台设备上的多条边从卡片边缘的不同位置引出。双上联的两条线如果都从
         卡片中心出发，绕一大圈之后又收成同一个点，缩小时并成一根看不出是两条。
         按对端设备的横向位置排开：对端在左的走左，在右的走右，最多偏 8px。 */
      edgeAnchors() {
        const anchors = new Map();
        const grouped = new Map();
        for (const edge of this.topology.physicalEdges || []) {
          const source = this.topologyNodes.get(edge.source);
          const target = this.topologyNodes.get(edge.target);
          if (!source || !target) continue;
          for (const [selfId, otherX] of [[edge.source, target.x], [edge.target, source.x]]) {
            if (!grouped.has(selfId)) grouped.set(selfId, []);
            grouped.get(selfId).push({ key: edge.id + '@' + selfId, otherX });
          }
        }
        for (const list of grouped.values()) {
          if (list.length < 2) continue;
          list.sort((left, right) => left.otherX - right.otherX);
          const step = Math.min(8, 32 / (list.length - 1));
          const origin = -((list.length - 1) * step) / 2;
          list.forEach((item, index) => anchors.set(item.key, origin + index * step));
        }
        return anchors;
      },
      topologyNodes() {
        return new Map(this.topology.nodes.map((node) => [node.id, node]));
      },
      selectedEdge() {
        return [...this.topology.physicalEdges, ...this.topology.attachmentEdges]
          .find((edge) => edge.id === this.selectedEdgeId) || null;
      },
      drawerNode() {
        if (!this.drawerNodeId) return null;
        const hit = this.topology.nodes.find((node) => node.id === this.drawerNodeId);
        return hit || this.drawerFallback;
      },
      canvasHeight() {
        const maxY = (this.topology && this.topology.bounds && this.topology.bounds.maxY) || 0;
        return Math.max(this.topologyHeight, Math.ceil(maxY + 24));
      },
      /* 多场地时横向排开，画布跟着变宽，用横向滚动看完整张图。 */
      canvasWidth() {
        const maxX = (this.topology && this.topology.bounds && this.topology.bounds.maxX) || 0;
        return Math.max(this.topologyWidth, Math.ceil(maxX + 24));
      },
      drawerDetails() {
        const node = this.drawerNode;
        const id = node && node.id;
        // 「加载中」只针对当前这个节点，不能用全局忙闲判断：
        // 否则 A 的请求收尾时会把 B 抽屉的加载态一起清掉。
        if (id && this.nodeDetailsLoading[id]) return [{ label: '加载中', value: '正在读取该节点详情…' }];
        const cached = id ? this.nodeDetails[id] : undefined;
        const details = cached !== undefined ? cached : ((node && node.details) || []);
        // 取详情失败原来只 console.error，抽屉照旧渲染成「未配置」，
        // 看起来像这台设备真没有资料。失败必须说出来，但不能挤掉已有的资料。
        const error = id ? this.nodeDetailsErrors[id] : '';
        if (error && !details.length) return [{ label: '详情读取失败', value: error }];
        if (error) return [...details, { label: '详情读取失败', value: error }];
        return details.length ? details : [{ label: 'IP / 备注', value: node?.ip || '未配置' }];
      },
    },
    methods: {
      setFilter() {
        this.controller?.updateUiState({ filter: this.filter });
        this.selectedEdgeId = '';
        this.liveStatus = '拓扑链路筛选已更新';
      },
      togglePause() {
        // 不能拿 this.manualPaused 判文案：它要等 controller notify 回来才更新，
        // 这里读到的是旧值，暂停时会显示成已恢复。
        const next = !this.manualPaused;
        this.manualPaused = next;
        this.controller?.setManualPaused(next);
        this.liveStatus = next ? '自动刷新已暂停' : '自动刷新已恢复';
      },
      async refreshNow() {
        await this.controller?.refresh();
        this.liveStatus = this.stale ? this.error : '数据刷新成功';
      },
      syncControllerState(next) {
        const previousGeneratedAt = this.snapshot?.generated_at;
        this.snapshot = next.lastSnapshot;
        /* 这里每次 notify 都算一遍 reconcileExpandedIds 是对的（快照可能变了），
           但**不能无条件换新 Set**：expandedNodeIds 参与 visibleTopology 等 computed，
           换引用就让它们全部失效。滚动、缩放、拖拽每个 tick 都会 notify，于是
           每个 tick 都跑一次全量 normalize + visible + layout 并重渲染整棵 SVG
           （实测 80 主干 / 320 终端时 12ms 一次）。内容没变就复用旧引用。 */
        const reconciled = reconcileExpandedIds(
          this.expandedNodeIds,
          normalizeTopology(this.snapshot.topology || {}),
        );
        if (!sameIdSet(reconciled, this.expandedNodeIds)) {
          this.expandedNodeIds = reconciled;
        }
        this.refreshing = next.refreshing;
        this.stale = next.stale;
        this.error = next.error;
        this.manualPaused = next.manualPaused;
        this.hidden = next.hidden;
        this.filter = next.filter;
        this.viewport = { ...next.viewport };
        if (previousGeneratedAt !== this.snapshot?.generated_at) {
          // 快照换了，节点详情缓存必须跟着失效：抽屉里显示的是上一轮取到的那份，
          // 不比对 generated_at 就会一直停在旧数据上，直到用户手动刷新页面。
          this.nodeDetails = {};
          this.nodeDetailsErrors = {};
          if (!next.refreshing) this.liveStatus = '网络拓扑数据已更新';
        }
      },
      /* 拖一次窗口能触发上百个 resize 事件，每次都改 topologyWidth/Height
         就会让布局 computed 全量重算并重渲染。挂上去的 resize 走合帧，
         首次挂载和 $nextTick 那次走 measureCanvas 直接量。 */
      updateDimensions() {
        if (this.dimensionsFrame) return;
        this.dimensionsFrame = window.requestAnimationFrame(() => {
          this.dimensionsFrame = 0;
          this.measureCanvas();
        });
      },
      measureCanvas() {
        const shell = mountElement.querySelector('.topology-canvas-shell');
        const width = shell?.clientWidth || window.innerWidth;
        // 量容器实际高度：写死 720 时布局按 720 排，画布比它高就上下留白，
        // 比它矮就溢出。容器还没尺寸时才退回常量。
        const measured = shell ? shell.clientHeight : 0;
        const height = measured > 0 ? measured : (window.innerWidth < 768 ? 1100 : 720);
        const nextWidth = Math.max(320, Math.min(1400, width));
        if (this.topologyWidth !== nextWidth) this.topologyWidth = nextWidth;
        if (this.topologyHeight !== height) this.topologyHeight = height;
      },
      /* 按 IP 定位：命中就把视口平移过去并高亮，没命中只提示，不动视口。 */
      async locateByIp() {
        // v-model 在这页没同步，直接以输入框的当前值为准。
        const field = document.getElementById('topology-ip-search');
        const query = String((field && field.value) || this.ipQuery || '').trim().toLowerCase();
        if (!query) {
          // 空输入直接 return 时，点「IP 查询」什么都不发生，用户以为按钮坏了。
          this.liveStatus = '请输入 IP 或设备名再查询';
          field?.focus?.();
          return;
        }
        // 先在完整图里找。this.topology 是「可见」图，折叠起来的终端根本不在里面，
        // 只查可见图会永远漏掉挂在未展开主干下的设备，然后落到台账兜底——
        // 用户要的是在图上看到它，不是打开一个侧边详情。
        const full = normalizeTopology(this.snapshot.topology || {});
        const fullNodes = full.nodes || [];
        const match = (list) => list.find((node) => String(node.ip || '').toLowerCase() === query)
          || list.find((node) => String(node.ip || '').toLowerCase().includes(query))
          || list.find((node) => String(node.label || '').toLowerCase().includes(query));
        const found = match(fullNodes);
        if (!found) {
          // 图上和完整图里都没有这台设备，再去台账查 ARP/MAC，
          // 但要说清是「图里没有」而不是「资产里没有」。
          this.searchHitId = '';
          await this.locateByLedger(query);
          return;
        }

        // 命中但被折叠：把父节点展开。不展开的话布局不会重算，
        // 下面拿到的坐标还是旧的，视口会平移到一片空白上。
        const expandId = parentToExpand(found, this.expandedNodeIds);
        if (expandId) {
          const next = new Set(this.expandedNodeIds);
          next.add(expandId);
          this.expandedNodeIds = next;
          // 等一次渲染，让 computed 重新算坐标。
          await this.$nextTick();
        }

        // 展开后重新取一次：完整图里的节点没有 x/y，坐标只有布局后才有。
        const hit = (this.topology?.nodes || []).find((node) => node.id === found.id) || found;
        this.searchHitId = hit.id;
        // 直接开完整侧边栏：接口、VLAN、对端都在里面，比一张小卡片信息全。
        this.openDrawer(hit);
        // 命中的节点居中：视口 translate 是把内容点搬到屏幕中心的反向量。
        // 中心必须取 canvasWidth/canvasHeight（viewBox 的真实尺寸），不是
        // topologyWidth/topologyHeight（布局盒子）。多场地时画布横向变宽、
        // 展开终端后画布纵向变高，用布局盒子算会把命中节点推到视口之外。
        const scale = this.viewport?.scale || 1;
        this.viewport = {
          scale,
          x: Number((this.canvasWidth / 2 - hit.x * scale).toFixed(1)),
          y: Number((this.canvasHeight / 2 - hit.y * scale).toFixed(1)),
        };
        this.controller?.updateUiState({ viewport: this.viewport });
        this.liveStatus = '已定位 ' + (hit.label || hit.ip);
      },
      /* 图上找不到时回台账查：ARP/MAC 记录能回答"这个 IP 是谁、在哪台设备下"。 */
      async locateByLedger(query) {
        this.liveStatus = '图上没有这台设备，正在查台账…';
        try {
          const response = await fetch(
            '/operations/ip-lookup/?q=' + encodeURIComponent(query),
            { headers: { 'X-Requested-With': 'XMLHttpRequest' } },
          );
          if (!response.ok) throw new Error(String(response.status));
          const data = await response.json();
          const rows = data.results || [];
          if (!rows.length) {
            this.liveStatus = '图上和资产里都没有「' + query + '」';
            return;
          }
          const row = rows[0];
          this.liveStatus = '图上没画这台设备，已从资产里打开它的详情';
          // 图上没画不等于不存在：用 kind:pk 直接查这台资产的详情，展开同一个侧边栏。
          this.openAssetDrawer(row);
        } catch (error) {
          this.liveStatus = '台账查询失败，请稍后重试';
        }
      },
      /* 工具栏的「＋/－」和滚轮必须是同一套定点缩放。
         只改 scale 不补 translate，内容会以 (0,0) 为不动点缩放：
         连点 6~8 次放大后视野整块被推出画布，用户只能靠「重置」救回来。
         这里以视口中心为不动点（canvasWidth/2, canvasHeight/2，与 wheelZoom
         同一套用户坐标），公式同 wheelZoom：t' = p - (p - t) * (s'/s)。 */
      zoomBy(delta) {
        const current = this.viewport?.scale || 1;
        const scale = Number(Math.min(2.2, Math.max(0.6, current + delta)).toFixed(2));
        // 已经在缩放上下限时不动视口，避免无意义的取整抖动。
        if (scale === current) return;
        const ratio = scale / current;
        const pointX = this.canvasWidth / 2;
        const pointY = this.canvasHeight / 2;
        this.viewport = {
          scale,
          x: Number((pointX - (pointX - this.viewport.x) * ratio).toFixed(1)),
          y: Number((pointY - (pointY - this.viewport.y) * ratio).toFixed(1)),
        };
        this.controller?.updateUiState({ viewport: this.viewport });
      },
      /* 滚轮缩放：以鼠标所指的点为不动点。
         变换是 translate(x y) scale(s)，屏幕点 p 对应的内容点是 (p - t) / s；
         缩放后要让同一个内容点还落在 p 上，所以 t' = p - (p - t) * (s'/s)。

         滚轮事件一秒能来上百次，每次都写 viewport 就是每次都让整棵 SVG 重渲染。
         拖动平移那条路径早有 rAF 合帧，缩放这条漏了。这里把一帧内的多次事件合成
         一次：只在第一次时开帧，后续只更新待处理的值。 */
      wheelZoom(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const pending = this.pendingZoom || (this.pendingZoom = { frame: 0 });
        pending.deltaY = event.deltaY;
        pending.clientX = event.clientX;
        pending.clientY = event.clientY;
        pending.left = rect.left;
        pending.top = rect.top;
        pending.width = rect.width;
        pending.height = rect.height;
        pending.viewBoxWidth = canvas.viewBox.baseVal.width;
        pending.viewBoxHeight = canvas.viewBox.baseVal.height;
        if (pending.frame) return;
        pending.frame = window.requestAnimationFrame(() => {
          pending.frame = 0;
          this.applyWheelZoom(pending);
        });
      },
      applyWheelZoom(pending) {
        const factor = pending.deltaY < 0 ? 1.12 : 1 / 1.12;
        const scale = Math.min(2.2, Math.max(0.6, this.viewport.scale * factor));
        if (scale === this.viewport.scale) return;
        const ratio = scale / this.viewport.scale;
        // 鼠标位置换算到 SVG 用户坐标，再换回屏幕像素，避免 viewBox 与 CSS 尺寸不等。
        const pointX = ((pending.clientX - pending.left) / pending.width) * pending.viewBoxWidth;
        const pointY = ((pending.clientY - pending.top) / pending.height) * pending.viewBoxHeight;
        this.viewport = {
          scale: Number(scale.toFixed(3)),
          x: Number((pointX - (pointX - this.viewport.x) * ratio).toFixed(1)),
          y: Number((pointY - (pointY - this.viewport.y) * ratio).toFixed(1)),
        };
        this.controller?.updateUiState({ viewport: this.viewport });
      },
      resetViewport() {
        this.viewport = { scale: 1, x: 0, y: 0 };
        this.controller?.updateUiState({ viewport: this.viewport });
      },
      fitViewport() {
        this.updateDimensions();
        this.resetViewport();
        this.liveStatus = '拓扑已适应当前屏幕';
      },
      /* 整块画布都能拖：以前只绑空白处，图一密就没有可抓的地方。
         不能用 setPointerCapture：捕获后 click 的目标会变成 svg，
         节点上的 openDrawer 永远收不到事件，表现就是"点详情没反应"。
         没有捕获就没有兜底的 pointerup：松手发生在窗口外、或者按住时标签页
         被切走，pointerup/pointercancel 都不会到。所以自己管这组监听——
         startPan 先拆上一轮残留的，endPan 拆自己的，movePan 再按
         event.buttons 收尾（见下）。漏一个就是一次「不按键移动鼠标也在平移，
         而且 window 上多留一组监听」。 */
      startPan(event) {
        this.panCleanup?.();
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        this.panMoved = false;
        this.panStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          originX: this.viewport.x, originY: this.viewport.y };
        // 指针移出画布也要继续跟着走，所以挂在 window 上而不是 svg 上。
        const move = (evt) => this.movePan(evt);
        const up = (evt) => this.endPan(evt);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        this.panCleanup = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          this.panCleanup = null;
        };
      },
      movePan(event) {
        // 指针事件说「现在没有任何键按下」，而我们还认为自己正在拖：
        // 说明 pointerup 丢了。立刻收尾，否则回到页面不按键移动鼠标也会拖着画布走。
        if (event.buttons === 0) {
          this.endPan(event);
          return;
        }
        if (!this.panStart || this.panStart.pointerId !== event.pointerId) return;
        const dx = event.clientX - this.panStart.x;
        const dy = event.clientY - this.panStart.y;
        // 超过阈值才算拖动，否则一次抖动就把点击吃掉了。
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.panMoved = true;
        if (!this.panMoved) return;
        this.pendingPan = {
          ...this.viewport,
          x: this.panStart.originX + dx,
          y: this.panStart.originY + dy,
        };
        // pointermove 一帧能来好几次，每次整体替换 viewport 都会让整棵 SVG
        // 跟着重渲染。压到每帧一次，拖动 320 个节点时不再掉帧。
        if (this.panFrame) return;
        this.panFrame = requestAnimationFrame(() => {
          this.panFrame = null;
          if (this.pendingPan) this.viewport = this.pendingPan;
        });
      },
      endPan(event) {
        // pointerId 对不上也要拆监听：多指、或者按到一半换了指针设备时，
        // 在这里提前 return 会把这组 window 监听永久留在 window 上。
        const owns = Boolean(this.panStart) && this.panStart.pointerId === event.pointerId;
        this.panCleanup?.();
        if (!owns) return;
        if (this.panFrame) {
          cancelAnimationFrame(this.panFrame);
          this.panFrame = null;
        }
        if (this.pendingPan) {
          this.viewport = this.pendingPan;
          this.pendingPan = null;
        }
        this.panStart = null;
        this.controller?.updateUiState({ viewport: this.viewport });
      },
      /* 拖动结束那一下的 click 不该当成点节点。 */
      suppressClickAfterPan(event) {
        if (!this.panMoved) return;
        event.stopPropagation();
        event.preventDefault();
        this.panMoved = false;
      },
      /* 卡片上下边缘：连线从这里出发，不穿卡片。和模板里的 rect 尺寸保持一致。 */
      nodeTop(node) {
        return node.kind === 'backbone' ? -35 : -28;
      },
      nodeBottom(node) {
        return node.kind === 'backbone' ? 45 : 38;
      },
      /* 正交折线：垂直下落 → 横移 → 垂直落到上级/下级的边缘。
         树状图靠的就是这条折线，读者可以顺着一条竖线找到父设备。 */
      elbowPath(edge) {
        const source = this.topologyNodes.get(edge.source);
        const target = this.topologyNodes.get(edge.target);
        if (!source || !target) return '';
        if (Math.abs(source.y - target.y) < 12) {
          // 同层互联（核心之间、交换机之间）：下探一点再横着过去，不压住卡片。
          const dip = Math.max(
            source.y + this.nodeBottom(source),
            target.y + this.nodeBottom(target),
          ) + 20;
          const sourceDx = this.edgeAnchors.get(edge.id + '@' + edge.source) || 0;
        const targetDx = this.edgeAnchors.get(edge.id + '@' + edge.target) || 0;
        return `M ${source.x + sourceDx} ${source.y + this.nodeBottom(source)} V ${dip} H ${target.x + targetDx} V ${target.y + this.nodeBottom(target)}`;
        }
        const upper = source.y < target.y ? source : target;
        const lower = source.y < target.y ? target : source;
        const from = upper.y + this.nodeBottom(upper);
        const to = lower.y + this.nodeTop(lower);
        // 同一层间带上有多条边时走分配好的车道，只有一条时仍取正中。
        const lane = this.edgeLanes.get(edge.id);
        const mid = lane === undefined ? from + Math.max(14, (to - from) / 2) : lane;
        const upperDx = this.edgeAnchors.get(edge.id + '@' + upper.id) || 0;
        const lowerDx = this.edgeAnchors.get(edge.id + '@' + lower.id) || 0;
        return `M ${upper.x + upperDx} ${from} V ${mid} H ${lower.x + lowerDx} V ${to}`;
      },
      edgePath(edge) {
        return this.elbowPath(edge);
      },
      /* 正交折线的标签点：水平段中点。上下两端没对齐时这一段在垂直段之间。 */
      edgeLabelPoint(edge) {
        const source = this.topologyNodes.get(edge.source);
        const target = this.topologyNodes.get(edge.target);
        if (!source || !target) return { x: 0, y: 0 };
        const upper = source.y < target.y ? source : target;
        const lower = source.y < target.y ? target : source;
        const from = upper.y + this.nodeBottom(upper);
        const to = lower.y + this.nodeTop(lower);
        const lane = this.edgeLanes.get(edge.id);
        const mid = lane === undefined ? from + Math.max(14, (to - from) / 2) : lane;
        return { x: (source.x + target.x) / 2, y: mid };
      },
      /* 两端各标自己的端口，而不是把两侧拼成一行挂在中间。
         网络模拟器的连线就是这么标的：靠近哪个设备就是哪个设备的口。 */
      edgePortLabels(edge) {
        const source = this.topologyNodes.get(edge.source);
        const target = this.topologyNodes.get(edge.target);
        if (!source || !target) return [];
        const upper = source.y < target.y ? source : target;
        const lower = source.y < target.y ? target : source;
        const upperIsSource = upper.id === edge.source;
        const upperLabel = String((upperIsSource ? edge.localInterfaceLabel : edge.remoteInterfaceLabel) || '').trim();
        const lowerLabel = String((upperIsSource ? edge.remoteInterfaceLabel : edge.localInterfaceLabel) || '').trim();
        const labels = [];
        if (upperLabel) {
          labels.push({
            key: 'up', text: upperLabel,
            x: upper.x + (this.edgeAnchors.get(edge.id + '@' + upper.id) || 0),
            y: upper.y + this.nodeBottom(upper) + 12,
          });
        }
        if (lowerLabel) {
          labels.push({
            key: 'down', text: lowerLabel,
            x: lower.x + (this.edgeAnchors.get(edge.id + '@' + lower.id) || 0),
            y: lower.y + this.nodeTop(lower) - 6,
          });
        }
        return labels;
      },
      /* 终端归属按证据强度分色：物理发现最硬，MAC 表次之，网段推断最软。 */
      attachmentEdgeClass(edge) {
        const source = edge && edge.attachmentSource;
        if (source === 'physical_discovered') return 'topology-edge--attachment-physical';
        if (source === 'mac_learned') return 'topology-edge--attachment-mac';
        return 'topology-edge--inferred';
      },
      attachmentSourceLabel(source) {
        if (source === 'physical_discovered') return '设备物理发现（LLDP/CDP）';
        if (source === 'mac_learned') return 'MAC 地址表定位';
        if (source === 'inferred_subnet') return '相同 IP 网段推断';
        return '未知';
      },
      edgeVlanLabel(edge) {
        const ids = Array.isArray(edge.vlanIds) ? edge.vlanIds : [];
        return ids.length ? 'VLAN ' + ids.join(',') : '';
      },
      /* 只给选中和悬停的边显示标签：221 条链路全铺文字会糊成一片。 */
      edgeLabelVisible(edge) {
        if (edge.id === this.selectedEdgeId || edge.id === this.hoveredEdgeId) return true;
        const scale = (this.viewport && this.viewport.scale) || 1;
        return scale >= 1.2;
      },
      hoverEdge(edge) {
        this.hoveredEdgeId = edge ? edge.id : '';
      },
      hierarchyPath(edge) {
        return this.elbowPath(edge);
      },
      selectEdge(edge) {
        this.selectedEdgeId = edge.id;
        this.liveStatus = `已选择 ${edge.protocolLabel}链路`;
      },
      toggleNode(node) {
        if (node.kind !== 'backbone' || !node.childCount) return;
        const next = new Set(this.expandedNodeIds);
        next.has(node.id) ? next.delete(node.id) : next.add(node.id);
        this.expandedNodeIds = next;
        this.selectedEdgeId = '';
        this.liveStatus = `${node.label}${next.has(node.id) ? '已展开' : '已收起'}，${node.childCount} 个终端`;
      },
      edgeAriaLabel(edge) {
        const source = this.topologyNodes.get(edge.source)?.label || '未知设备';
        const target = this.topologyNodes.get(edge.target)?.label || '未知邻居';
        return `${source} 到 ${target}，${edge.protocolLabel}，${edge.statusLabel}`;
      },
      roleLabel(node) {
        return ({
          firewall: '防火墙', router: '路由器', core_switch: '核心交换机',
          distribution_switch: '汇聚交换机', access_switch: '接入交换机',
          wireless_controller: '无线 AC', network_other: '网络设备',
          access_point: 'AP', computer: 'PC', server: '服务器',
          weak_current_device: node.subtitle || '弱电设备', unresolved_neighbor: '未解析邻居',
        })[node.role] || '终端';
      },
      truncate(value, length) {
        const stringValue = String(value || '');
        return stringValue.length > length ? `${stringValue.slice(0, length - 1)}…` : stringValue;
      },
      cardWidth(node) {
        return node.cardWidth || (node.kind === 'backbone' ? 156 : 120);
      },
      /* 抽屉、台账都是 role="dialog"。打开时把焦点移进去，关闭时还给触发元素：
         不移进去，Tab 会继续在背后被遮挡的画布上走；不还回去，焦点落在 <body>，
         下一次 Tab 从页面开头重来。两者都只在 JS 里做，模板结构不用动。 */
      captureFocus(slot) {
        focusMemory(this)[slot] = document.activeElement || null;
      },
      restoreFocus(slot) {
        const memory = focusMemory(this);
        const target = memory[slot];
        memory[slot] = null;
        // 触发元素可能已经随重渲染消失（快照刷新会重建节点）。这时不给兜底：
        // 硬塞焦点到一个不相干的控件上比交给浏览器默认处理更糟。
        if (target && target.isConnected !== false && typeof target.focus === 'function') target.focus();
      },
      /* 浮层由 v-if 插入，这一帧还没有节点；$nextTick 里才拿得到。 */
      focusOverlay(selector) {
        this.$nextTick(() => {
          const panel = document.querySelector(selector);
          if (panel && typeof panel.focus === 'function') panel.focus();
        });
      },
      openDrawer(node) {
        // 抽屉已经开着（从一个节点换到另一个）时不要重记回位目标：
        // 此刻 activeElement 已经在抽屉里，记住它等于关闭后把焦点扔进虚空。
        if (!this.drawerNodeId) this.captureFocus('drawer');
        this.drawerNodeId = node.id;
        this.liveStatus = `已打开 ${node.label} 的详情`;
        this.focusOverlay('.topology-drawer__close');
        this.loadNodeDetails(node);
      },
      /** 抽屉里的详情按节点 id 单独取，取过一次就缓存，来回点不再发请求。 */
      async loadNodeDetails(node) {
        const id = node && node.id;
        if (!id || this.nodeDetails[id] || !node.detailsUrl) return;
        // 每次请求带一个自增序号。同一节点先后发起两次（先失败后重试）时，
        // 只有序号最新的那次能写结果，先发的慢响应不会覆盖后发的。
        const seq = (this.nodeDetailSeq[id] || 0) + 1;
        this.nodeDetailSeq = {...this.nodeDetailSeq, [id]: seq};
        this.nodeDetailsLoading = {...this.nodeDetailsLoading, [id]: true};
        this.nodeDetailsErrors = {...this.nodeDetailsErrors, [id]: ''};
        try {
          const response = await fetch(node.detailsUrl, {headers: {'X-Requested-With': 'XMLHttpRequest'}});
          if (this.nodeDetailSeq[id] !== seq) return;
          if (!response.ok) {
            // 原来在这里直接 return：抽屉停在「未配置」，用户以为设备真的没资料。
            this.nodeDetailsErrors = {
              ...this.nodeDetailsErrors,
              [id]: '读取失败（HTTP ' + response.status + '），请稍后重试',
            };
            this.liveStatus = node.label + ' 的详情读取失败，请稍后重试';
            return;
          }
          const data = await response.json();
          if (this.nodeDetailSeq[id] !== seq) return;
          this.nodeDetails = {...this.nodeDetails, [id]: data.details || []};
        } catch (error) {
          if (this.nodeDetailSeq[id] !== seq) return;
          console.error('取节点详情失败：', error);
          this.nodeDetailsErrors = {...this.nodeDetailsErrors, [id]: '详情读取失败，请检查网络后重试'};
          this.liveStatus = node.label + ' 的详情读取失败，请稍后重试';
        } finally {
          // 只清自己那一次的加载标记：并发的另一台设备还在等，不能被顺手清掉。
          if (this.nodeDetailSeq[id] === seq) {
            const loading = {...this.nodeDetailsLoading};
            delete loading[id];
            this.nodeDetailsLoading = loading;
          }
        }
      },
      closeDrawer() {
        this.drawerNodeId = '';
        this.drawerFallback = null;
        this.restoreFocus('drawer');
      },

      formatTime(value) {
        if (!value) return '暂无时间';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '时间未知';
        return new Intl.DateTimeFormat('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).format(date);
      },
      formatSpeed(value) {
        const speed = Number(value || 0);
        if (!speed) return '速率未知';
        if (speed >= 1e9) return `${(speed / 1e9).toFixed(speed % 1e9 ? 1 : 0)} Gbps`;
        if (speed >= 1e6) return `${(speed / 1e6).toFixed(speed % 1e6 ? 1 : 0)} Mbps`;
        return `${speed} bps`;
      },
      formatConfidence(value) {
        return `${Math.round(Number(value || 0) * 100)}%`;
      },
      directionLabel(value) {
        return value === 'bidirectional' ? '双向发现' : value === 'outbound' ? '本端发现' : '方向未知';
      },
      resolutionLabel(value) {
        return value === 'resolved' ? '已解析设备' : '未解析邻居';
      },
      nodeKindLabel(value) {
        return ({ backbone: '主要网络设备', endpoint: '下联终端', external: '未解析邻居' })[value] || '节点';
      },
      nodeStatusLabel(value) {
        return ({ normal: '正常', abnormal: '异常', disabled: '停用', stale: '陈旧', unknown: '状态未知' })[value] || '状态未知';
      },
      handleVisibility() {
        this.controller?.handleVisibilityChange();
      },
      /* 浮层按层级关：台账盖在抽屉之上，一次 Esc 只关最上面那层，
         同时关掉两层会让用户丢失刚才在看的节点。 */
      handleKeydown(event) {
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        if (this.ledgerOpen) {
          event.preventDefault?.();
          // 网段表单开着时先收表单：Esc 的本意是退一层，直接关台账会把
          // 用户填了一半的 cidr / vlan 一起丢掉。
          if (this.subnetFormOpen) {
            this.subnetFormOpen = false;
            this.subnetError = '';
            return;
          }
          this.closeLedger();
          return;
        }
        if (this.drawerNodeId) {
          event.preventDefault?.();
          this.closeDrawer();
        }
      },
    async openIpLedgerModal() {
      // 台账已经有 backdrop click，但键盘用户没有对应的关闭方式，也没人把焦点移进去。
      if (!this.ledgerOpen) this.captureFocus('ledger');
      this.ledgerOpen = true;
      this.focusOverlay('.topo-ledger__close');
      if (this.ledger.rows.length || this.ledgerLoading) return;
      await this.loadLedger();
    },
    async loadLedger() {
      this.ledgerLoading = true;
      this.ledgerError = '';
      try {
        const response = await fetch('/network/ip/?fragment=ledger', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!response.ok) throw new Error('台账读取失败（HTTP ' + response.status + '）');
        const payload = await response.json();
        this.ledger = { ...this.ledger, ...(payload.ledger || {}) };
      } catch (error) {
        this.ledgerError = error.message || '台账读取失败';
      } finally {
        this.ledgerLoading = false;
      }
    },
    /** 图上没有的资产：用同一个抽屉展示，id 用后端认的 kind:pk 形式。 */
    openAssetDrawer(row) {
      if (!row) return;
      const id = row.kindKey + ':' + row.pk;
      const node = {
        id,
        label: row.name,
        ip: row.ip || '',
        kind: row.kindKey,
        detailsUrl: '/operations/overview/node/' + encodeURIComponent(id) + '/',
      };
      this.drawerFallback = node;
      this.openDrawer(node);
    },
    /* 台账行是 {cells: {key: {text, sub, code, href, muted}}}，不是扁平的 {key: 文本}。
       模板里必须走这里取值——直接写 row[key] 拿到的是对象，插值出来是空的。 */
    cell(row, key) {
      const value = row && row.cells ? row.cells[key] : null;
      if (value && typeof value === 'object') return value;
      return { text: value == null ? '' : String(value) };
    },
    toggleSubnetForm() {
      this.subnetFormOpen = !this.subnetFormOpen;
      this.subnetError = '';
    },
    /* DRF 的 4xx 有三种常见形状：{detail: '...'}（权限、唯一约束）、
       字段级 {cidr: ['该网段与已登记网段重叠']}、以及 non_field_errors。
       原来只读 detail：字段级校验失败时界面只有「保存失败（HTTP 400）」，
       用户不知道该改哪个输入框。这里把任意形状压成一行可读文本。 */
    subnetErrorMessage(payload, status) {
      const flatten = (value) => {
        if (value == null) return '';
        if (typeof value === 'string') return value.trim();
        if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('；');
        if (typeof value === 'object') {
          return Object.entries(value).map(([key, item]) => {
            const text = flatten(item);
            if (!text) return '';
            const label = SUBNET_FIELD_LABELS[key];
            return label ? label + '：' + text : text;
          }).filter(Boolean).join('；');
        }
        return String(value);
      };
      return flatten(payload) || ('保存失败（HTTP ' + status + '）');
    },
    /** 新增网段就在这个弹窗里做，不跳页面。 */
    async submitSubnet() {
      this.subnetBusy = true;
      this.subnetError = '';
      try {
        const response = await fetch('/api/v1/ip-subnets/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': this.csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({
            cidr: this.subnetForm.cidr.trim(),
            purpose: this.subnetForm.purpose,
            vlan: this.subnetForm.vlan.trim(),
            gateway: this.subnetForm.gateway.trim(),
            pool_start: this.subnetForm.poolStart.trim(),
            pool_end: this.subnetForm.poolEnd.trim(),
            note: this.subnetForm.note.trim(),
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(function () { return {}; });
          throw new Error(this.subnetErrorMessage(payload, response.status));
        }
        this.subnetForm = { cidr: '', purpose: 'office', vlan: '', gateway: '', poolStart: '', poolEnd: '', note: '' };
        this.subnetFormOpen = false;
        // 不要先把 rows 清空：loadLedger 会用服务端返回的节整体覆盖，
        // 清空这一步是多余的；而一旦 loadLedger 失败（网络抖动、服务重启），
        // 列表就永久停在空状态，看起来像数据没了，实际上只是这次刷新没成功。
        await this.loadLedger();
      } catch (error) {
        this.subnetError = error.message || '保存失败';
      } finally {
        this.subnetBusy = false;
      }
    },
    closeLedger() {
      this.ledgerOpen = false;
      this.restoreFocus('ledger');
    },
    },
    mounted() {
      this.controller = createRefreshController({
        initialSnapshot,
        intervalMs: 30000,
        fetchSnapshot: async () => {
          const requestController = new AbortController();
          this.requestAbortController = requestController;
          const timeoutId = window.setTimeout(() => requestController.abort(), 10000);
          try {
            const response = await fetch(endpoint, {
              credentials: 'same-origin', cache: 'no-store', signal: requestController.signal,
              headers: { Accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
            const payload = await response.json();
            // 后端把局部查询失败降级成 200 + {topology: {error: 'topology_unavailable'}}
            // （operations.py 的 _safe_region 就是干这个的）。直接当成功会让界面
            // 同时显示「数据已同步」和一张空图，还顺便报「尚未采集到物理链路」，
            // 三处提示互相打脸。当成刷新失败处理：保留上一份快照并置 stale，
            // 用户才知道自己看的是旧数据，而不是以为网络里真的没有设备。
            if (payload && payload.topology && payload.topology.error) {
              throw new Error('Snapshot degraded: ' + String(payload.topology.error));
            }
            return payload;
          } finally {
            window.clearTimeout(timeoutId);
            if (this.requestAbortController === requestController) this.requestAbortController = null;
          }
        },
        isVisible: () => !document.hidden,
      });
      this.unsubscribe = this.controller.subscribe(this.syncControllerState);
      this.controller.start();
      this.$nextTick(this.measureCanvas);
      document.addEventListener('visibilitychange', this.handleVisibility);
      // Esc 关闭是最上层浮层的唯一键盘出口，挂在 document 上才不会因为焦点
      // 落在抽屉里的按钮上而失效。
      document.addEventListener('keydown', this.handleKeydown);
      window.addEventListener('resize', this.updateDimensions, { passive: true });
      this.measureCanvas();
      this.ambientEffects = createAmbientEffects(document.querySelector('[data-overview-ambient]'));
      const field = document.querySelector('[name=csrfmiddlewaretoken]');
      const meta = document.querySelector('meta[name=csrf-token]');
      const cookie = document.cookie.split('; ').find((part) => part.startsWith('csrftoken='));
      this.csrfToken = (field && field.value) || (meta && meta.content) || (cookie ? cookie.split('=')[1] : '');
      // 工具栏额外挂一层 document 委托，和模板上的 @click 并存。
      // 两套监听跑同一份幂等逻辑，按钮点一次只产生一次动作。
    },
    beforeUnmount() {
      this.requestAbortController?.abort();
      // 合帧的句柄也要收：卸载后 rAF 还会跑一次并去 measureCanvas 查 DOM。
      if (this.dimensionsFrame) window.cancelAnimationFrame(this.dimensionsFrame);
      if (this.pendingZoom && this.pendingZoom.frame) {
        window.cancelAnimationFrame(this.pendingZoom.frame);
      }
      this.controller?.stop();
      this.unsubscribe?.();
      this.ambientEffects?.destroy();
      document.removeEventListener('visibilitychange', this.handleVisibility);
      document.removeEventListener('keydown', this.handleKeydown);
      window.removeEventListener('resize', this.updateDimensions);
    },
  });
  const mounted = application.mount(mountElement);
  // mount 的返回值在不同构建里可能是组件代理、也可能是根实例，统一取两处。
  const app = mounted && typeof mounted.zoomBy === 'function'
    ? mounted
    : (application._instance && application._instance.proxy) || mounted || application;
  // 工具栏的 document 级委托。放在 mount 之后用返回的实例，不依赖 mounted 是否跑到。
  // 模板上的 @click 本身是生效的；这里多一层是因为按钮在工具栏里最常被连点，
  // 委托能保证事件落在 document 上、不受浮层遮挡影响。
  //
  // 监听必须幂等：整个脚本在 Vue 岛重挂时会再执行一遍，而 document 上的监听
  // 不会随旧实例消失。不挡住的话点一次按钮会跑两次，而且第二次用的是已经
  // 和 DOM 脱钩的旧实例。所以：只绑一次，处理器里每次现取最新实例。
  window.__topologyApp = app;
  if (!window.__topologyToolbarBound) {
    window.__topologyToolbarBound = true;
    document.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('[data-toolbar-act]');
      if (!button) return;
      const live = window.__topologyApp;
      if (!live) return;
      const handlers = {
        'zoom-in': () => live.zoomBy(0.15),
        'zoom-out': () => live.zoomBy(-0.15),
        fit: () => live.fitViewport(),
        reset: () => live.resetViewport(),
        'ip-lookup': () => live.locateByIp(),
        'ip-ledger': () => live.openIpLedgerModal(),
      };
      const handler = handlers[button.getAttribute('data-toolbar-act')];
      if (!handler) return;
      event.preventDefault();
      handler();
    });
  }
}
