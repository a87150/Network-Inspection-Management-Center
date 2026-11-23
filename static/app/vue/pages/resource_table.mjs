/* 通用列表：列、行、动作由后端 TableDefinition + payload 决定，翻页走 REST。 */
import { api } from '../api.mjs';

export default {
    delimiters: ['[[', ']]'],
    props: {
        endpoint: {type: String, default: ''},
        columns: {type: Array, default: () => []},
        rows: {type: Array, default: () => []},
        count: {type: Number, default: 0},
        page: {type: Number, default: 1},
        pages: {type: Number, default: 1},
        start_index: {type: Number, default: 0},
        end_index: {type: Number, default: 0},
        empty_title: {type: String, default: '暂无记录'},
        empty_message: {type: String, default: ''},
        label: {type: String, default: '记录'},
        region_label: {type: String, default: ''},
        select_attr: {type: String, default: ''},
        select_value_key: {type: String, default: 'id'},
        show_actions: {type: Boolean, default: true},
        csrf: {type: String, default: ''},
        cell_class: {type: Object, default: () => ({})},
        page_param: {type: String, default: 'page'},
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
            visible: {},
        };
    },
    computed: {
        visibleColumns() {
            return this.columns.filter((column) => this.visible[column.key] !== false);
        },
        actionColumn() {
            return this.show_actions;
        },
        sort() {
            return new URLSearchParams(window.location.search).get('sort') || '';
        },
        order() {
            return new URLSearchParams(window.location.search).get('order') || 'asc';
        },
        locationPath() {
            return window.location.pathname + window.location.search;
        },
        columnCount() {
            return this.visibleColumns.length + (this.select_attr ? 1 : 0) + (this.actionColumn ? 1 : 0);
        },
    },
    mounted() {
        this.syncColumnToggles();
        document.addEventListener('change', this.syncColumnToggles);
    },
    unmounted() {
        document.removeEventListener('change', this.syncColumnToggles);
    },
    methods: {
        boxes() {
            const root = this.$el && this.$el.querySelectorAll ? this.$el : document;
            return Array.from(root.querySelectorAll('tbody [' + this.select_attr + ']'));
        },
        allSelected() {
            const list = this.boxes();
            return list.length > 0 && list.every((box) => box.checked);
        },
        someSelected() {
            return this.boxes().some((box) => box.checked);
        },
        toggleAll(event) {
            const on = event.target.checked;
            this.boxes().forEach((box) => { box.checked = on; });
        },
        selectAll() {
            this.boxes().forEach((box) => { box.checked = true; });
        },
        selectInvert() {
            this.boxes().forEach((box) => { box.checked = !box.checked; });
        },
        syncColumnToggles() {
            const next = {};
            document.querySelectorAll('[data-column-toggle][data-column-key]')
                .forEach((toggle) => {
                    next[toggle.dataset.columnKey] = toggle.checked;
                });
            this.visible = next;
        },
        jumpTo() {
            const total = this.totalPages || 1;
            const page = Math.min(Math.max(Math.trunc(this.jumpPage || 1), 1), total);
            this.jumpPage = page;
            this.load(page);
        },
        async load(page) {
            if (!this.endpoint || this.loading || page < 1 || page > this.totalPages) return;
            this.loading = true;
            this.error = '';
            try {
                const params = Object.fromEntries(new URLSearchParams(window.location.search));
                params[this.page_param] = page;
                const payload = await api.get(this.endpoint, params);
                this.items = payload.results || payload.rows || [];
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
        cell(row, key) {
            const value = row.cells ? row.cells[key] : null;
            return value || {text: '-'};
        },
        nextOrder(column) {
            return this.sort === column.key && this.order === 'asc' ? 'desc' : 'asc';
        },
        sortLabel(column) {
            return '按' + column.label + (this.nextOrder(column) === 'asc' ? '升序' : '降序') + '排列';
        },
        sortUrl(column) {
            const url = new URL(window.location.href);
            url.searchParams.set('sort', column.key);
            url.searchParams.set('order', this.nextOrder(column));
            url.searchParams.delete('page');
            return url.pathname + url.search;
        },
        ariaSort(column) {
            if (!column.sortable || this.sort !== column.key) return null;
            return this.order === 'asc' ? 'ascending' : 'descending';
        },
        actionClass(action) {
            const style = action.variant === 'primary'
                ? 'btn-outline-primary'
                : (action.danger ? 'btn-outline-danger' : 'btn-outline-dark');
            return 'btn btn-sm ' + style;
        },
        badgeClass(row, key) {
            const badge = this.cell(row, key).badge || {};
            return badge.class || ('text-bg-' + (badge.tone || 'info'));
        },
        cellClass(key) {
            return this.cell_class[key] || '';
        },
        selectBinding(row) {
            if (!this.select_attr) return {};
            return {[this.select_attr]: ''};
        },
        hasActions(row) {
            return (row.actions && row.actions.length) || row.url;
        },
    },
    template: `
    <div class="resource-table">
        <div v-if="select_attr" class="d-flex justify-content-end gap-2 mb-2">
            <button class="btn btn-sm btn-outline-secondary" type="button" @click="selectAll">全选</button>
            <button class="btn btn-sm btn-outline-secondary" type="button" @click="selectInvert">反选</button>
        </div>
        <p v-if="error" class="alert alert-danger py-2" role="alert">[[ error ]]</p>
        <div class="table-responsive" role="region" :aria-label="region_label || (label + '数据表')" tabindex="0" :aria-busy="loading ? 'true' : 'false'">
            <table class="table data-table table-hover align-middle mb-0">
                <thead>
                    <tr>
                        <th v-if="select_attr" scope="col" class="text-center">
                            <input class="form-check-input" type="checkbox" :checked="allSelected" :indeterminate.prop="someSelected && !allSelected"
                                   aria-label="全选本页" @change="toggleAll($event)">
                        </th>
                        <th v-for="column in visibleColumns" :key="column.key" scope="col" :data-column-key="column.key" :aria-sort="ariaSort(column)">
                            <a v-if="column.sortable" class="table-sort-link" :data-sort-key="column.key" :href="sortUrl(column)" :aria-label="sortLabel(column)">[[ column.label ]]</a>
                            <template v-else>[[ column.label ]]</template>
                        </th>
                        <th v-if="actionColumn" scope="col" class="table-actions-column table-actions-cell">操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(row, index) in items" :key="row.id || index">
                        <td v-if="select_attr" class="text-center"><input class="form-check-input" type="checkbox" :value="row[select_value_key] || row.id || ''" :aria-label="'选择 ' + (row.id || '')" v-bind="selectBinding(row)"></td>
                        <td v-for="column in visibleColumns" :key="column.key" :data-column-key="column.key" :class="cellClass(column.key)">
                            <span v-if="cell(row, column.key).badge" class="badge status-badge" :class="badgeClass(row, column.key)" :data-status="cell(row, column.key).badge.status">[[ cell(row, column.key).badge.label ]]</span>
                            <template v-else>[[ cell(row, column.key).text ]]</template>
                        </td>
                        <td v-if="actionColumn" class="text-end table-actions-cell">
                            <div class="d-inline-flex gap-2">
                                <template v-for="(action, actionIndex) in row.actions" :key="actionIndex">
                                    <form v-if="action.kind === 'form'" method="post" :action="action.url" :data-confirm-message="action.confirm || null">
                                        <input type="hidden" name="csrfmiddlewaretoken" :value="csrf">
                                        <input type="hidden" name="next" :value="locationPath">
                                        <button :class="'btn btn-sm ' + (action.danger ? 'btn-outline-danger' : 'btn-outline-dark')" type="submit">[[ action.label ]]</button>
                                    </form>
                                    <button v-else-if="action.kind === 'modal'" type="button" :class="actionClass(action)"
                                            data-bs-toggle="modal" :data-bs-target="action.modal_target ? '#' + action.modal_target : null"
                                            :data-bitlocker-url="action.url" :data-computer-name="action.computer_name || null">[[ action.label ]]</button>
                                    <a v-else :class="actionClass(action)" :href="action.url"
                                       :data-modal-load="action.modal_target || null"
                                       :data-detail-modal="action.detail_modal ? action.url : null">[[ action.label ]]</a>
                                </template>
                                <a v-if="!row.actions && row.url" class="btn btn-outline-dark btn-sm" :href="row.url" :data-detail-modal="row.url">查看详情</a>
                                <span v-if="!hasActions(row)" class="text-secondary">—</span>
                            </div>
                        </td>
                    </tr>
                    <tr v-if="!items.length">
                        <td :colspan="columnCount">
                            <div class="empty-state"><strong>[[ empty_title ]]</strong><span>[[ empty_message ]]</span></div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <nav v-if="totalPages > 1" class="page-pagination" :aria-label="label + '分页'">
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