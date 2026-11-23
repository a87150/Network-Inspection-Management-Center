/* 一个完整的工作区表格面板：工具栏 + 表格 + 翻页 + 详情弹窗。
   每个工作区页面里放一份或多份，各自持有独立的分页与筛选状态。
   自己做请求、自己改地址栏，页面不用管；只把真正有值的参数写进 URL。 */
import { api } from '../api.mjs';
import { tableData, syncUrl, apiParams } from '../composables/use_table.mjs';
import TableToolbar from './table_toolbar.mjs';
import DataTable from './data_table.mjs';
import PagePagination from './page_pagination.mjs';
import DetailModal from './detail_modal.mjs';

export default {
    delimiters: ['[[', ']]'],
    components: {TableToolbar, DataTable, PagePagination, DetailModal},
    props: {
        endpoint: {type: String, default: ''},
        tableKey: {type: String, default: 'workspace'},
        columns: {type: Array, default: () => []},
        rows: {type: Array, default: () => []},
        count: {type: Number, default: 0},
        page: {type: Number, default: 1},
        pages: {type: Number, default: 1},
        page_size: {type: Number, default: 20},
        start_index: {type: Number, default: 0},
        end_index: {type: Number, default: 0},
        sort: {type: String, default: ''},
        order: {type: String, default: 'asc'},
        filters: {type: Object, default: () => ({})},
        visibleColumns: {type: Object, default: () => ({})},
        shownFilters: {type: Object, default: () => ({})},
        detailBase: {type: String, default: ''},
        emptyTitle: {type: String, default: '暂无数据'},
        emptyMessage: {type: String, default: ''},
        label: {type: String, default: '数据'},
        regionLabel: {type: String, default: ''},
        urlPrefix: {type: String, default: ''},
        exportUrl: {type: String, default: ''},
        csrf: {type: String, default: ''},
        // 每张表都能勾选：全选/反选和导出选择项是这批表格的通用能力，
        // 不跟着批量操作弹窗走。
        selectAttr: {type: String, default: 'data-device-selection-target'},
        formId: {type: String, default: ''},
        pageSizes: {type: Array, default: () => [20, 50, 100, 200]},
        // 网络设备/弱电设备的配置备份 ZIP 地址；有值时工具栏露出「下载所选配置」。
        configurationZip: {type: String, default: ''},
    },
    data() {
        return {
            ...tableData(this),
            columnVisibility: {...this.visibleColumns},
            filterVisibility: {...this.shownFilters},
            activeId: '',
            selectedIds: [],
            urlVersion: 0,
        };
    },
    computed: {
        /** 导出「当前筛选下的整个结果集」：照搬地址栏参数，只把页码去掉。
            勾了行就只导勾中的那些，target_ids 是 exports.py 认的参数。 */
        exportHref() {
            if (!this.exportUrl) return '';
            void this.urlVersion; // 地址栏变了就重算，否则导出还是上一次的筛选
            void this.selectedIds; // 勾选变了也要重算，否则导出还是上一次的选择
            const url = new URL(this.exportUrl, window.location.origin);
            // 岛内筛选不写地址栏（syncUrl 是空实现），所以按组件当前的筛选状态重新序列化，
            // 否则筛选完点导出还是全量。地址栏里还留着的其它参数（外部入口带来的）保留。
            // apiParams 返回的是普通对象，转成 URLSearchParams 才能拼 query。
            const params = new URLSearchParams(apiParams(this.draftFilters, {}));
            params.delete('page');
            url.search = params.toString();
            if (this.selectedIds.length) {
                url.searchParams.set('target_ids', this.selectedIds.join(','));
            }
            // 只导页面上勾选的那几列；一列都没勾时后端退回全部列，入口上会提示。
            const shown = this.shownColumns;
            if (shown.length) url.searchParams.set('columns', shown.join(','));
            return url.pathname + url.search;
        },
        /** 当前勾了「显示列」的列 key，顺序按定义走。 */
        shownColumns() {
            const columns = this.columns || [];
            const state = this.columnVisibility || {};
            return columns
                .filter((column) => state[column.key] !== false)
                .map((column) => column.key);
        },
        configurationHref() {
            if (!this.configurationZip) return '';
            if (!this.selectedIds.length) return this.configurationZip;
            // 服务端认 target_ids（逗号分隔）；带了才是「下载所选」，否则是整批。
            const url = new URL(this.configurationZip, window.location.origin);
            url.searchParams.set('target_ids', this.selectedIds.join(','));
            return url.pathname + url.search;
        },
    },
    mounted() {
        // 弹窗保存完不用整页刷新：收到事件自己重取一次。
        this.onModalUpdated = () => this.reload();
        document.addEventListener('app:modal-updated', this.onModalUpdated);
    },
    beforeUnmount() {
        document.removeEventListener('app:modal-updated', this.onModalUpdated);
    },
    methods: {
        reload() {
            if (this.endpoint) this.request({page: this.page || 1});
        },
        /** 表体里的批量勾选框（data_table 按 selectAttr 渲染）。 */
        selectionBoxes() {
            const root = this.$el && this.$el.querySelectorAll ? this.$el : document;
            return Array.from(root.querySelectorAll('[' + (this.selectAttr || 'data-device-selection-target') + ']'));
        },
        readSelection() {
            this.selectedIds = this.selectionBoxes()
                .filter((box) => box.checked)
                .map((box) => box.value)
                .filter(Boolean);
        },
        // 维护窗口等脚本靠 change 事件感知选择，批量勾选后补发一次，两条路径行为一致。
        announceSelection() {
            this.selectionBoxes().forEach((box) => box.dispatchEvent(new Event('change', {bubbles: true})));
            this.readSelection();
        },
        selectAll() {
            this.selectionBoxes().forEach((box) => { box.checked = true; });
            this.announceSelection();
        },
        selectInvert() {
            this.selectionBoxes().forEach((box) => { box.checked = !box.checked; });
            this.announceSelection();
        },
        /** 把当前的筛选和排序一起写进地址栏。page 传 null 表示回到第一页。 */
        remember(extra) {
            const changes = {...extra};
            this.columns.forEach((column) => {
                const value = this.draftFilters[column.key];
                const name = 'filter_' + column.key;
                // 数值是 {op,value}、日期是 {from,to}，各拆成自己的参数名写进地址栏。
                if (value !== null && typeof value === 'object') {
                    if (value.value !== undefined) {
                        const blank = String(value.value === null || value.value === undefined ? '' : value.value).trim() === '';
                        changes[name] = blank ? null : value.value;
                        changes[name + '_op'] = blank ? null : (value.op || 'gt');
                    } else {
                        changes[name + '_from'] = value.from || null;
                        changes[name + '_to'] = value.to || null;
                    }
                    return;
                }
                const blank = value === '' || value === null || value === undefined;
                changes[name] = blank ? null : value;
            });
            syncUrl(changes, {pageSize: this.pageSize, prefix: this.urlPrefix});
            this.urlVersion += 1;
        },
        /** 唯一的请求入口：翻页、排序、筛选、换条数都走这里，状态赋值只写一遍。 */
        async request({page = 1, sort = this.sortKey, order = this.sortOrder} = {}) {
            if (!this.endpoint) return;
            this.loading = true;
            this.error = '';
            try {
                // 接口层不带前缀；page_size 必须每次随请求发，否则改条数后会被
                // payload.page_size 打回默认值——地址栏写了，数据没变。
                const params = apiParams(this.draftFilters, {page, page_size: this.pageSize});
                if (sort) {
                    params.sort = sort;
                    params.order = order;
                }
                const payload = await api.get(this.endpoint, params);
                this.items = payload.results || [];
                this.total = payload.count;
                this.currentPage = payload.page;
                this.jumpPage = payload.page;
                this.totalPages = payload.pages;
                this.pageSize = payload.page_size;
                this.from = payload.start_index;
                this.to = payload.end_index;
                // 翻页/重筛后表体重新渲染，旧的勾选已经不在 DOM 里，别再拿去导出。
                this.selectedIds = [];
            } catch (failure) {
                this.error = failure.message || '加载失败';
            } finally {
                this.loading = false;
            }
        },
        goPage(page) {
            const target = Math.min(Math.max(Math.trunc(page || 1), 1), this.totalPages || 1);
            this.jumpPage = target;
            if (target === this.currentPage) return;
            this.remember({page: target});
            this.request({page: target});
        },
        jumpTo() {
            const target = Math.min(Math.max(Math.trunc(this.jumpPage || 1), 1), this.totalPages || 1);
            this.jumpPage = target;
            if (target === this.currentPage) return;
            this.goPage(target);
        },
        sortBy(column) {
            if (!column.sortable) return;
            const order = (this.sortKey === column.key && this.sortOrder === 'asc') ? 'desc' : 'asc';
            this.sortKey = column.key;
            this.sortOrder = order;
            this.remember({page: null, sort: column.key, order: order});
            this.request({page: 1, sort: column.key, order: order});
        },
        applyFilters(next) {
            this.draftFilters = {...next};
            this.remember({page: null});
            this.request({page: 1});
        },
        resetFilters() {
            const blank = {};
            this.columns.forEach((column) => { blank[column.key] = ''; });
            this.applyFilters(blank);
        },
        changePageSize(size) {
            this.pageSize = size;
            syncUrl({page_size: size, page: null}, {pageSize: size, prefix: this.urlPrefix});
            this.request({page: 1});
        },
        onColumnsChange(next) { this.columnVisibility = {...next}; },
        onFiltersChange(next) { this.filterVisibility = {...next}; },
        openDetail(row) {
            if (!row || !row.id) return;
            this.activeId = row.id;
            this.$refs.detail.open(row.id);
        },
    },
    template: `
    <div @change="readSelection">
        <p v-if="error" class="alert alert-danger py-2" role="alert">[[ error ]]</p>
        <div class="table-toolbar">
            <table-toolbar :columns="columns" :filters="draftFilters" :visible="columnVisibility"
                           :shown-filters="filterVisibility" :count="total" :from="from" :to="to"
                           :page-size="pageSize" :page-sizes="pageSizes" :export-url="exportHref"
                             :export-column-count="shownColumns.length"
                           :table-key="tableKey" :busy="loading"
                             selectable :configuration-href="configurationHref"
                             :selected-count="selectedIds.length"
                           @apply="applyFilters" @reset="resetFilters"
                             @select-all="selectAll" @select-invert="selectInvert"
                           @page-size="changePageSize"
                           @columns-change="onColumnsChange" @filters-change="onFiltersChange">
                <template #actions><slot name="actions"></slot></template>
            </table-toolbar>
        </div>
        <div class="card surface-card table-scroll-shell">
            <p class="table-scroll-hint">可横向滚动查看更多字段，最右侧操作列保持可见</p>
            <data-table :columns="columns" :rows="items" :visible="columnVisibility" :table-key="tableKey"
                        :sort-key="sortKey" :sort-order="sortOrder" :loading="loading"
                        :select-attr="selectAttr" :form-id="formId" :csrf="csrf" :active-id="activeId"
                        :empty-title="emptyTitle" :empty-message="emptyMessage"
                        :label="label" :region-label="regionLabel"
                        @sort="sortBy" @row-click="openDetail" @open-detail="openDetail"></data-table>
            <page-pagination :page="currentPage" :pages="totalPages" :loading="loading" :label="label"
                             v-model="jumpPage" @go="goPage"></page-pagination>
        </div>
        <detail-modal ref="detail" :base="detailBase" :title="label + '详情'" :modal-id="tableKey + 'DetailModal'"></detail-modal>
    </div>`,
};
