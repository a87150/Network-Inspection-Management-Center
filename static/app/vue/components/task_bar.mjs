/* 巡检任务栏：PC、网络设备、服务器、弱电设备四个工作区页面共用。
   纯展示，行数据由后端序列化好（见 workspace.py 的 task_rows）。 */

export default {
    delimiters: ['[[', ']]'],
    props: {
        rows: {type: Array, default: () => []},
        count: {type: Number, default: 0},
        page: {type: Number, default: 1},
        pages: {type: Number, default: 1},
        selectedId: {type: String, default: ''},
        sectionTitle: {type: String, default: '巡检任务栏'},
        emptyTitle: {type: String, default: '暂无巡检任务'},
        busy: {type: Boolean, default: false},
    },
    emits: ['select', 'page', 'detail'],
    methods: {
        statusClass(status) {
            return {
                success: 'text-bg-success',
                failed: 'text-bg-danger',
                partial: 'text-bg-warning',
            }[status] || 'text-bg-secondary';
        },
        onRowKey(row, event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.$emit('select', row);
            }
        },
    },
    template: `
    <section class="card surface-card inspection-taskbar execution-workspace" aria-labelledby="inspection-taskbar-title">
        <div class="card-header surface-card__header inspection-taskbar__header">
            <div>
                <p class="page-heading__eyebrow mb-1">执行中心</p>
                <h2 class="h5 mb-0" id="inspection-taskbar-title">[[ sectionTitle ]]</h2>
            </div>
            <div class="execution-workspace__header-actions"><div class="execution-workspace__summary"><span>当前任务</span><strong>[[ count ]]</strong></div></div>
        </div>
        <div class="table-scroll-shell">
            <p class="table-scroll-hint">可横向滚动查看完整任务信息</p>
            <div class="table-responsive" role="region" :aria-label="sectionTitle" tabindex="0">
                <table class="table data-table table-hover align-middle mb-0">
                    <thead><tr>
                        <th>类型</th><th>配置</th><th>来源</th><th>创建时间</th><th>完成时间</th><th>目标</th>
                        <th>正常结果</th><th>异常</th><th>待处理</th><th>已取消</th><th>状态</th>
                        <th class="table-actions-column table-actions-cell"><span class="visually-hidden">操作</span></th>
                    </tr></thead>
                    <tbody>
                        <tr v-for="row in rows" :key="row.id"
                            class="inspection-taskbar__row" :class="{'is-selected': selectedId === row.id}"
                            tabindex="0" role="link" @click="$emit('select', row)" @keydown="onRowKey(row, $event)">
                            <td class="fw-semibold">[[ row.type_label ]]</td>
                            <td>[[ row.profile_label ]]</td>
                            <td>[[ row.source_label ]]</td>
                            <td class="text-nowrap">[[ row.created_at ]]</td>
                            <td class="text-nowrap">[[ row.finished_at || '—' ]]</td>
                            <td>[[ row.total ]]<span v-if="row.fetch_success" class="inspection-taskbar__scan-note">获取成功 [[ row.fetch_success ]]</span><span v-if="row.integrity_warning" class="inspection-taskbar__integrity-warning">[[ row.integrity_warning ]]</span></td>
                            <td><span class="text-success">[[ row.normal ]]</span></td>
                            <td><span :class="row.abnormal ? 'text-danger fw-semibold' : ''">[[ row.abnormal ]]</span></td>
                            <td>[[ row.pending ]]</td>
                            <td>[[ row.cancelled ]]</td>
                            <td><span class="badge status-badge" :class="statusClass(row.status)">[[ row.status_label ]]</span></td>
                            <td class="text-end table-actions-cell">
                                <button class="btn btn-outline-dark btn-sm" type="button" @click.stop.prevent="$emit('detail', row)">查看详情</button>
                            </td>
                        </tr>
                        <tr v-if="!rows.length"><td colspan="12"><div class="empty-state"><strong>[[ emptyTitle ]]</strong><span>从资产或日志页面发起巡检、扫描或分析后，任务进度会显示在这里。</span></div></td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        <nav v-if="pages > 1" class="inspection-taskbar__pagination page-pagination" :aria-label="sectionTitle + '分页'">
            <div class="page-pagination__actions">
                <button class="btn btn-outline-secondary page-pagination__button" type="button" :disabled="page <= 1 || busy" @click="$emit('page', page - 1)">上一页</button>
                <span class="page-pagination__page">第 [[ page ]] / [[ pages ]] 页</span>
                <button class="btn btn-outline-secondary page-pagination__button" type="button" :disabled="page >= pages || busy" @click="$emit('page', page + 1)">下一页</button>
            </div>
        </nav>
    </section>`,
};
