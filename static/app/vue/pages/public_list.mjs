/* 访客公开列表页：只读、无权限控件。
   筛选/排序/翻页都在岛内重取 ?fragment=list，不跳转、不改地址栏。 */
import { api } from '../api.mjs';

export default {
    delimiters: ['[[', ']]'],
    props: {
        page: {type: Object, default: () => ({})},
        columns: {type: Array, default: () => []},
        rows: {type: Array, default: () => []},
        q: {type: String, default: ''},
        filter_name: {type: String, default: ''},
        page_sizes: {type: Array, default: () => []},
        page_size: {type: Number, default: 50},
        sort: {type: String, default: 'name'},
        order: {type: String, default: 'asc'},
        previous_url: {type: String, default: ''},
        next_url: {type: String, default: ''},
        search_label: {type: String, default: ''},
        filter_label: {type: String, default: ''},
        size_label: {type: String, default: ''},
        submit_label: {type: String, default: ''},
        empty_message: {type: String, default: ''},
        previous_label: {type: String, default: ''},
        next_label: {type: String, default: ''},
        pagination_label: {type: String, default: ''},
        caption: {type: String, default: ''},
    },
    data() {
        return {
            // 整份 bootstrap 就是首屏状态；筛选/排序/翻页时整体替换。
            state: {...this.$props},
            terms: {q: this.q, filter_name: this.filter_name},
            loading: false,
            error: '',
        };
    },
    methods: {
        value(row, key) {
            const value = row[key];
            if (key === 'is_active') return value ? '在职' : '离职';
            return value === null || value === undefined || value === '' ? '—' : value;
        },
        async load(params) {
            if (this.loading) return;
            this.loading = true;
            this.error = '';
            try {
                const payload = await api.get(window.location.pathname, {...params, fragment: 'list'});
                this.state = payload;
                this.terms = {q: payload.q, filter_name: payload.filter_name};
            } catch (failure) {
                this.error = failure.message || '加载失败';
            } finally {
                this.loading = false;
            }
        },
        /** 服务端已经拼好带安全参数的查询串，这里只把它换成一次岛内请求。 */
        follow(url) {
            if (!url) return;
            this.load(Object.fromEntries(new URLSearchParams(url.slice(1))));
        },
        search() {
            this.load({
                q: this.terms.q,
                filter_name: this.terms.filter_name,
                sort: this.state.sort,
                order: this.state.order,
                page_size: this.state.page_size,
            });
        },
    },
    template: `
    <section class="card surface-card p-4">
        <h1>[[ state.page.title ]]</h1>
        <p class="text-muted">[[ state.page.eyebrow ]] · 共 [[ state.page.count ]] 条</p>
        <form class="row g-3 mb-4" @submit.prevent="search">
            <div class="col-sm"><label class="form-label" for="public-search">[[ state.search_label ]]</label>
                <input class="form-control" id="public-search" v-model.trim="terms.q" maxlength="255"></div>
            <div class="col-sm"><label class="form-label" for="public-name">[[ state.filter_label ]]</label>
                <input class="form-control" id="public-name" v-model.trim="terms.filter_name" maxlength="255"></div>
            <div class="col-sm"><label class="form-label" for="public-size">[[ state.size_label ]]</label>
                <select class="form-select" id="public-size" v-model.number="state.page_size" @change="search">
                    <option v-for="size in state.page_sizes" :key="size" :value="size">[[ size ]]</option>
                </select></div>
            <div class="col-sm-auto align-self-end"><button class="btn btn-primary" type="submit" :disabled="loading">[[ state.submit_label ]]</button></div>
        </form>
        <p v-if="error" class="alert alert-danger py-2" role="alert">[[ error ]]</p>
        <div class="table-responsive"><table class="table table-hover">
            <caption>[[ state.caption ]]</caption>
            <thead><tr><th v-for="column in state.columns" :key="column.key" scope="col">
                <a href="#" @click.prevent="follow(column.url)">[[ column.label ]]</a></th></tr></thead>
            <tbody>
                <tr v-for="(row, index) in state.rows" :key="index">
                    <td v-for="column in state.columns" :key="column.key">[[ value(row, column.key) ]]</td>
                </tr>
                <tr v-if="!state.rows.length"><td :colspan="state.columns.length">[[ state.empty_message ]]</td></tr>
            </tbody>
        </table></div>
        <nav :aria-label="state.pagination_label" class="d-flex gap-3 align-items-center">
            <a href="#" v-if="state.previous_url" @click.prevent="follow(state.previous_url)">[[ state.previous_label ]]</a>
            <span>第 [[ state.page.number ]] / [[ state.page.pages ]] 页</span>
            <a href="#" v-if="state.next_url" @click.prevent="follow(state.next_url)">[[ state.next_label ]]</a>
        </nav>
    </section>`,
};
