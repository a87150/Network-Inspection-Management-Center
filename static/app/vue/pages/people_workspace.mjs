/* 人员部门页：人员、部门两个方块就是两个视图。
   点方块切视图，只改 activeTab；?object=departments 直接落在部门视图。
   人员同步入口是页头那条 Django include 的导入弹窗，部门视图里给同一弹窗一个就近按钮。 */
import MetricCard from '../components/metric_card.mjs';
import WorkspaceTable from '../components/workspace_table.mjs';

export default {
    delimiters: ['[[', ']]'],
    components: {MetricCard, WorkspaceTable},
    props: {
        page: {type: Object, default: () => ({})},
        blocks: {type: Array, default: () => []},
        table: {type: Object, default: () => ({})},
        urls: {type: Object, default: () => ({})},
        csrf: {type: String, default: ''},
        departments: {type: Array, default: () => []},
        sync_label: {type: String, default: ''},
    },
    data() {
        // 方块 key 就是视图名：people / departments。
        const tab = this.page.view === 'departments' ? 'departments' : 'people';
        return {
            activeTab: tab,
            // 没点过的页签不挂载。
            visited: {[tab]: true},
        };
    },
    computed: {
        activeRate() {
            const totals = (this.departments || []).reduce((acc, row) => {
                acc.total += Number(row.total) || 0;
                acc.active += Number(row.active) || 0;
                return acc;
            }, {total: 0, active: 0});
            return totals.total ? (totals.active * 100 / totals.total).toFixed(1) : '0.0';
        },
    },
    methods: {
        /** 点方块切视图：只改当前页签，两个视图的数据首屏都带了，发不出请求。 */
        selectTab(key) {
            this.activeTab = key;
            this.visited[key] = true;
        },
        /* bootstrap 里的方块用 snake_case，metric_card 的 props 是 camelCase，
           只在这一处转，模板里不再写映射。 */
        cardProps(block) {
            return {
                title: block.title,
                badge: block.badge,
                metric: block.metric,
                unit: block.unit,
                lines: block.lines,
                entry: block.entry,
                latest: block.latest,
                latestLabel: block.latest_label,
            };
        },
    },
    template: `
    <div>
        <div class="row g-3 mb-3" role="tablist" :aria-label="(page.heading || '人员') + '概览'">
            <div v-for="block in blocks" :key="block.key" class="col-12 col-md-4">
                <metric-card v-bind="cardProps(block)" :selected="activeTab === block.key"
                             @select="selectTab(block.key)"></metric-card>
            </div>
        </div>

        <div v-if="visited.people" v-show="activeTab === 'people'">
            <workspace-table v-bind="table" :table-key="page.key" :label="page.title"
                             :region-label="(page.title || '人员') + '数据表'"
                             :csrf="csrf"></workspace-table>
        </div>

        <div v-if="visited.departments" v-show="activeTab === 'departments'">
            <section class="card surface-card department-workspace" aria-labelledby="peopleDepartmentsHeading">
                <div class="card-header surface-card__header department-workspace__header">
                    <div>
                        <p class="page-heading__eyebrow mb-1">组织分布</p>
                        <h2 class="h5 mb-0" id="peopleDepartmentsHeading">部门统计</h2>
                    </div>
                    <div class="department-workspace__summary">
                        <span>整体在职率</span><strong>[[ activeRate ]]%</strong>
                    </div>
                </div>
                <div class="card-body">
                    <div class="table-scroll-shell">
                        <div class="table-responsive" role="region" aria-label="部门人员统计" tabindex="0">
                            <table class="table data-table table-hover align-middle mb-0">
                                <thead><tr><th>部门</th><th>人员总数</th><th>在职</th><th>离职</th><th>在职率</th></tr></thead>
                                <tbody>
                                    <tr v-for="row in departments" :key="row.department">
                                        <td class="fw-semibold">[[ row.department ]]</td>
                                        <td>[[ row.total ]]</td>
                                        <td class="text-success">[[ row.active ]]</td>
                                        <td :class="row.departed ? 'text-danger' : ''">[[ row.departed ]]</td>
                                        <td>[[ (Number(row.active_rate) || 0).toFixed(1) ]]%</td>
                                    </tr>
                                    <tr v-if="!departments.length"><td colspan="5">
                                        <div class="empty-state"><strong>暂无部门数据</strong><span>导入或同步人员后按部门自动汇总。</span></div>
                                    </td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </div>`,
};
