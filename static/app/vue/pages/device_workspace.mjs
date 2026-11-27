/* 设备工作区：网络设备 / 服务器 / 弱电设备共用一个组件。
   台账、巡检记录两页签通用；弱电多一个门禁记录，靠 access 是否为空决定。
   切页签只改 activeTab，不碰地址栏。 */
import MetricCard from '../components/metric_card.mjs';
import TaskBar from '../components/task_bar.mjs';
import WorkspaceTable from '../components/workspace_table.mjs';

export default {
    delimiters: ['[[', ']]'],
    components: {MetricCard, WorkspaceTable, TaskBar},
    props: {
        page: {type: Object, default: () => ({})},
        blocks: {type: Array, default: () => []},
        table: {type: Object, default: () => ({})},
        logs: {type: Object, default: () => ({})},
        access: {type: Object, default: () => ({})},
        urls: {type: Object, default: () => ({})},
        csrf: {type: String, default: ''},
        maintenance: {type: Boolean, default: false},
        taskbar: {type: Object, default: () => ({})},
    },
    mounted() {
        // 方块各取各的：只有点上去（或 ?object= 深链落上去）才请求那一块，
        // 首屏不替用户预拉他没看的方块。
        if (this.activeTab !== 'assets') this.selectTab(this.activeTab);
    },
    computed: {
        logsView() {
            return this.localLogs || this.logs || {};
        },
        accessView() {
            return this.localAccess || this.access || {};
        },
        /** 任务统计跟着选中任务走；切了任务就换成那条的。 */
        taskStats() {
            const raw = this.localTaskStats || (this.taskbar && this.taskbar.stats) || {};
            // 把五格数字摊成长条；口径和格子一致，只是换了种看法。
            // 后端给的就是 PC 那份 categories 结构，直接用。
            return {...raw, distribution: raw.categories || []};
        },
    },
    methods: {
        /** 点长条打开问题明细：先填内容再弹窗，和 PC 一样不离开页面。 */
        async openProblems(label) {
            const base = this.taskStats.problemUrl || '';
            if (!base) return;
            const modal = document.getElementById('deviceProblemsModal');
            const body = modal && modal.querySelector('[data-problem-body]');
            const title = document.getElementById('deviceProblemsTitle');
            if (title) title.textContent = label + '问题明细';
            // 明细区里现在这一份可能是上次插进来的岛（mount() 会写 __vue_app__）。
            // 写占位文本、换整段 HTML 都等于把宿主丢掉，所以先收掉旧实例：
            // 不收的话旧组件的 document 级监听器一直留着，开几次明细就攒几套。
            const boot = await import('/static/app/vue/boot.mjs');
            if (body) {
                boot.unmountPages(body);
                body.textContent = '正在加载问题明细…';
            }
            const instance = window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(modal) : null;
            if (instance) instance.show();
            try {
                const response = await fetch(base + '?category=' + encodeURIComponent(label), {
                    credentials: 'same-origin',
                    headers: {'X-Requested-With': 'XMLHttpRequest'},
                });
                if (!response.ok) throw new Error('加载失败，请关闭弹窗后重试。');
                const html = await response.text();
                if (!body) return;
                // 上面已经收过旧岛，这里直接换内容，不会再漏实例。
                body.innerHTML = html;
                // 明细返回的是一个 Vue 岛，动态插进来的节点要自己挂一次。
                await boot.mountPages(body);
            } catch (error) {
                if (body) {
                    boot.unmountPages(body);
                    body.textContent = error.message || '加载失败，请稍后重试。';
                }
            }
        },
        /** 切任务时顺带把统计换掉。 */
        selectTaskStats() {
            this.localTaskStats = (this.localTaskbar && this.localTaskbar.stats) || null;
        },
        /** 切方块：先切视图，再按需取那一块的数据，地址栏不动。 */
        async selectTab(key) {
            this.activeTab = key;
            this.visited[key] = true;
            if (key === 'assets' || this.paneBusy[key]) return;
            // 首屏已经带下来的（深链进入）直接用，不再拉一遍。
            if (key === 'logs' && (this.localLogs || (this.logs && this.logs.endpoint))) return;
            if (key === 'access' && (this.localAccess || (this.access && this.access.endpoint))) return;
            await this.loadPane(key);
        },
        /** 任务栏里点一条：把台账换成那个任务的设备，不换页、不改地址栏。 */
        async selectTask(row) {
            const id = (row && row.id) || '';
            this.taskId = this.taskId === id ? '' : id;
            this.tableBusy = true;
            try {
                // 任务栏在巡检记录视图里，点任务换的就是这张记录表。
                const url = new URL(location.pathname, location.origin);
                url.searchParams.set('pane', 'logs');
                if (this.taskId) url.searchParams.set('task', this.taskId);
                const response = await fetch(url, {headers: {'X-Requested-With': 'XMLHttpRequest'}});
                if (!response.ok) return;
                const data = await response.json();
                this.localLogs = data.logs || {};
                // 统计跟着选中的任务走；取消选择就回到最新一条。
                const bar = data.taskbar || {};
                this.localTaskbar = bar;
                this.localTaskStats = bar.stats || null;
            } catch (error) {
                console.error('按任务取台账失败：', error);
            } finally {
                this.tableBusy = false;
            }
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
                if (key === 'access') this.localAccess = data.access || {};
            } catch (error) {
                console.error('取方块数据失败：', key, error);
            } finally {
                this.paneBusy[key] = false;
            }
        },
    },
    data() {
        // 方块 key 就是页签名：assets / logs / access。
        // ?object=records|access 深链直接落在对应页签，不再回落到台账。
        const requested = this.page.view;
        const valid = ['assets', 'logs', 'access'];
        const tab = valid.includes(requested) ? requested : 'assets';
        return {
            activeTab: tab,
            // 没点过的页签不挂载，筛选栏和表格都不进 DOM。
            visited: {[tab]: true},
            // 切过去才取那一块，首屏只查台账。
            localLogs: null,
            localTaskbar: null,
            localTaskStats: null, localAccess: null, paneBusy: {},
            // 点了任务就把台账换成那个任务的设备，只换表格不动地址栏。
            taskId: (this.taskbar || {}).selected_id || '',
            tableRows: null, tableBusy: false,
        };
    },
    template: `
    <div>
        <div class="row g-3 mb-3" role="tablist" :aria-label="(page.title || '设备') + '视图'">
            <div v-for="block in blocks" :key="block.key" class="col-12 col-md-4">
                <metric-card v-bind="block" :selected="activeTab === block.key"
                             @select="selectTab(block.key)"></metric-card>
            </div>
        </div>
        <div v-if="visited.assets" v-show="activeTab === 'assets'">
            <workspace-table v-bind="table">
                <template #actions>
                    <button v-if="maintenance" class="btn btn-outline-warning text-nowrap d-inline-flex align-items-center justify-content-center"
                            style="flex:0 0 auto;width:auto"
                            type="button" data-maintenance-open disabled>加入维护窗口</button>
                </template>
            </workspace-table>
        </div>
        <div v-if="visited.logs" v-show="activeTab === 'logs'">
            <div v-if="taskbar && taskbar.rows && taskbar.rows.length" class="mb-3">
                <task-bar v-bind="taskbar" :selected-id="taskId" @select="selectTask"></task-bar>
            </div>
            <!-- 任务栏下面这排统计跟 PC 的分析面板对齐：口径是选中那条任务，
                 没选就是最新一条。 -->
            <section v-if="taskStats && taskStats.cells && taskStats.cells.length"
                     class="card surface-card mb-3" aria-labelledby="device-task-stats-title">
                <div class="card-body">
                    <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
                        <div>
                            <p class="page-heading__eyebrow mb-1">[[ taskStats.label === '最新任务统计' ? '最新结果' : '历史结果' ]]</p>
                            <h2 class="h5 mb-0" id="device-task-stats-title">[[ taskStats.label ]]</h2>
                        </div>
                        <div class="d-flex flex-wrap align-items-center gap-3">
                            <span class="small text-secondary">[[ taskStats.created_at ]]</span>
                            <span v-if="taskStats.status_label" class="badge status-badge">[[ taskStats.status_label ]]</span>
                        </div>
                    </div>
                    <div class="row g-3 mb-3" data-task-summary>
                        <div v-for="cell in taskStats.cells" :key="cell.label" class="col-6 col-xl-2">
                            <div class="card surface-card h-100"><div class="card-body">
                                <div class="metric-label">[[ cell.label ]]</div>
                                <div class="h3 mb-0" :class="cell.tone ? 'text-' + cell.tone : ''">[[ cell.value ]]</div>
                            </div></div>
                        </div>
                    </div>
                    <!-- 问题类型分布：和 PC 那套同一个结构、同一段说明。 -->
                    <h3 class="h6">问题类型分布</h3>
                    <p class="small text-secondary">
                        等级按已生成巡检记录的最高问题等级统计。执行失败目标单独计数，不与等级数量相加。类型数量为受影响记录数，同一记录可包含多种类型，占比合计可能超过 100%。
                    </p>
                    <div v-if="taskStats.total" class="row g-3" data-task-distribution>
                        <div v-for="item in taskStats.distribution" :key="item.label" class="col-12 col-md-6">
                            <button type="button"
                                    class="btn btn-link text-start text-decoration-none w-100 p-0 d-flex justify-content-between gap-2 mb-1"
                                    @click="openProblems(item.label)">
                                <span>[[ item.label ]]</span>
                                <span class="small text-secondary">[[ item.count ]] 个 · [[ item.percentage ]]% ›</span>
                            </button>
                            <div class="progress" role="progressbar" :aria-label="item.label + '占比'"
                                 :aria-valuenow="item.percentage" aria-valuemin="0" aria-valuemax="100">
                                <div class="progress-bar" :style="{width: item.percentage + '%'}"></div>
                            </div>
                        </div>
                    </div>
                    <p v-else class="text-secondary mb-0">最新任务尚无结果。可进入任务详情查看待处理、运行中或执行失败的目标。</p>
                </div>
            </section>
        </div>
        <!-- 问题明细弹窗：和 PC 页同一套结构，只是换了个 id 避免和页面上的冲突。 -->
        <div class="modal fade analysis-problems-modal" id="deviceProblemsModal" tabindex="-1"
             aria-labelledby="deviceProblemsTitle" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable modal-shell">
                <div class="modal-content modal-surface">
                    <div class="modal-header">
                        <h2 class="modal-title fs-5" id="deviceProblemsTitle">问题明细</h2>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
                    </div>
                    <div class="modal-body modal-body--scroll analysis-problems-modal__body modal-section"
                         data-problem-body aria-live="polite">
                        <div class="empty-state">
                            <strong>选择问题类型查看明细</strong>
                            <span>明细将在当前窗口中加载，不会离开巡检页面。</span>
                        </div>
                    </div>
                    <div class="modal-footer modal-footer--sticky">
                        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>
                    </div>
                </div>
            </div>
        </div>
        <div v-if="visited.access" v-show="activeTab === 'access'">
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
                <p class="small text-secondary mb-0">从已配置的门禁管理平台采集并统一检索门禁通行事件。</p>
                <div v-if="accessView.canAdminister" class="page-heading__actions">
                    <button class="btn btn-outline-primary" type="button"
                            data-bs-toggle="modal" data-bs-target="#accessSourceModal">平台配置</button>
                    <button class="btn btn-outline-primary" type="button"
                            data-bs-toggle="modal" data-bs-target="#accessReportModal">报表配置</button>
                </div>
            </div>
            <form v-if="accessView.canAdminister" method="post" :action="accessView.syncUrl"
                  class="card surface-card access-sync-card mb-3">
                <input type="hidden" name="csrfmiddlewaretoken" :value="accessView.csrf || ''">
                <div class="card-body access-sync-card__body">
                    <div class="access-sync-card__controls">
                        <select id="access-source-id" class="form-select" name="source_ids"
                                aria-label="选择采集平台" required :disabled="!(accessView.accessSources || []).length">
                            <option value="">请选择已启用平台</option>
                            <option v-for="source in (accessView.accessSources || [])" :key="source.id"
                                    :value="source.id">[[ source.label ]]</option>
                        </select>
                        <button class="btn btn-primary text-nowrap" type="submit"
                                :disabled="!(accessView.accessSources || []).length">采集记录</button>
                    </div>
                    <p v-if="!(accessView.accessSources || []).length" class="access-sync-card__empty mb-0">
                        暂无已启用平台，请先通过右上角“平台配置”完成连接创建或启用配置。
                    </p>
                </div>
            </form>
            <workspace-table v-if="accessView.endpoint" v-bind="accessView" url-prefix="access"></workspace-table>
        </div>
    </div>`,
};
