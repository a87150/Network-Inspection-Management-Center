/* 表格工具栏：筛选栏 + 更多筛选 + 自定义表格 + 结果条。
   自己不请求、不改 URL，筛选条件改完 emit 给页面处理。 */

/** 每种字段的空值形状不同：数值是 {op,value}，日期是 {from,to}。 */
function defaultValue(column) {
    if (column.kind === 'number') return {op: 'gt', value: ''};
    if (column.kind === 'date' || column.kind === 'datetime') return {from: '', to: ''};
    return '';
}

/* 一个筛选字段：数值带比较方式、日期带起止两端、选择型带候选，
   默认筛选区和「更多筛选」共用同一份，避免两处各写一套后行为漂移。 */
const FilterField = {
    delimiters: ['[[', ']]'],
    props: {
        column: {type: Object, required: true},
        modelValue: {type: [String, Number, Object], default: ''},
        idBase: {type: String, required: true},
    },
    emits: ['update:modelValue'],
    computed: {
        bundle() {
            const value = this.modelValue;
            return value !== null && typeof value === 'object' ? value : {};
        },
        text() {
            return this.bundle.value !== undefined ? this.bundle.value : (this.modelValue || '');
        },
        op() { return this.bundle.op || 'gt'; },
        from() { return this.bundle.from || ''; },
        to() { return this.bundle.to || ''; },
    },
    methods: {
        setText(next) {
            if (this.column.kind === 'number') {
                this.$emit('update:modelValue', {...this.bundle, op: this.op, value: next});
                return;
            }
            this.$emit('update:modelValue', next);
        },
        /** 候选下拉选中即写入输入框，然后把下拉复位回「候选」。 */
        pickSuggestion(event) {
            const value = event.target.value;
            event.target.value = '';
            if (value !== '') this.setText(value);
        },
        setOp(next) {
            this.$emit('update:modelValue', {...this.bundle, op: next, value: this.text});
        },
        setBound(key, next) {
            this.$emit('update:modelValue', {...this.bundle, [key]: next});
        },
    },
    template: `
    <div v-if="column.kind === 'number'" class="input-group table-number-filter">
        <select class="form-select table-number-filter__op" :id="idBase + '-op'" :value="op"
                @change="setOp($event.target.value)" aria-label="比较方式">
            <option value="gt">大于</option><option value="lt">小于</option><option value="eq">等于</option>
        </select>
        <input class="form-control" type="number" step="any" inputmode="decimal" :id="idBase"
               :value="text" @input="setText($event.target.value)" aria-label="数值">
    </div>
    <div v-else-if="column.kind === 'date' || column.kind === 'datetime'" class="input-group">
        <input class="form-control" type="date" :id="idBase + '-from'" :value="from"
               @input="setBound('from', $event.target.value)" aria-label="开始日期">
        <span class="input-group-text">至</span>
        <input class="form-control" type="date" :id="idBase + '-to'" :value="to"
               @input="setBound('to', $event.target.value)" aria-label="结束日期">
    </div>
    <select v-else-if="column.kind === 'boolean'" class="form-select" :id="idBase" :value="text"
            @change="setText($event.target.value)">
        <option value="">全部</option><option value="true">是</option><option value="false">否</option>
    </select>
    <select v-else-if="column.optionMode === 'fixed' && column.options.length" class="form-select"
            :id="idBase" :value="text" @change="setText($event.target.value)">
        <option value="">全部</option>
        <option v-for="option in column.options" :key="option.value" :value="option.value">[[ option.label ]]</option>
    </select>
    <div v-else-if="column.optionMode === 'distinct' || column.optionMode === 'suggest'"
         class="table-filter-combo" style="display:flex;gap:.5rem">
        <input class="form-control" type="text" autocomplete="off" :id="idBase" :value="text"
               @input="setText($event.target.value)">
        <!-- 和图例一致：左边自由输入，右边下拉挑库里已有的值。 -->
        <select class="form-select table-filter-suggestion-select" :value="''"
                :aria-label="column.label + ' 候选'" @change="pickSuggestion($event)">
            <option value="">候选</option>
            <option v-for="option in column.options" :key="option.value" :value="option.value">[[ option.label ]]</option>
        </select>
    </div>
    <input v-else class="form-control" type="text" :id="idBase" :value="text"
           @input="setText($event.target.value)">`,
};

