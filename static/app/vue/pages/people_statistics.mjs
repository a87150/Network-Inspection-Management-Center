/* 人员统计页：一份 bootstrap JSON 渲染整页——总体方块 + 部门统计表。
   数字口径全部来自 assets.views.people_statistics，这里只负责画。 */

export default {
    delimiters: ['[[', ']]'],
    props: {
        page: {type: Object, default: () => ({})},
        metrics: {type: Object, default: () => ({})},
        departments: {type: Array, default: () => []},
    },
    computed: {
        cells() {
            const metrics = this.metrics || {};
            return [
                {label: '人员总数', value: metrics.total, tone: ''},
                {label: '在职人数', value: metrics.active, tone: 'text-success'},
                {label: '离职人数', value: metrics.departed, tone: metrics.departed ? 'text-danger' : ''},
                {label: '在职率', value: (Number(metrics.active_rate) || 0).toFixed(1) + '%', tone: ''},
                {label: '本年入职', value: metrics.hires_this_year, tone: ''},
                {label: '本年离职', value: metrics.departures_this_year, tone: ''},
            ];
        },
        tenure() {
            const metrics = this.metrics || {};
            return {
                years: (Number(metrics.average_active_tenure_years) || 0).toFixed(1),
                sample: metrics.tenure_sample_count || 0,
            };
        },
        activeRate() {
            return (Number((this.metrics || {}).active_rate) || 0).toFixed(1);
        },
    },
    template: `
    <div>
        <header class="page-heading">
            <div class="page-heading__copy">
                <p v-if="page.eyebrow" class="page-heading__eyebrow">[[ page.eyebrow ]]</p>
                <h1 class="page-heading__title">[[ page.title ]]</h1>
                <p v-if="page.description" class="page-heading__description">[[ page.description ]]</p>
            </div>
        </header>

        <section aria-labelledby="people-overview-title" class="mb-4">
            <h2 class="visually-hidden" id="people-overview-title">总体统计</h2>
            <div class="row g-3 metric-summary-grid">
                <div class="col-6 col-lg-3" v-for="cell in cells" :key="cell.label">
                    <div class="card surface-card h-100"><div class="card-body">
                        <div class="metric-label">[[ cell.label ]]</div>
                        <div class="h3 mb-0" :class="cell.tone">[[ cell.value ]]</div>
                    </div></div>
                </div>
                <div class="col-12 col-lg-6">
                    <div class="card surface-card h-100"><div class="card-body">
                        <div class="metric-label">平均在职年限</div>
                        <div class="h3 mb-1">[[ tenure.years ]] 年</div>
                        <div class="small text-secondary">仅统计 [[ tenure.sample ]] 名有有效入职日期的在职人员</div>
                    </div></div>
                </div>
            </div>
        </section>

        <section class="card surface-card department-workspace" aria-labelledby="department-statistics-title">
            <div class="card-header surface-card__header department-workspace__header">
                <div>
                    <p class="page-heading__eyebrow mb-1">组织分布</p>
                    <h2 class="h5 mb-0" id="department-statistics-title">部门统计</h2>
                </div>
                <div class="department-workspace__summary"><span>整体在职率</span><strong>[[ activeRate ]]%</strong></div>
            </div>
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
                            <div class="empty-state"><strong>暂无人员数据</strong><span>导入或同步人员后将在这里生成统计。</span></div>
                        </td></tr>
                    </tbody>
                </table>
            </div>
        </section>
    </div>`,
};
