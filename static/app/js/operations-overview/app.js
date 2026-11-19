import { createApp } from '../../../vendor/vue/vue.esm-browser.prod.js';
import { createRefreshController } from './state.js';
import {
  normalizeTopology, visibleTopology, reconcileExpandedIds, layoutTopology,
} from './topology.js';
import { createAmbientEffects } from './effects.js';

const mountElement = document.querySelector('#operations-overview-app');
const bootstrapElement = document.querySelector('#operations-overview-bootstrap');

if (mountElement && bootstrapElement) {
  const initialSnapshot = JSON.parse(bootstrapElement.textContent);
  const endpoint = mountElement.dataset.snapshotUrl;

  createApp({
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
        liveStatus: '网络拓扑已就绪',
        controller: null,
        unsubscribe: null,
        ambientEffects: null,
        requestAbortController: null,
        panStart: null,
      panMoved: false,
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
        return this.topology.nodes.find((node) => node.id === this.drawerNodeId) || null;
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
        const details = (this.drawerNode && this.drawerNode.details) || [];
        return details.length ? details : [{ label: 'IP / 备注', value: this.drawerNode?.ip || '未配置' }];
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
        this.viewport = {
          ...this.viewport,
          x: this.panStart.originX + dx,
          y: this.panStart.originY + dy,
        };
      },
      endPan(event) {
        if (!this.panStart || this.panStart.pointerId !== event.pointerId) return;
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
      },
      closeDrawer() {
        this.drawerNodeId = '';
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
    },
    beforeUnmount() {
      this.requestAbortController?.abort();
      this.controller?.stop();
      this.unsubscribe?.();
      this.ambientEffects?.destroy();
      document.removeEventListener('visibilitychange', this.handleVisibility);
      window.removeEventListener('resize', this.updateDimensions);
    },
  }).mount(mountElement);
}