export default {
    delimiters: ['[[', ']]'],
    components: {FilterField},
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
        // 勾选的显示列数量；0 表示没勾，导出会退回全部列。
        exportColumnCount: {type: Number, default: 0},
        tableKey: {type: String, default: 'table'},
        busy: {type: Boolean, default: false},
        selectable: {type: Boolean, default: false},
        configurationHref: {type: String, default: ''},
        selectedCount: {type: Number, default: 0},
    },
    emits: ['apply', 'reset', 'page-size', 'columns-change', 'filters-change',
            'select-all', 'select-invert'],
    data() {
        return {
            draft: {...this.filters},
            shown: {...this.shownFilters},
            columnsVisible: {...this.visible},
            moreOpen: false,
        };
    },
    created() {
        // data() 阶段 computed 还没就绪，这里读 optionalFilters 才是安全的。
        this.moreOpen = this.hasActiveOptional();
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
                if (value !== null && typeof value === 'object') {
                    return Object.keys(value).some((key) => !key.startsWith('_')
                        && String(value[key] === null || value[key] === undefined ? '' : value[key]).trim() !== '');
                }
                return value !== undefined && value !== null && String(value).trim() !== '';
            });
        },
        apply() {
            this.$emit('apply', {...this.draft});
        },
        reset() {
            const blank = {};
            this.columns.forEach((column) => { blank[column.key] = defaultValue(column); });
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
            <div v-for="column in defaultFilters" :key="column.key" class="table-filter-field"
                 v-show="shown[column.key] !== false">
                <label class="form-label small text-secondary" :for="tableKey + '-' + column.key + '-filter'">[[ column.label ]]</label>
                <filter-field :column="column" :id-base="tableKey + '-' + column.key + '-filter'"
                              v-model="draft[column.key]"></filter-field>
            </div>
            <div class="table-filter-actions">
                <button class="btn btn-primary text-nowrap d-inline-flex align-items-center justify-content-center" type="submit" :disabled="busy">筛选</button>
                <button class="btn btn-outline-secondary text-nowrap d-inline-flex align-items-center justify-content-center" type="button" @click="reset">重置查询</button>
                <button v-if="selectable" class="btn btn-outline-primary text-nowrap d-inline-flex align-items-center justify-content-center"
                        type="button" data-device-select-all @click="$emit('select-all')">全选</button>
                <button v-if="selectable" class="btn btn-outline-secondary text-nowrap d-inline-flex align-items-center justify-content-center"
                        type="button" data-device-select-invert @click="$emit('select-invert')">反选</button>
                <a v-if="exportUrl" class="btn btn-outline-success text-nowrap d-inline-flex align-items-center justify-content-center"
                   :href="exportUrl" data-filtered-export
                   :title="exportColumnCount ? '只导出当前勾选的显示列' : '没有勾选任何显示列，将导出全部列'"
                   :data-export-columns="exportColumnCount">[[ exportColumnCount ? '导出筛选结果' : '导出全部列' ]]</a>
                <slot name="actions"></slot>
                <a v-if="configurationHref" :class="['btn', 'btn-outline-primary', 'text-nowrap', 'd-inline-flex', 'align-items-center', 'justify-content-center', selectedCount ? '' : 'disabled']"
                   :href="selectedCount ? configurationHref : '#'" data-selected-config-export
                   :aria-disabled="selectedCount ? 'false' : 'true'" :tabindex="selectedCount ? null : -1"
                >[[ selectedCount ? ('下载所选配置（' + selectedCount + '）') : '请先选择设备' ]]</a>
            </div>
            <div v-if="configurationHref" class="alert alert-danger table-action-feedback mb-0"
                 role="alert" aria-live="assertive" data-configuration-export-feedback hidden></div>
        </div>

        <details v-if="optionalFilters.length" class="table-more-filters" :open="moreOpen">
            <summary>更多筛选</summary>
            <div class="table-more-filters__grid">
                <template v-for="column in optionalFilters" :key="column.key">
                    <div v-if="shown[column.key] || draft[column.key]" class="table-filter-field">
                        <label class="form-label small text-secondary" :for="tableKey + '-' + column.key + '-more'">[[ column.label ]]</label>
                        <filter-field :column="column" :id-base="tableKey + '-' + column.key + '-more'"
                                      v-model="draft[column.key]"></filter-field>
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
