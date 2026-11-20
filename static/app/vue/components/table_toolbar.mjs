/* 表格工具栏：筛选栏 + 更多筛选 + 自定义表格 + 结果条。
   自己不请求、不改 URL，筛选条件改完 emit 给页面处理。 */

function defaultValue() { return ''; }

export default {
    delimiters: ['[[', ']]'],
    props: {
        columns: {type: Array, default: () => []},
        filters: {type: Object, default: () => ({})},
        visible: {type: Object, default: () => ({})},
        shownFilters: {type: Object, default: () => ({})},
        count: {type: Number, default: 0},
        from: {type: Number, default: 0},
        to: {type: Number, default: 0},
        pageSize: {type: Number, default: 20},
        pageSizes: {type: Array, default: () => [20, 50, 100, 200]},
        exportUrl: {type: String, default: ''},
        tableKey: {type: String, default: 'table'},
        busy: {type: Boolean, default: false},
    },
    emits: ['apply', 'reset', 'page-size', 'columns-change', 'filters-change'],
    data() {
        return {
            draft: {...this.filters},
            shown: {...this.shownFilters},
            columnsVisible: {...this.visible},
            moreOpen: this.hasActiveOptional(),
        };
    },
    computed: {
        defaultFilters() {
            return this.columns.filter((column) => column.filterable && column.default_filter);
        },
        optionalFilters() {
            return this.columns.filter((column) => column.filterable && !column.default_filter);
        },
        summary() {
            if (!this.count) return '共 0 条，当前无结果';
            return '共 ' + this.count + ' 条，当前显示第 ' + this.from + '–' + this.to + ' 条';
        },
    },
    watch: {
        filters: {
            handler(next) { this.draft = {...next}; },
            deep: true,
        },
        visible: {
            handler(next) { this.columnsVisible = {...next}; },
            deep: true,
        },
    },
    methods: {
        hasActiveOptional() {
            return this.optionalFilters.some((column) => {
                const value = this.filters[column.key];
                return value !== undefined && value !== null && String(value).trim() !== '';
            });
        },
        apply() {
            this.$emit('apply', {...this.draft});
        },
        reset() {
            const blank = {};
            this.columns.forEach((column) => { blank[column.key] = defaultValue(); });
            this.draft = blank;
            this.$emit('reset');
        },
        onColumnToggle(key, checked) {
            this.columnsVisible = {...this.columnsVisible, [key]: checked};
            this.$emit('columns-change', {...this.columnsVisible});
        },
        onFilterToggle(key, checked) {
            this.shown = {...this.shown, [key]: checked};
            this.$emit('filters-change', {...this.shown});
        },
        restoreDefaultTable() {
            const nextColumns = {};
            const nextFilters = {};
            this.columns.forEach((column) => {
                nextColumns[column.key] = column.default_visible !== false;
                nextFilters[column.key] = Boolean(column.default_filter);
            });
            this.columnsVisible = nextColumns;
            this.shown = nextFilters;
            this.$emit('columns-change', nextColumns);
            this.$emit('filters-change', nextFilters);
        },
    },
    template: `
    <form class="table-query-form" @submit.prevent="apply">
        <div class="table-filter-bar">
            <div v-for="column in defaultFilters" :key="column.key" class="table-filter-field">
                <label class="form-label small text-secondary" :for="tableKey + '-' + column.key + '-filter'">[[ column.label ]]</label>
                <input v-if="column.kind === 'number'" class="form-control" type="number" step="any" inputmode="decimal"
                       :id="tableKey + '-' + column.key + '-filter'" v-model="draft[column.key]">
                <input v-else-if="column.kind === 'date'" class="form-control" type="date"
                       :id="tableKey + '-' + column.key + '-filter'" v-model="draft[column.key]">
                <input v-else-if="column.kind === 'datetime'" class="form-control" type="datetime-local"
                       :id="tableKey + '-' + column.key + '-filter'" v-model="draft[column.key]">
                <select v-else-if="column.kind === 'boolean'" class="form-select"
                        :id="tableKey + '-' + column.key + '-filter'" v-model="draft[column.key]">
                    <option value="">全部</option><option value="true">是</option><option value="false">否</option>
                </select>
                <input v-else class="form-control" type="text"
                       :id="tableKey + '-' + column.key + '-filter'" v-model="draft[column.key]">
            </div>
            <div class="table-filter-actions">
                <button class="btn btn-primary text-nowrap d-inline-flex align-items-center justify-content-center" type="submit" :disabled="busy">筛选</button>
                <button class="btn btn-outline-secondary text-nowrap d-inline-flex align-items-center justify-content-center" type="button" @click="reset">重置查询</button>
                <a v-if="exportUrl" class="btn btn-outline-success text-nowrap d-inline-flex align-items-center justify-content-center" :href="exportUrl">导出筛选结果</a>
            </div>
        </div>

        <details v-if="optionalFilters.length" class="table-more-filters" :open="moreOpen">
            <summary>更多筛选</summary>
            <div class="table-more-filters__grid">
                <template v-for="column in optionalFilters" :key="column.key">
                    <div v-if="shown[column.key] || draft[column.key]" class="table-filter-field">
                        <label class="form-label small text-secondary" :for="tableKey + '-' + column.key + '-more'">[[ column.label ]]</label>
                        <input v-if="column.kind === 'number'" class="form-control" type="number" step="any" inputmode="decimal"
                               :id="tableKey + '-' + column.key + '-more'" v-model="draft[column.key]">
                        <input v-else-if="column.kind === 'date'" class="form-control" type="date"
                               :id="tableKey + '-' + column.key + '-more'" v-model="draft[column.key]">
                        <input v-else-if="column.kind === 'datetime'" class="form-control" type="datetime-local"
                               :id="tableKey + '-' + column.key + '-more'" v-model="draft[column.key]">
                        <select v-else-if="column.kind === 'boolean'" class="form-select"
                                :id="tableKey + '-' + column.key + '-more'" v-model="draft[column.key]">
                            <option value="">全部</option><option value="true">是</option><option value="false">否</option>
                        </select>
                        <input v-else class="form-control" type="text"
                               :id="tableKey + '-' + column.key + '-more'" v-model="draft[column.key]">
                    </div>
                </template>
            </div>
        </details>

        <details class="table-config">
            <summary>自定义表格</summary>
            <div class="table-config__grid">
                <fieldset>
                    <legend>显示列</legend>
                    <div class="d-flex flex-wrap gap-3">
                        <label v-for="column in columns" :key="column.key" class="form-check">
                            <input class="form-check-input" type="checkbox" :checked="columnsVisible[column.key] !== false"
                                   @change="onColumnToggle(column.key, $event.target.checked)">
                            <span class="form-check-label">[[ column.label ]]</span>
                        </label>
                    </div>
                </fieldset>
                <fieldset>
                    <legend>显示筛选项</legend>
                    <div class="d-flex flex-wrap gap-3">
                        <label v-for="column in columns.filter((item) => item.filterable)" :key="column.key" class="form-check">
                            <input class="form-check-input" type="checkbox" :checked="shown[column.key] !== false"
                                   @change="onFilterToggle(column.key, $event.target.checked)">
                            <span class="form-check-label">[[ column.label ]]</span>
                        </label>
                    </div>
                </fieldset>
                <div class="table-config__reset">
                    <button class="btn btn-outline-secondary btn-sm" type="button" @click="restoreDefaultTable">恢复默认表格</button>
                </div>
            </div>
        </details>

        <div class="table-result-bar">
            <p class="small text-secondary mb-0" aria-live="polite">[[ summary ]]</p>
            <div class="table-result-bar__page-size">
                <label class="small text-secondary text-nowrap mb-0" :for="tableKey + '-page-size'">每页条数</label>
                <select class="form-select form-select-sm" :id="tableKey + '-page-size'" :value="pageSize"
                        @change="$emit('page-size', Number($event.target.value))">
                    <option v-for="size in pageSizes" :key="size" :value="size">[[ size ]]</option>
                </select>
            </div>
        </div>
    </form>`,
};
