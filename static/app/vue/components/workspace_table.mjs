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
        selectAttr: {type: String, default: ''},
        formId: {type: String, default: ''},
        pageSizes: {type: Array, default: () => [20, 50, 100, 200]},
    },
    data() {
        return {
            ...tableData(this),
            columnVisibility: {...this.visibleColumns},
            filterVisibility: {...this.shownFilters},
            activeId: '',
        };
    },
    methods: {
        /** 把当前的筛选和排序一起写进地址栏。page 传 null 表示回到第一页。 */
        remember(extra) {
            const changes = {...extra};
            this.columns.forEach((column) => {
                const value = this.draftFilters[column.key];
                const blank = value === '' || value === null || value === undefined;
                changes['filter_' + column.key] = blank ? null : value;
            });
            syncUrl(changes, {pageSize: this.pageSize, prefix: this.urlPrefix});
        },
        /** 唯一的请求入口：翻页、排序、筛选、换条数都走这里，状态赋值只写一遍。 */
        async request({page = 1, sort = this.sortKey, order = this.sortOrder} = {}) {
            if (!this.endpoint) return;
            this.loading = true;
            this.error = '';
            try {
                const params = apiParams(this.draftFilters, {page});
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
    <div>
        <p v-if="error" class="alert alert-danger py-2" role="alert">[[ error ]]</p>
        <div class="table-toolbar">
            <table-toolbar :columns="columns" :filters="draftFilters" :visible="columnVisibility"
                           :shown-filters="filterVisibility" :count="total" :from="from" :to="to"
                           :page-size="pageSize" :page-sizes="pageSizes" :export-url="exportUrl"
                           :table-key="tableKey" :busy="loading"
                           @apply="applyFilters" @reset="resetFilters"
                           @page-size="changePageSize"
                           @columns-change="onColumnsChange" @filters-change="onFiltersChange"></table-toolbar>
        </div>
        <div class="card surface-card table-scroll-shell">
            <p class="table-scroll-hint">可横向滚动查看更多字段，最右侧操作列保持可见</p>
            <data-table :columns="columns" :rows="items" :visible="columnVisibility"
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
