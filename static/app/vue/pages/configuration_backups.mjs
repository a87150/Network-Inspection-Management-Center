/* 配置备份历史页：一份 bootstrap JSON 渲染整页——版本摘要、版本表、下载与对比入口。
   页面没有分片重取，行数据里的动作就是全部交互。 */

export default {
    delimiters: ['[[', ']]'],
    props: {
        page: {type: Object, default: () => ({})},
        notice: {type: String, default: ''},
        columns: {type: Array, default: () => []},
        rows: {type: Array, default: () => []},
        section_title: {type: String, default: ''},
        summary_label: {type: String, default: ''},
        summary: {type: Array, default: () => []},
        change_summary: {type: Object, default: () => ({})},
        latest_label: {type: String, default: ''},
        latest: {type: String, default: ''},
        scroll_hint: {type: String, default: ''},
        region_label: {type: String, default: ''},
        empty_title: {type: String, default: ''},
        empty_message: {type: String, default: ''},
    },
    methods: {
        cell(row, key) {
            return (row.cells && row.cells[key]) || {text: '—'};
        },
        actionClass(action) {
            const variant = action.variant === 'primary'
                ? 'btn-outline-primary' : 'btn-outline-secondary';
            return 'btn btn-sm ' + variant;
        },
    },
    template: `
    <div>
        <header class="page-heading">
            <div class="page-heading__copy">
                <p class="page-heading__eyebrow">[[ page.eyebrow ]]</p>
                <h1 class="page-heading__title">[[ page.title ]]</h1>
                <p class="page-heading__description">[[ page.description ]]</p>
            </div>
            <div class="page-heading__actions">
                <a class="btn btn-outline-secondary" :href="page.back_url">[[ page.back_label ]]</a>
            </div>
        </header>
        <div class="alert alert-warning">[[ notice ]]</div>

        <section class="card surface-card table-scroll-shell configuration-backup-table">
            <div class="card-header surface-card__header configuration-backup-header">
                <h2 class="h5 mb-0">[[ section_title ]]</h2>
                <ul v-if="rows.length" class="configuration-backup-summary" :aria-label="summary_label">
                    <li v-for="item in summary" :key="item.label"><span>[[ item.label ]]</span><strong>[[ item.value ]]</strong></li>
                    <li><span>[[ change_summary.label ]]</span><strong class="configuration-backup-summary__add">+[[ change_summary.added ]]</strong><strong class="configuration-backup-summary__remove">-[[ change_summary.removed ]]</strong></li>
                    <li><span>[[ latest_label ]]</span><strong>[[ latest ]]</strong></li>
                </ul>
            </div>
            <template v-if="rows.length">
                <p class="table-scroll-hint">[[ scroll_hint ]]</p>
                <div class="table-responsive" role="region" :aria-label="region_label" tabindex="0">
                    <table class="table data-table table-hover align-middle mb-0">
                        <caption class="visually-hidden">配置备份版本、采集时间、范围、大小、校验值及来源任务</caption>
                        <thead><tr>
                            <th v-for="column in columns" :key="column.key" scope="col">[[ column.label ]]</th>
                            <th scope="col" class="table-actions-column table-actions-cell">操作</th>
                        </tr></thead>
                        <tbody>
                            <tr v-for="row in rows" :key="row.id">
                                <td>
                                    <span class="configuration-backup-date">[[ cell(row, 'captured').text ]]</span><br>
                                    <span class="text-secondary">[[ cell(row, 'captured').sub ]]</span>
                                </td>
                                <td class="text-break">[[ cell(row, 'filename').text ]]<br>
                                    <span class="text-secondary">[[ cell(row, 'filename').sub ]]</span></td>
                                <td>[[ cell(row, 'vendor').text ]]<br>
                                    <span class="text-secondary">[[ cell(row, 'vendor').sub ]]</span></td>
                                <td>[[ cell(row, 'size').text ]]<br>
                                    <span class="text-secondary">[[ cell(row, 'size').sub ]]</span></td>
                                <td class="configuration-backup-change">
                                    <span v-for="(chip, index) in cell(row, 'change').chips" :key="index"
                                          class="change-chip" :class="'change-chip--' + chip.tone">[[ chip.text ]]</span>
                                    <span v-if="cell(row, 'change').note === '无变化'" class="change-chip change-chip--same">无变化</span>
                                    <span v-else-if="cell(row, 'change').note" class="text-secondary">[[ cell(row, 'change').note ]]</span>
                                </td>
                                <td class="configuration-backup-hash"><code :title="cell(row, 'sha256').title">[[ cell(row, 'sha256').text ]]</code></td>
                                <td>
                                    <a v-if="cell(row, 'task').href" :href="cell(row, 'task').href">[[ cell(row, 'task').text ]]</a>
                                    <span v-else class="text-secondary">[[ cell(row, 'task').text ]]</span>
                                </td>
                                <td class="text-end table-actions-cell"><div class="d-inline-flex gap-2 table-row-actions">
                                    <a v-for="(action, index) in row.actions" :key="index" :class="actionClass(action)" :href="action.url">[[ action.label ]]</a>
                                </div></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
            <div v-else class="card-body"><div class="empty-state">
                <strong>[[ empty_title ]]</strong><span>[[ empty_message ]]</span>
            </div></div>
        </section>
    </div>`,
};
