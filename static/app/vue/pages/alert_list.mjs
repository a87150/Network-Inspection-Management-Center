/* 告警记录：表格与分页走 REST，筛选/排序仍是 URL 参数，首屏由服务端注水。 */
import { api } from '../api.mjs';

function badgeClass(status) {
    const tones = {
        success: ['success', 'normal', 'recovery', 'sent', 'delivered', 'enabled', 'completed'],
        danger: ['failed', 'abnormal', 'error', 'critical'],
        warning: ['partial', 'warning', 'retry', 'blocked'],
        secondary: ['cancelled', 'disabled', 'skipped', 'unknown'],
    };
    for (const [tone, members] of Object.entries(tones)) {
        if (members.includes(status)) return 'text-bg-' + tone;
    }
    return 'text-bg-info';
}

export default {
    delimiters: ['[[', ']]'],
    props: {
        endpoint: {type: String, default: '/api/v1/alert-events/'},
        rows: {type: Array, default: () => []},
        count: {type: Number, default: 0},
        page: {type: Number, default: 1},
        pages: {type: Number, default: 1},
        page_size: {type: Number, default: 20},
        start_index: {type: Number, default: 0},
        end_index: {type: Number, default: 0},
    },
    data() {
        return {
            items: this.rows,
            total: this.count,
            currentPage: this.page,
            jumpPage: this.page,
            totalPages: this.pages,
            from: this.start_index,
            to: this.end_index,
            loading: false,
            error: '',
            // 表头复用列表页的 table-sort-link，外观和排序行为都不分叉。
            // key 必须和 index/common/table_registry.py 的 alert_events 字段完全一致：
            // 「自定义表格」的列开关按 data-column-key 给 th/td 打 hidden，
            // 也对不上集合的列会被永久藏掉；sort 参数同样按这套 key 过滤。
            columns: [
                {key: 'event_type', label: '事件类型'},
                {key: 'profile_type', label: '项目'},
                {key: 'target_id', label: '目标'},
                {key: 'severity', label: '严重级别'},
                {key: 'status', label: '事件状态'},
                {key: 'delivery_outcome', label: '渠道结果', sortable: false},
                {key: 'occurred_at', label: '发生时间'},
            ],
            sortKey: 'occurred_at',
            sortOrder: 'desc',
        };
    },
    methods: {
        badgeClass,
        async sortBy(column) {
            // 先算方向再记列。反过来的话 nextOrder 里的「同一列」判断恒真，
            // 切到新列会沿用上一列的方向取反，提示文字也跟着说反。
            const order = this.nextOrder(column);
            this.sortKey = column.key;
            this.sortOrder = order;
            await this.load(1);
        },
        nextOrder(column) {
            return this.sortKey === column.key && this.sortOrder === 'asc' ? 'desc' : 'asc';
        },
        sortLabel(column) {
            return '按' + column.label + (this.nextOrder(column) === 'asc' ? '升序' : '降序') + '排列';
        },
        ariaSort(column) {
            if (column.sortable === false || this.sortKey !== column.key) return null;
            return this.sortOrder === 'asc' ? 'ascending' : 'descending';
        },
        jumpTo() {
            const total = this.totalPages || 1;
            const page = Math.min(Math.max(Math.trunc(this.jumpPage || 1), 1), total);
            this.jumpPage = page;
            this.load(page);
        },
        async load(page) {
            if (this.loading || page < 1 || page > this.totalPages) return;
            this.loading = true;
            this.error = '';
            try {
                const params = Object.fromEntries(new URLSearchParams(window.location.search));
                params.page = page;
                if (this.sortKey) {
                    params.sort = this.sortKey;
                    params.order = this.sortOrder;
                }
                const payload = await api.get(this.endpoint, params);
                this.items = payload.results;
                this.total = payload.count;
                this.currentPage = payload.page;
                this.jumpPage = payload.page;
                this.totalPages = payload.pages;
                this.from = payload.start_index;
                this.to = payload.end_index;
                // 翻页在岛内完成，不写地址栏。
            } catch (failure) {
                this.error = failure.message || '加载失败';
            } finally {
                this.loading = false;
            }
        },
    },
    template: `
    <div class="alert-table-region">
        <p v-if="error" class="alert alert-danger py-2" role="alert">[[ error ]]</p>
        <div class="card surface-card table-scroll-shell">
            <p class="table-scroll-hint">可横向滚动查看渠道送达与事件信息</p>
            <div class="table-responsive" role="region" aria-label="告警记录数据表" tabindex="0" :aria-busy="loading ? 'true' : 'false'">
                <table class="table data-table table-hover align-middle mb-0">
                    <caption class="visually-hidden">告警事件类型、来源、目标、级别、状态、渠道结果与发生时间</caption>
                    <thead>
                        <tr>
                            <th v-for="column in columns" :key="column.key" scope="col"
                                :data-column-key="column.key" :aria-sort="ariaSort(column)">
                                <a v-if="column.sortable !== false" class="table-sort-link" :data-sort-key="column.key"
                                   href="#" :aria-label="sortLabel(column)" @click.prevent="sortBy(column)">[[ column.label ]]</a>
                                <template v-else>[[ column.label ]]</template>
                            </th>
                            <th scope="col" class="table-actions-column table-actions-cell">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="row in items" :key="row.id">
                            <td :data-column-key="'event_type'"><span class="badge status-badge" :class="badgeClass(row.event_type.status)" :data-status="row.event_type.status">[[ row.event_type.label ]]</span></td>
                            <td :data-column-key="'profile_type'">[[ row.name ]]</td>
                            <td :data-column-key="'target_id'" class="text-break">[[ row.target ]]</td>
                            <td :data-column-key="'severity'"><span class="badge status-badge" :class="row.severity.class" :data-status="row.severity.status">[[ row.severity.label ]]</span></td>
                            <td :data-column-key="'status'"><span class="badge status-badge" :class="badgeClass(row.status.status)" :data-status="row.status.status">[[ row.status.label ]]</span></td>
                            <td :data-column-key="'delivery_outcome'" class="text-break">
                                <div class="alert-delivery-summary" aria-label="渠道送达结果">
                                    <template v-if="row.deliveries.length">
                                        <span v-for="delivery in row.deliveries" :key="delivery.label" class="badge status-badge" :class="badgeClass(delivery.status)" :data-status="delivery.status">[[ delivery.label ]]</span>
                                    </template>
                                    <span v-else class="text-secondary">暂无渠道结果</span>
                                </div>
                            </td>
                            <td :data-column-key="'occurred_at'">[[ row.occurred_at_display ]]</td>
                            <td class="text-end table-actions-cell"><a class="btn btn-outline-dark btn-sm" :href="row.detail_url" :data-detail-modal="row.detail_url">查看详情</a></td>
                        </tr>
                        <tr v-if="!items.length">
                            <td colspan="8">
                                <div class="empty-state"><strong>暂无告警记录</strong><span>异常或恢复事件产生后将显示在这里。</span></div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
        <nav v-if="totalPages > 1" class="page-pagination" aria-label="告警记录分页">
            <div class="page-pagination__actions">
                <button class="btn btn-outline-secondary page-pagination__button" type="button" :disabled="currentPage <= 1 || loading" @click="load(currentPage - 1)">上一页</button>
                <span class="page-pagination__page">第
                    <input class="page-pagination__input" type="number" inputmode="numeric" min="1" :max="totalPages" v-model.number="jumpPage" @keydown.enter.prevent="jumpTo()" @change="jumpTo()" aria-label="输入页码跳转">
                    / [[ totalPages ]] 页</span>
                <button class="btn btn-outline-secondary page-pagination__button" type="button" :disabled="currentPage >= totalPages || loading" @click="load(currentPage + 1)">下一页</button>
            </div>
        </nav>
    </div>`,
};
