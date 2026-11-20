/* 顶部大方块。PC 页三张，其它工作区页面一到两张。 */
export default {
    delimiters: ['[[', ']]'],
    props: {
        title: {type: String, default: ''},
        badge: {type: String, default: ''},
        metric: {type: [Number, String], default: 0},
        unit: {type: String, default: ''},
        lines: {type: Array, default: () => []},
        entry: {type: String, default: '查看'},
        latest: {type: String, default: ''},
        latestLabel: {type: String, default: '最新'},
        selected: {type: Boolean, default: false},
    },
    emits: ['select'],
    template: `
    <a class="card surface-card metric-card h-100 w-100 text-start text-body border-0 text-decoration-none"
       href="#" role="tab" :aria-selected="selected ? 'true' : 'false'" @click.prevent="$emit('select')">
        <div class="card-body d-flex flex-column flex-grow-1" style="width:100%">
            <div class="metric-card__status-row mb-3" style="display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;width:100%">
                <h2 class="h5 mb-0">[[ title ]]</h2>
                <span v-if="badge" class="metric-card__ready"><span class="status-dot status-dot--ok"></span>[[ badge ]]</span>
            </div>
            <div class="metric">[[ metric ]]<span class="metric__unit">[[ unit ]]</span></div>
            <div v-for="(line, index) in lines" :key="index" class="metric-card__detail" :class="index === 0 ? 'mt-2' : 'mt-1'">
                <template v-for="(part, partIndex) in line.parts" :key="partIndex">
                    <span v-if="part.tone" :class="'text-' + part.tone">[[ part.text ]]</span>
                    <template v-else>[[ part.text ]]</template>
                </template>
            </div>
            <div class="metric-card__entry mt-auto pt-3" style="text-align:right;width:100%"><span class="metric-card__current">当前 · </span>[[ entry ]]</div>
            <div class="metric-card__latest" style="text-align:right;width:100%">[[ latestLabel ]] [[ latest || '暂无' ]]</div>
        </div>
    </a>`,
};
