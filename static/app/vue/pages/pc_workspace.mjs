/* PC 工作区：三个顶部方块 + 资产表 + 日志表 + 分析面板，一份 bootstrap 渲染整页。
   分析面板（任务栏 + 六格统计 + 问题类型长条）只有 PC 用，就写在这里，不抽公共。 */
import MetricCard from '../components/metric_card.mjs';
import WorkspaceTable from '../components/workspace_table.mjs';
import TaskBar from '../components/task_bar.mjs';

/* 会话过期时服务端跟随 302 回一个 200 的登录页：ok 为真，json() 抛 SyntaxError。
   把原始英文解析错误原样甩给用户（"Unexpected token <"）等于什么都没说，
   这类错误一律换成能照着做的提示；其余错误保留服务端给的话。 */
function readableFailure(error, fallback) {
    if (error instanceof SyntaxError) return fallback;
    return (error && error.message) || fallback;
}

const STATUS_CLASS = {
    success: 'text-bg-success',
    failed: 'text-bg-danger',
    partial: 'text-bg-warning',
};

export default {
    delimiters: ['[[', ']]'],
    components: {MetricCard, WorkspaceTable, TaskBar},
    props: {
        page: {type: Object, default: () => ({})},
        blocks: {type: Array, default: () => []},
        table: {type: Object, default: () => ({})},
        assets: {type: Object, default: () => ({})},
        logs: {type: Object, default: () => ({})},
        analyses: {type: Object, default: () => ({})},
        urls: {type: Object, default: () => ({})},
        csrf: {type: String, default: ''},
    },
    data() {
        // 切方块只改这里，不写地址栏：三块内容首屏一起渲染，切换不重新请求。
        return {
            activeTab: this.page.view || 'assets', tasks: null, tasksBusy: false, statsView: null,
            // 任务栏翻页、点任务两条路都会打网络，失败要有地方落，不能静默。
            taskError: '',
            // 连点两条任务时只认最后一次：序号一变，先发的旧响应就被丢掉。
            statsTicket: 0,
            statsBusy: false,
            // 没点过的 tab 不挂载：它的筛选栏和表格不进 DOM，也不占首屏渲染。
            visited: {assets: true},
            // 切到 logs / analyses 才去取那一块，首屏只查台账。
            localLogs: null, localAnalyses: null, paneBusy: {},
        };
    },
    computed: {
        /** 懒加载回来的那份，没取到之前是空对象。 */
        logsView() {
            return this.localLogs || this.logs || {};
        },
        analysesView() {
            return this.localAnalyses || this.analyses || {};
        },
        /** 翻页后本地覆盖首屏的那份任务块，地址栏不动。 */
        taskData() {
            return this.tasks || this.analysesView.tasks || {};
        },
        /** 切任务后本地覆盖的那份统计；没切过就用已加载的。 */
        view() {
            return this.statsView || this.analysesView;
        },
        stats() {
            return this.view.stats || {total: 0, levels: {}, execution_failed: 0, categories: []};
        },
        statCells() {
            const levels = this.stats.levels || {};
            return [
                {label: '分析总数', value: this.stats.total || 0, tone: ''},
                {label: '正常', value: levels.normal || 0, tone: 'success'},
                {label: '提示', value: levels.info || 0, tone: 'info'},
                {label: '警告', value: levels.warning || 0, tone: 'warning'},
                {label: '严重', value: levels.critical || 0, tone: 'danger'},
                {label: '执行失败目标', value: this.stats.execution_failed || 0, tone: 'danger'},
            ];
        },
        /** 选中的不是最新那条任务时，这块统计说的就是那条任务，标题要跟着改。 */
        statsTitle() {
            const rows = (this.taskData && this.taskData.rows) || [];
            const latestId = rows.length ? String(rows[0].id) : '';
            const selected = String((this.taskData && this.taskData.selected_id) || '');
            return selected && latestId && selected !== latestId ? '当前选择任务统计' : '最新任务统计';
        },
        statsEyebrow() {
            return this.statsTitle === '最新任务统计' ? '最新结果' : '历史结果';
        },
    },
    mounted() {
        // 方块各取各的：只有点上去（或 ?object= 深链落上去）才请求那一块，
        // 首屏不替用户预拉他没看的方块。
        if (this.activeTab !== 'assets') this.selectTab(this.activeTab);
        // 日志详情的地址是 /computers/logs/<pk>/，与资产详情的 detail.json 通道不同，
        // 交给共享详情弹窗打开（资源没有 uuid 的话组件的通道不适用）。
        document.addEventListener('click', this.openLogDetail, true);
    },
    beforeUnmount() {
        document.removeEventListener('click', this.openLogDetail, true);
    },
    methods: {
        /** 切方块：先切视图，再按需取那一块的数据，地址栏不动。 */
        async selectTab(key) {
            this.activeTab = key;
            this.visited[key] = true;
            if (key === 'assets' || this.paneBusy[key]) return;
            // 首屏已经带下来的（深链进入）直接用，不再拉一遍。
            if (key === 'logs' && (this.localLogs || (this.logs && this.logs.endpoint))) return;
            if (key === 'analyses' && (this.localAnalyses || (this.analyses && this.analyses.stats))) return;
            await this.loadPane(key);
        },
        /** 只取那一块的数据，不动当前页签。 */
        async loadPane(key) {
            if (this.paneBusy[key]) return;
            this.paneBusy[key] = true;
            try {
                const response = await fetch(`${location.pathname}?pane=${key}`, {
                    headers: {'X-Requested-With': 'fetch'},
                });
                if (!response.ok) return;
                const data = await response.json();
                if (key === 'logs') this.localLogs = data.logs || {};
                if (key === 'analyses') this.localAnalyses = data.analyses || {};
            } catch (error) {
                console.error('取方块数据失败：', key, error);
            } finally {
                this.paneBusy[key] = false;
            }
        },
        statusClass(status) {
            return STATUS_CLASS[status] || 'text-bg-secondary';
        },
        problemUrl(category) {
            const base = this.view.problemUrl;
            return base ? base + '?category=' + encodeURIComponent(category.label) : '';
        },
        async selectTask(row) {
            const endpoint = this.analysesView.statsUrl;
            if (!row || !row.id || !endpoint) return;
            const ticket = ++this.statsTicket;
            this.statsBusy = true;
            this.taskError = '';
            try {
                const response = await fetch(endpoint + '?task=' + encodeURIComponent(row.id), {
                    headers: {'X-Requested-With': 'XMLHttpRequest'},
                });
                if (ticket !== this.statsTicket) return;
                /* !ok 以前是直接 return，用户点了任务什么都没变也没提示。
                   会话过期时服务端还会跟随 302 给出 200 的登录页 HTML，ok 为真、
                   json() 抛错，那条 rejection 没人接——两种都收进同一句提示。 */
                if (!response.ok) throw new Error('任务统计加载失败，请刷新页面后重试。');
                const payload = await response.json();
                if (ticket !== this.statsTicket) return;
                this.statsView = payload;
                this.tasks = {...(this.tasks || this.analysesView.tasks || {}), selected_id: row.id};
            } catch (error) {
                if (ticket !== this.statsTicket) return;
                this.taskError = readableFailure(error, '任务统计加载失败，请刷新页面后重试。');
            } finally {
                if (ticket === this.statsTicket) this.statsBusy = false;
            }
        },
        async goTaskPage(page) {
            const endpoint = (this.analysesView.tasks || {}).endpoint;
            if (!endpoint || this.tasksBusy) return;
            this.tasksBusy = true;
            this.taskError = '';
            try {
                const response = await fetch(endpoint + '?task_page=' + encodeURIComponent(page), {
                    headers: {'X-Requested-With': 'XMLHttpRequest'},
                });
                // 同上：登录失效时 ok 为真但拿到的是 HTML，json() 会抛，必须接住。
                if (!response.ok) throw new Error('任务列表加载失败，请刷新页面后重试。');
                this.tasks = await response.json();
            } catch (error) {
                this.taskError = readableFailure(error, '任务列表加载失败，请刷新页面后重试。');
            } finally {
                this.tasksBusy = false;
            }
        },
        openLogDetail(event) {
            const link = event.target.closest ? event.target.closest('a[href]') : null;
            const prefix = this.urls.logDetail || '';
            if (!link || !prefix || !link.getAttribute('href').startsWith(prefix)) return;
            // 问题明细弹窗里的「日志原文」自己就地展开，别在这里抢走。
            if (link.hasAttribute('data-problem-detail') || link.closest('#analysisProblemsModal')) return;
            event.preventDefault();
            event.stopPropagation();
            this.showDetail(link.getAttribute('href'));
        },
        /** 借全站共用的详情弹窗：临时插一个可见触发点让它接住，点完就撤。 */
        showDetail(url) {
            if (!url) return;
            const trigger = document.createElement('span');
            trigger.setAttribute('data-detail-modal', url);
            document.body.appendChild(trigger);
            trigger.click();
            trigger.remove();
        },
    },
    template: `
    <div>
        <div class="row g-3 mb-3" role="tablist" aria-label="PC 视图">
            <div class="col-12 col-md-4" v-for="block in blocks" :key="block.key">
                <metric-card v-bind="block" :selected="activeTab === block.key"
                             @select="selectTab(block.key)"></metric-card>
            </div>
        </div>

        <div v-if="visited.assets" v-show="activeTab === 'assets'" role="tabpanel" aria-label="PC 资产">
            <workspace-table v-if="assets.endpoint" v-bind="assets"></workspace-table>
        </div>

        <div v-if="visited.logs" v-show="activeTab === 'logs'" role="tabpanel" aria-label="日志">
            <workspace-table v-if="logsView.endpoint" v-bind="logsView" url-prefix="logs"></workspace-table>
        </div>

        <div v-if="visited.analyses" v-show="activeTab === 'analyses'" role="tabpanel" aria-label="分析记录">
            <div class="mb-4">
                <task-bar v-bind="taskData" :busy="tasksBusy" :selected-id="taskData.selected_id || ''"
                          @select="selectTask" @page="goTaskPage"></task-bar>
                <p v-if="taskError" class="alert alert-danger py-2 mt-3 mb-0" role="alert">[[ taskError ]]</p>
            </div>

            <section aria-labelledby="latest-analysis-title" :aria-busy="statsBusy ? 'true' : 'false'">
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
                    <div><p class="page-heading__eyebrow mb-1">[[ statsEyebrow ]]</p><h2 class="h5 mb-0" id="latest-analysis-title">[[ statsTitle ]]</h2></div>
                    <div v-if="view.task && view.task.id" class="d-flex flex-wrap align-items-center gap-3">
                        <span class="small text-secondary">[[ view.task.created_at ]]</span>
                        <span class="badge status-badge" :class="statusClass(view.task.status)">[[ view.task.status_label ]]</span>
                    </div>
                </div>


                <div class="card surface-card"><div class="card-body">
                    <div class="row g-3 mb-3" data-analysis-summary>
                        <div v-for="cell in statCells" :key="cell.label" class="col-6 col-xl-2">
                            <div class="card surface-card h-100"><div class="card-body">
                                <div class="metric-label">[[ cell.label ]]</div>
                                <div class="h3 mb-0" :class="cell.tone ? 'text-' + cell.tone : ''">[[ cell.value ]]</div>
                            </div></div>
                        </div>
                    </div>
                    <h3 class="h6">问题类型分布</h3>
                    <p class="small text-secondary">等级按已生成分析记录的最高问题等级统计。执行失败目标单独计数，不与等级数量相加。类型数量为受影响记录数，同一记录可包含多种类型，占比合计可能超过 100%。人员匹配产生的“未匹配日志”占位行不计入分析总数。</p>
                    <div v-if="stats.total" class="row g-3">
                        <div class="col-12 col-md-6" v-for="category in stats.categories" :key="category.label">
                            <button type="button" class="btn btn-link text-start text-decoration-none w-100 p-0 d-flex justify-content-between gap-2 mb-1"
                                    data-bs-toggle="modal" data-bs-target="#analysisProblemsModal"
                                    :data-problem-label="category.label" :data-problem-url="problemUrl(category)"
                                    :aria-label="'查看' + category.label + '问题明细'">
                                <span>[[ category.label ]]</span>
                                <span>[[ category.count ]] 条 · [[ category.percentage.toFixed(1) ]]% <span aria-hidden="true">›</span></span>
                            </button>
                            <div class="progress" role="progressbar" :aria-label="category.label + '受影响记录占比'"
                                 :aria-valuenow="category.percentage" aria-valuemin="0" aria-valuemax="100">
                                <div class="progress-bar" :style="{width: category.percentage + '%'}"></div>
                            </div>
                        </div>
                    </div>
                    <p v-else class="text-secondary mb-0">最新任务尚无分析结果。可进入任务详情查看待处理、运行中或执行失败的目标。</p>
                </div></div>
            </section>
        </div>

    </div>`,
};
