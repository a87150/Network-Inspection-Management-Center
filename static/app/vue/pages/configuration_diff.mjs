/* 配置版本对比页：一份 bootstrap JSON 渲染整页。
   「与其它版本对比」只重取 ?fragment=diff，不跳转、不改地址栏。 */
import { api } from '../api.mjs';

export default {
    delimiters: ['[[', ']]'],
    props: {
        page: {type: Object, default: () => ({})},
        columns: {type: Array, default: () => []},
        region_label: {type: String, default: ''},
        current_id: {type: String, default: ''},
        against_id: {type: String, default: ''},
        versions: {type: Array, default: () => []},
        older: {type: Object, default: () => ({})},
        newer: {type: Object, default: () => ({})},
        change_label: {type: String, default: ''},
        change_badge: {type: Object, default: () => ({})},
        switch_label: {type: String, default: ''},
        truncated_message: {type: String, default: ''},
        rows: {type: Array, default: () => []},
        empty_title: {type: String, default: ''},
        empty_message: {type: String, default: ''},
    },
    data() {
        return {
            // 整份 bootstrap 就是首屏状态；换对比版本时整体替换。
            state: {...this.$props},
            selected: this.against_id,
            loading: false,
            error: '',
        };
    },
    computed: {
        hasAgainst() {
            return Boolean(this.state.against_id);
        },
    },
    methods: {
        async switchTo() {
            if (this.loading || !this.selected) return;
            this.loading = true;
            this.error = '';
            try {
                const payload = await api.get(window.location.pathname, {
                    fragment: 'diff',
                    against: this.selected,
                });
                this.state = payload;
                this.selected = payload.against_id;
            } catch (failure) {
                this.error = failure.message || '对比失败';
            } finally {
                this.loading = false;
            }
        },
        gutter(row, key) {
            const value = row[key];
            return value === null || value === undefined ? '' : value;
        },
    },
    template: `
    <div>
        <header class="page-heading">
            <div class="page-heading__copy">
                <p class="page-heading__eyebrow">[[ state.page.eyebrow ]]</p>
                <h1 class="page-heading__title">[[ state.page.title ]]</h1>
                <p class="page-heading__description">[[ state.page.description ]]</p>
            </div>
            <div class="page-heading__actions">
                <a class="btn btn-outline-secondary" :href="state.page.back_url">[[ state.page.back_label ]]</a>
            </div>
        </header>

        <p v-if="error" class="alert alert-danger py-2" role="alert">[[ error ]]</p>

        <template v-if="hasAgainst">
            <section class="card surface-card configuration-diff-summary" aria-label="对比结果摘要">
                <div class="card-body">
                    <div class="configuration-diff-versions">
                        <div><span class="configuration-diff-label">[[ state.older.label ]]</span><strong>[[ state.older.date ]]</strong><span class="text-secondary">[[ state.older.stamp ]]</span></div>
                        <div><span class="configuration-diff-label">[[ state.newer.label ]]</span><strong>[[ state.newer.date ]]</strong><span class="text-secondary">[[ state.newer.stamp ]]</span></div>
                        <div><span class="configuration-diff-label">[[ state.change_label ]]</span>
                            <span class="status-badge" :class="'status-badge--' + state.change_badge.tone">[[ state.change_badge.label ]]</span>
                        </div>
                    </div>
                    <form v-if="state.versions.length" class="configuration-diff-switch" @submit.prevent="switchTo">
                        <label for="configuration-diff-against" class="form-label">[[ state.switch_label ]]</label>
                        <select id="configuration-diff-against" class="form-select" v-model="selected" @change="switchTo" :disabled="loading">
                            <option v-for="version in state.versions" :key="version.value" :value="version.value">[[ version.label ]]</option>
                        </select>
                    </form>
                </div>
            </section>

            <div v-if="state.truncated_message" class="alert alert-warning" role="alert">[[ state.truncated_message ]]</div>
            <section class="card surface-card configuration-diff-table" aria-label="配置差异明细">
                <div class="card-header surface-card__header"><h2 class="h5 mb-0">差异明细</h2></div>
                <div class="table-responsive" role="region" :aria-label="state.region_label" tabindex="0">
                    <table class="table data-table configuration-diff mb-0">
                        <caption class="visually-hidden">逐行对比，左列为旧版本行号，右列为新版本行号</caption>
                        <thead><tr>
                            <th v-for="column in state.columns" :key="column.key" scope="col"
                                :class="column.gutter ? 'configuration-diff-gutter' : null">[[ column.label ]]</th>
                        </tr></thead>
                        <tbody>
                            <tr v-for="(row, index) in state.rows" :key="index"
                                class="configuration-diff-row" :class="'configuration-diff-row--' + row.kind">
                                <td class="configuration-diff-gutter">[[ gutter(row, 'left') ]]</td>
                                <td class="configuration-diff-gutter">[[ gutter(row, 'right') ]]</td>
                                <td class="configuration-diff-code"><code>[[ row.text ]]</code></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </template>
        <section v-else class="card surface-card"><div class="card-body"><div class="empty-state">
            <strong>[[ state.empty_title ]]</strong>
            <span>[[ state.empty_message ]]</span>
        </div></div></section>
    </div>`,
};
