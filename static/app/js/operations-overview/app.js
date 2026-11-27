import { createApp } from '../../../vendor/vue/vue.esm-browser.prod.js';
import { createRefreshController } from './state.js';
import {
  normalizeTopology, visibleTopology, reconcileExpandedIds, layoutTopology, parentToExpand,
} from './topology.js';
import { createAmbientEffects } from './effects.js';

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
        lookupOpen: false,
        lookupQuery: '',
        lookupRows: [],
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
        nodeDetailsBusy: false,
        liveStatus: '网络拓扑已就绪',
        controller: null,
        unsubscribe: null,
        ambientEffects: null,
        requestAbortController: null,
        panStart: null,
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
      truncationCount() {
        return Object.values(this.snapshot.topology?.asset_truncation || {})
          .reduce((total, value) => total + Number(value || 0), 0);
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
        const cached = this.nodeDetails[node && node.id];
        const details = cached || (node && node.details) || [];
        if (this.nodeDetailsBusy) return [{ label: '加载中', value: '正在读取该节点详情…' }];
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
        this.controller?.setManualPaused(!this.manualPaused);
        this.liveStatus = this.manualPaused ? '自动刷新已暂停' : '自动刷新已恢复';
      },
      async refreshNow() {
        await this.controller?.refresh();
        this.liveStatus = this.stale ? this.error : '数据刷新成功';
      },
      syncControllerState(next) {
        const previousGeneratedAt = this.snapshot?.generated_at;
        this.snapshot = next.lastSnapshot;
        this.expandedNodeIds = reconcileExpandedIds(
          this.expandedNodeIds,
          normalizeTopology(this.snapshot.topology || {}),
        );
        this.refreshing = next.refreshing;
        this.stale = next.stale;
        this.error = next.error;
        this.manualPaused = next.manualPaused;
        this.hidden = next.hidden;
        this.filter = next.filter;
        this.viewport = { ...next.viewport };
        if (previousGeneratedAt !== this.snapshot?.generated_at && !next.refreshing) {
          this.liveStatus = '网络拓扑数据已更新';
        }
      },
      updateDimensions() {
        const shell = mountElement.querySelector('.topology-canvas-shell');
        const width = shell?.clientWidth || window.innerWidth;
        this.topologyWidth = Math.max(320, Math.min(1400, width));
        this.topologyHeight = window.innerWidth < 768 ? 1100 : 720;
      },
      /* 按 IP 定位：命中就把视口平移过去并高亮，没命中只提示，不动视口。 */
      async locateByIp() {
        // v-model 在这页没同步，直接以输入框的当前值为准。
        const field = document.getElementById('topology-ip-search');
        const query = String((field && field.value) || this.ipQuery || '').trim().toLowerCase();
        if (!query) return;
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
        const scale = this.viewport?.scale || 1;
        this.viewport = {
          scale,
          x: Number((this.topologyWidth / 2 - hit.x * scale).toFixed(1)),
          y: Number((this.topologyHeight / 2 - hit.y * scale).toFixed(1)),
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
      /* 命中节点的可读摘要：位置、类型、状态，以及它连出去的物理口和 VLAN。 */
      zoomBy(delta) {
        const scale = Math.min(2.2, Math.max(0.6, this.viewport.scale + delta));
        this.viewport = { ...this.viewport, scale: Number(scale.toFixed(2)) };
        this.controller?.updateUiState({ viewport: this.viewport });
      },
      /* 滚轮缩放：以鼠标所指的点为不动点。
         变换是 translate(x y) scale(s)，屏幕点 p 对应的内容点是 (p - t) / s；
         缩放后要让同一个内容点还落在 p 上，所以 t' = p - (p - t) * (s'/s)。 */
      wheelZoom(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const scale = Math.min(2.2, Math.max(0.6, this.viewport.scale * factor));
        if (scale === this.viewport.scale) return;
        const ratio = scale / this.viewport.scale;
        // 鼠标位置换算到 SVG 用户坐标，再换回屏幕像素，避免 viewBox 与 CSS 尺寸不等。
        const pointX = ((event.clientX - rect.left) / rect.width) * canvas.viewBox.baseVal.width;
        const pointY = ((event.clientY - rect.top) / rect.height) * canvas.viewBox.baseVal.height;
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
         节点上的 openDrawer 永远收不到事件，表现就是"点详情没反应"。 */
      startPan(event) {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        this.panMoved = false;
        this.panStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          originX: this.viewport.x, originY: this.viewport.y };
        // 指针移出画布也要继续跟着走，所以挂在 window 上而不是 svg 上。
        const move = (evt) => this.movePan(evt);
        const up = (evt) => {
          this.endPan(evt);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
      movePan(event) {
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
        if (!this.panStart || this.panStart.pointerId !== event.pointerId) return;
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
          return `M ${source.x} ${source.y + this.nodeBottom(source)} V ${dip} H ${target.x} V ${target.y + this.nodeBottom(target)}`;
        }
        const upper = source.y < target.y ? source : target;
        const lower = source.y < target.y ? target : source;
        const from = upper.y + this.nodeBottom(upper);
        const to = lower.y + this.nodeTop(lower);
        const mid = from + Math.max(14, (to - from) / 2);
        return `M ${upper.x} ${from} V ${mid} H ${lower.x} V ${to}`;
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
        const mid = from + Math.max(14, (to - from) / 2);
        return { x: (source.x + target.x) / 2, y: mid };
      },
      /* 端口：本地口 → 对端口；任一侧缺失就退化成已有的那一个。 */
      edgePortLabel(edge) {
        const local = String(edge.localInterfaceLabel || '').trim();
        const remote = String(edge.remoteInterfaceLabel || '').trim();
        if (local && remote) return local + ' → ' + remote;
        return local || remote || '';
      },
      edgeVlanLabel(edge) {
        const ids = Array.isArray(edge.vlanIds) ? edge.vlanIds : [];
        return ids.length ? 'VLAN ' + ids.join(',') : '';
      },
      /* 只给选中和悬停的边显示标签：221 条链路全铺文字会糊成一片。 */
      edgeLabelVisible(edge) {
        return edge.id === this.selectedEdgeId || edge.id === this.hoveredEdgeId;
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
      openDrawer(node) {
        this.drawerNodeId = node.id;
        this.liveStatus = `已打开 ${node.label} 的详情`;
        this.loadNodeDetails(node);
      },
      /** 抽屉里的详情按节点 id 单独取，取过一次就缓存，来回点不再发请求。 */
      async loadNodeDetails(node) {
        const id = node && node.id;
        if (!id || this.nodeDetails[id] || !node.detailsUrl) return;
        this.nodeDetailsBusy = true;
        try {
          const response = await fetch(node.detailsUrl, {headers: {'X-Requested-With': 'XMLHttpRequest'}});
          if (!response.ok) return;
          const data = await response.json();
          this.nodeDetails = {...this.nodeDetails, [id]: data.details || []};
        } catch (error) {
          console.error('取节点详情失败：', error);
        } finally {
          this.nodeDetailsBusy = false;
        }
      },
      closeDrawer() {
        this.drawerNodeId = '';
        this.drawerFallback = null;
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
    async openIpLedgerModal() {
      this.lookupOpen = false;
      this.ledgerOpen = true;
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
    closeLookup() {
      this.lookupOpen = false;
      this.lookupRows = [];
      this.lookupQuery = '';
    },
    toggleSubnetForm() {
      this.subnetFormOpen = !this.subnetFormOpen;
      this.subnetError = '';
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
          const detail = await response.json().catch(function () { return {}; });
          throw new Error(detail.detail || ('保存失败（HTTP ' + response.status + '）'));
        }
        this.subnetForm = { cidr: '', purpose: 'office', vlan: '', gateway: '', poolStart: '', poolEnd: '', note: '' };
        this.subnetFormOpen = false;
        this.ledger = { ...this.ledger, rows: [] };
        await this.loadLedger();
      } catch (error) {
        this.subnetError = error.message || '保存失败';
      } finally {
        this.subnetBusy = false;
      }
    },
    closeLedger() {
      this.ledgerOpen = false;
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
            return response.json();
          } finally {
            window.clearTimeout(timeoutId);
            if (this.requestAbortController === requestController) this.requestAbortController = null;
          }
        },
        isVisible: () => !document.hidden,
      });
      this.unsubscribe = this.controller.subscribe(this.syncControllerState);
      this.controller.start();
      this.$nextTick(this.updateDimensions);
      document.addEventListener('visibilitychange', this.handleVisibility);
      window.addEventListener('resize', this.updateDimensions, { passive: true });
      this.updateDimensions();
      this.ambientEffects = createAmbientEffects(document.querySelector('[data-overview-ambient]'));
      const field = document.querySelector('[name=csrfmiddlewaretoken]');
      const meta = document.querySelector('meta[name=csrf-token]');
      const cookie = document.cookie.split('; ').find((part) => part.startsWith('csrftoken='));
      this.csrfToken = (field && field.value) || (meta && meta.content) || (cookie ? cookie.split('=')[1] : '');
      // 这页的模板事件在本环境下没有生效，工具栏按钮改用原生监听兜底；
      // Vue 那层若恢复，两套监听都在，动作是同一份幂等逻辑。
    },
    beforeUnmount() {
      this.requestAbortController?.abort();
      this.controller?.stop();
      this.unsubscribe?.();
      this.ambientEffects?.destroy();
      document.removeEventListener('visibilitychange', this.handleVisibility);
      window.removeEventListener('resize', this.updateDimensions);
    },
  });
  const mounted = application.mount(mountElement);
  // mount 的返回值在不同构建里可能是组件代理、也可能是根实例，统一取两处。
  const app = mounted && typeof mounted.zoomBy === 'function'
    ? mounted
    : (application._instance && application._instance.proxy) || mounted || application;
  window.__topologyApp = app;

  // 这页的模板事件在本环境没绑上，工具栏改用 document 级委托。
  // 放在 mount 之后用返回的实例，不依赖 mounted 是否跑到。
  const toolbarHandlers = {
    'zoom-in': () => app.zoomBy(0.15),
    'zoom-out': () => app.zoomBy(-0.15),
    fit: () => app.fitViewport(),
    reset: () => app.resetViewport(),
    'ip-lookup': () => app.locateByIp(),
    'ip-ledger': () => app.openIpLedgerModal(),
  };
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-toolbar-act]');
    if (!button) return;
    const handler = toolbarHandlers[button.getAttribute('data-toolbar-act')];
    if (!handler) return;
    event.preventDefault();
    handler();
  });
}
