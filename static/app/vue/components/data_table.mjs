/* 表格主体：表头排序、选择列、徽章、操作列、空态。
   纯展示，数据从 props 进，交互用事件抛出，自己不请求、不改 URL。 */
import { cellOf, badgeClassOf, actionClassOf } from '../composables/use_table.mjs';

export default {
    delimiters: ['[[', ']]'],
    props: {
        columns: {type: Array, default: () => []},
        rows: {type: Array, default: () => []},
        visible: {type: Object, default: () => ({})},
        sortKey: {type: String, default: ''},
        sortOrder: {type: String, default: 'asc'},
        loading: {type: Boolean, default: false},
        selectAttr: {type: String, default: ''},
        formId: {type: String, default: ''},
        csrf: {type: String, default: ''},
        activeId: {type: String, default: ''},
        emptyTitle: {type: String, default: '暂无数据'},
        emptyMessage: {type: String, default: ''},
        label: {type: String, default: '数据'},
        regionLabel: {type: String, default: ''},
        // 列宽按表格分开放，同一个 key 的列宽在刷新后仍然生效。
        tableKey: {type: String, default: ''},
    },
    emits: ['sort', 'open-detail', 'row-click'],
    data() {
        return {widths: {}};
    },
    computed: {
        /** 拖动过的列宽，直接写进 colgroup。 */
        colStyles() {
            return this.visibleColumns.map((column) => (
                this.widths[column.key] ? {width: this.widths[column.key] + 'px'} : {}
            ));
        },
        visibleColumns() {
            return this.columns.filter((column) => this.visible[column.key] !== false);
        },
        columnCount() {
            return this.visibleColumns.length + (this.selectAttr ? 1 : 0) + 1;
        },
    },
    mounted() {
        this.loadWidths();
    },
    methods: {
        cell(row, key) { return cellOf(row, key); },
        badgeClass(row, key) { return badgeClassOf(row, key); },
        actionClass(action) { return actionClassOf(action); },
        ariaSort(column) {
            if (!column.sortable || this.sortKey !== column.key) return null;
            return this.sortOrder === 'asc' ? 'ascending' : 'descending';
        },
        onRowClick(row, event) {
            // 点在按钮、链接、输入框上时不当作「打开详情」。
            if (event.target.closest('a, button, input, form, select')) return;
            this.$emit('row-click', row);
        },
        onAction(row, action) {
            if (action.detail_modal) this.$emit('open-detail', row);
        },
        storageKey() {
            return this.tableKey ? 'table-widths:' + this.tableKey : '';
        },
        loadWidths() {
            const key = this.storageKey();
            if (!key) return;
            try {
                this.widths = JSON.parse(localStorage.getItem(key) || '{}') || {};
            } catch (error) {
                this.widths = {};
            }
        },
        saveWidths() {
            const key = this.storageKey();
            if (!key) return;
            try {
                localStorage.setItem(key, JSON.stringify(this.widths));
            } catch (error) {
                /* 存不下就算了，本次会话内仍然生效。 */
            }
        },
        startResize(column, event) {
            event.preventDefault();
            event.stopPropagation();
            const th = event.currentTarget.closest('th');
            if (!th) return;
            const startX = event.clientX;
            const startWidth = th.getBoundingClientRect().width;
            const move = (moveEvent) => {
                const next = Math.max(72, Math.round(startWidth + moveEvent.clientX - startX));
                this.widths = {...this.widths, [column.key]: next};
            };
            const stop = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', stop);
                document.body.classList.remove('table-resizing');
                this.saveWidths();
            };
            document.body.classList.add('table-resizing');
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', stop);
        },
    },
    template: `
    <div class="table-responsive" role="region" :aria-label="regionLabel || (label + '数据表')" tabindex="0" :aria-busy="loading ? 'true' : 'false'">
        <table class="table data-table table-hover align-middle mb-0">
            <colgroup>
                <col v-if="selectAttr" style="width:3rem">
                <col v-for="(style, index) in colStyles" :key="index" :style="style">
                <col>
            </colgroup>
            <thead><tr>
                <th v-if="selectAttr" scope="col" class="table-selection-column" data-device-selection-column><span class="visually-hidden">选择目标</span></th>
                <th v-for="column in visibleColumns" :key="column.key" scope="col" :data-column-key="column.key" :aria-sort="ariaSort(column)">
                    <a v-if="column.sortable" class="table-sort-link" href="#" :data-sort-key="column.key" @click.prevent="$emit('sort', column)">[[ column.label ]]</a>
                    <template v-else>[[ column.label ]]</template>
                    <span class="table-resize-handle" role="separator" aria-orientation="vertical"
                          :aria-label="'拖动调整「' + column.label + '」列宽'"
                          @mousedown="startResize(column, $event)" @click.stop></span>
                </th>
                <th scope="col" class="table-actions-column table-actions-cell">操作</th>
            </tr></thead>
            <tbody>
                <tr v-for="(row, index) in rows" :key="row.id || index"
                    :class="{'table-active': activeId && row.id === activeId}"
                    style="cursor:pointer" @click="onRowClick(row, $event)">
                    <td v-if="selectAttr" class="table-selection-column" data-device-selection-column>
                        <input class="form-check-input" type="checkbox" name="target_ids" :value="row.id"
                               :form="formId || null" :aria-label="'选择 ' + (row.id || '')" v-bind="{[selectAttr]: ''}">
                    </td>
                    <td v-for="column in visibleColumns" :key="column.key" :data-column-key="column.key">
                        <span v-if="cell(row, column.key).badge" class="badge status-badge" :class="badgeClass(row, column.key)">[[ cell(row, column.key).badge.label ]]</span>
                        <template v-else>[[ cell(row, column.key).text ]]</template>
                    </td>
                    <td class="text-end table-actions-cell"><div class="d-inline-flex gap-2 table-row-actions">
                        <template v-for="(action, actionIndex) in (row.actions || [])" :key="actionIndex">
                            <form v-if="action.kind === 'form'" method="post" :action="action.url" class="d-inline">
                                <input type="hidden" name="csrfmiddlewaretoken" :value="csrf">
                                <input v-for="(value, name) in (action.fields || {})" :key="name" type="hidden" :name="name" :value="value">
                                <button :class="actionClass(action)" type="submit">[[ action.label ]]</button>
                            </form>
                            <button v-else-if="action.kind === 'modal'" type="button" :class="actionClass(action)"
                                    data-bs-toggle="modal" :data-bs-target="action.modal_target ? '#' + action.modal_target : null">[[ action.label ]]</button>
                            <button v-else-if="action.detail_modal" type="button" :class="actionClass(action)"
                                    @click.stop.prevent="onAction(row, action)">[[ action.label ]]</button>
                            <a v-else :class="actionClass(action)" :href="action.url"
                   :data-modal-load="action.modal_target || null"
                   :data-single-device-run="action.single_device_run ? '' : null">[[ action.label ]]</a>
                        </template>
                    </div></td>
                </tr>
                <tr v-if="!rows.length"><td :colspan="columnCount"><div class="empty-state"><strong>[[ emptyTitle ]]</strong><span>[[ emptyMessage ]]</span></div></td></tr>
            </tbody>
        </table>
    </div>`,
};
