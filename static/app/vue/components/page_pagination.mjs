/* 单行翻页：上一页 · 第 [输入框] / N 页 · 下一页。
   全站只有这一份，五个工作区页面都用它。 */

export default {
    delimiters: ['[[', ']]'],
    props: {
        page: {type: Number, default: 1},
        pages: {type: Number, default: 1},
        loading: {type: Boolean, default: false},
        label: {type: String, default: '列表'},
        modelValue: {type: Number, default: 1},
    },
    emits: ['go', 'update:modelValue'],
    data() {
        // 输入值自己拿住：父组件不回写 modelValue 时（纯展示用法）也不会丢。
        return {typed: this.modelValue || this.page};
    },
    watch: {
        page(value) { this.typed = value; },
        modelValue(value) { this.typed = value; },
    },
    computed: {
        jump: {
            get() { return this.typed; },
            set(value) { this.typed = value; this.$emit('update:modelValue', value); },
        },
    },
    methods: {
        go(page) {
            if (page < 1 || page > this.pages || page === this.page) return;
            this.typed = page;
            this.$emit('go', page);
        },
        commit() {
            const page = Math.min(Math.max(Math.trunc(this.typed || 1), 1), this.pages || 1);
            this.typed = page;
            this.$emit('update:modelValue', page);
            if (page !== this.page && page >= 1 && page <= this.pages) this.$emit('go', page);
        },
    },
    template: `
    <nav v-if="pages > 1" class="page-pagination" :aria-label="label + '分页'">
        <div class="page-pagination__actions">
            <button class="btn btn-outline-secondary page-pagination__button" type="button"
                    :disabled="page <= 1 || loading" @click="go(page - 1)">上一页</button>
            <span class="page-pagination__page">第
                <input class="page-pagination__input" type="number" inputmode="numeric" min="1" :max="pages"
                       v-model.number="jump" @keydown.enter.prevent="commit()" @change="commit()"
                       aria-label="输入页码跳转">
                / [[ pages ]] 页</span>
            <button class="btn btn-outline-secondary page-pagination__button" type="button"
                    :disabled="page >= pages || loading" @click="go(page + 1)">下一页</button>
        </div>
    </nav>`,
};
