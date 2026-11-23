/* 通用详情：标题 + 动作 + 分区。分区种类由后端 payload 决定。 */
import PagePagination from '../components/page_pagination.mjs';

const CELL_TEXT = (cell) => (cell && typeof cell === 'object' ? (cell.text || '') : (cell ?? ''));

export default {
    delimiters: ['[[', ']]'],
    components: {PagePagination},
    props: {
        eyebrow: {type: String, default: ''},
        title: {type: String, default: ''},
        description: {type: String, default: ''},
        actions: {type: Array, default: () => []},
        sections: {type: Array, default: () => []},
        notice: {type: String, default: ''},
        disclosure: {type: Object, default: null},
        csrf: {type: String, default: ''},
    },
    data() {
        return {
            // POST 之后回跳用的还是宿主页面地址，跟弹窗内重载无关。
            locationPath: window.location.pathname + window.location.search,
            // 岛内重载回来的分区；只在弹窗/整页自己的 fetch 里更新，不碰 location。
            liveSections: null,
            reloading: false,
        };
    },
    computed: {
        viewSections() {
            return this.liveSections || this.sections;
        },
        alerts() {
            return this.viewSections.filter((section) => section.kind === 'alert');
        },
        blocks() {
            return this.viewSections.filter((section) => section.kind !== 'alert');
        },
        /** 带表格的详情页用单列：统计方块在上，表格通栏在下。 */
        stacked() {
            return this.blocks.some((section) => section.kind === 'table');
        },
    },
    watch: {
        // 宿主换了一份详情数据：上一次翻页拿到的分区不能留在屏幕上。
        sections() {
            this.liveSections = null;
        },
    },
    methods: {
        badgeClass(badge) {
            return badge.class || ('text-bg-' + (badge.tone || 'info'));
        },
        actionClass(variant) {
            if (variant === 'primary') return 'btn btn-primary';
            if (variant === 'success') return 'btn btn-outline-success';
            if (variant === 'danger') return 'btn btn-outline-danger';
            return 'btn btn-outline-secondary';
        },
        cellText(cell) {
            return CELL_TEXT(cell);
        },
        isObject(cell) {
            return Boolean(cell) && typeof cell === 'object';
        },
        /** 详情页自身地址：弹窗里由 detail_modal.js 写在 data-detail-url，独立页就是当前地址。 */
        detailBase() {
            const host = this.$el && this.$el.closest && this.$el.closest('[data-detail-url]');
            const raw = (host && host.dataset.detailUrl) || window.location.pathname;
            const cut = raw.indexOf('?');
            return cut === -1 ? raw : raw.slice(0, cut);
        },
        /** 岛内重载：接口地址只用来取数据，地址栏和弹窗层级都不动。 */
        async reloadSections(url) {
            if (!url || this.reloading) return;
            const bootstrapId = this.$el && this.$el.dataset.vueBootstrap;
            this.reloading = true;
            try {
                const response = await fetch(url, {headers: {'X-Requested-With': 'XMLHttpRequest'}});
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const page = new DOMParser().parseFromString(await response.text(), 'text/html');
                const node = bootstrapId ? page.getElementById(bootstrapId) : null;
                const payload = node ? JSON.parse(node.textContent || '{}') : null;
                if (!payload || !Array.isArray(payload.sections)) throw new Error('响应里没有详情数据');
                this.liveSections = payload.sections;
            } catch (error) {
                console.error('详情分区刷新失败：', error);
            } finally {
                this.reloading = false;
            }
        },
        /** 换页、排序、筛选都只重载分区内容，不整页跳、不改地址栏。 */
        reloadWith(query) {
            return this.reloadSections(this.detailBase() + (query || ''));
        },
        sortHref(column) {
            return this.detailBase() + column.sort_url;
        },
        applyFilters(event) {
            const params = new URLSearchParams();
            for (const field of event.target.querySelectorAll('[name]')) {
                const value = (field.value || '').trim();
                if (value) params.set(field.name, value);
            }
            const query = params.toString();
            this.reloadWith(query ? '?' + query : '');
        },
        goSectionPage(section, page) {
            // page_url 只是接口锚点：它指向当前详情页，返回值里带着新的一页分区。
            const base = section.pagination && section.pagination.page_url;
            if (!base) return null;
            return this.reloadSections(base + page);
        },
        /** 返回列表：弹窗里就地关掉（列表本来就在下面），独立详情页上照常导航。 */
        closeAction(event) {
            const modal = this.$el && this.$el.closest && this.$el.closest('.modal');
            if (!modal) return;
            event.preventDefault();
            if (window.bootstrap && window.bootstrap.Modal) {
                window.bootstrap.Modal.getOrCreateInstance(modal).hide();
            }
        },
    },
    template: `
    <div class="resource-detail">
        <header class="page-heading">
            <div class="page-heading__copy">
                <p v-if="eyebrow" class="page-heading__eyebrow">[[ eyebrow ]]</p>
                <h1 class="page-heading__title">[[ title ]]</h1>
                <p v-if="description" class="page-heading__description">[[ description ]]</p>
            </div>
            <div v-if="actions.length" class="page-heading__actions">
                <template v-for="(action, index) in actions" :key="index">
                    <form v-if="action.kind === 'form'" method="post" :action="action.url" :data-confirm-message="action.confirm || null">
                        <input type="hidden" name="csrfmiddlewaretoken" :value="csrf">
                        <input type="hidden" name="next" :value="locationPath">
                        <button :class="actionClass(action.variant)" type="submit">[[ action.label ]]</button>
                    </form>
                    <a v-else-if="action.kind === 'detail'" :class="actionClass(action.variant)" :href="action.url"
                       :data-detail-modal="action.url">[[ action.label ]]</a>
                    <a v-else-if="action.kind === 'close'" :class="actionClass(action.variant)" :href="action.url"
                       data-detail-close @click="closeAction($event)">[[ action.label ]]</a>
                    <a v-else :class="actionClass(action.variant)" :href="action.url">[[ action.label ]]</a>
                </template>
            </div>
        </header>
        <div v-if="notice" class="alert alert-warning">[[ notice ]]</div>
        <div v-for="(section, index) in alerts" :key="'alert-' + index" class="resource-detail__alert"
             :class="'alert alert-' + section.level" role="alert">[[ section.text ]]</div>
        <div class="resource-detail__grid" :class="{'resource-detail__grid--stacked': stacked}">
            <section v-for="section in blocks" :key="section.heading" class="card surface-card">
                <div v-if="section.heading" class="card-header surface-card__header"><h2 class="h5 mb-0">[[ section.heading ]]</h2></div>
                <div class="card-body">
                    <div v-if="section.kind === 'table' && section.filters && section.filters.length" class="table-toolbar">
                    <form class="table-query-form" role="search" @submit.prevent="applyFilters($event)">
                        <div class="table-filter-bar">
                            <div v-for="control in section.filters" :key="control.key" class="table-filter-field">
                                <label class="form-label small text-secondary" :for="'filter-' + control.key">[[ control.label ]]</label>
                                <select v-if="control.kind === 'boolean' || (control.options && control.options.length)"
                                        class="form-select" :id="'filter-' + control.key" :name="'filter_' + control.key">
                                    <option value="">全部</option>
                                    <template v-for="option in (control.options || [])" :key="option.value || option">
                                        <option v-if="control.kind !== 'boolean'" :value="option.value || option"
                                                :selected="String(control.value) === String(option.value || option)">[[ option.label || option ]]</option>
                                    </template>
                                    <template v-if="control.kind === 'boolean'">
                                        <option value="true" :selected="control.value === 'true'">是</option>
                                        <option value="false" :selected="control.value === 'false'">否</option>
                                    </template>
                                </select>
                                <input v-else class="form-control" type="text"
                                       :id="'filter-' + control.key" :name="'filter_' + control.key"
                                       :value="control.value">
                            </div>
                            <div class="table-filter-actions">
                                <button class="btn btn-primary text-nowrap d-inline-flex align-items-center justify-content-center" type="submit">筛选</button>
                                <button class="btn btn-outline-secondary text-nowrap d-inline-flex align-items-center justify-content-center" type="button" @click="reloadWith('')">重置查询</button>
                            </div>
                        </div>
                    </form>
                    </div>
                    <p v-if="section.kind === 'table' && section.note" class="small text-secondary">[[ section.note ]]</p>
                    <div v-if="section.kind === 'table'" class="table-responsive" role="region" :aria-label="section.heading" tabindex="0"
                         :data-table-workspace="section.workspace || null" :data-table-key="section.workspace || null">
                        <table class="table data-table mb-0">
                            <thead>
                                <tr>
                                    <th v-for="(column, columnIndex) in section.columns" :key="columnIndex" scope="col" :aria-sort="column.aria_sort || null">
                                        <a v-if="column.sort_url" class="table-sort-link"
                                           :aria-sort="column.aria_sort" :href="sortHref(column)"
                                           @click.prevent="reloadWith(column.sort_url)">[[ column.label ]]</a>
                                        <template v-else>[[ column.label ]]</template>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="(row, rowIndex) in section.rows" :key="rowIndex">
                                    <td v-for="(cell, cellIndex) in row" :key="cellIndex">
                                        <template v-if="isObject(cell)">
                                            <span v-if="cell.badge" class="badge status-badge" :class="badgeClass(cell.badge)" :data-status="cell.badge.status">[[ cell.badge.label ]]</span>
                                            <span v-if="cell.text">[[ cell.text ]]</span>
                                            <a v-if="cell.url" class="btn btn-outline-primary btn-sm" :href="cell.url">[[ cell.label || '查看' ]]</a>
                                            <div v-if="cell.note" class="small text-secondary mt-1">[[ cell.note ]]</div>
                                        </template>
                                        <template v-else>[[ cell ]]</template>
                                    </td>
                                </tr>
                                <tr v-if="!section.rows.length"><td :colspan="section.columns.length">[[ section.empty ]]</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <page-pagination v-if="section.pagination && section.pagination.pages"
                                     :page="section.pagination.page" :pages="section.pagination.pages"
                                     :model-value="section.pagination.page" :label="section.heading"
                                     :loading="reloading" @go="goSectionPage(section, $event)"></page-pagination>
                    <nav v-else-if="section.pagination" class="d-flex align-items-center gap-3 small mt-3" aria-label="分页">
                        <a v-if="section.pagination.prev_url" :href="section.pagination.prev_url"
                           @click.prevent="reloadWith(section.pagination.prev_url)">上一页</a>
                        <span>[[ section.pagination.label ]]</span>
                        <a v-if="section.pagination.next_url" :href="section.pagination.next_url"
                           @click.prevent="reloadWith(section.pagination.next_url)">下一页</a>
                    </nav>
                    <template v-if="section.kind === 'groups'">
                        <p v-if="section.summary" class="text-secondary">[[ section.summary ]]</p>
                        <div v-for="group in section.groups" :key="group.title" class="card surface-card status-surface mb-3">
                            <div class="card-header surface-card__header d-flex align-items-center justify-content-between gap-2">
                                <strong>[[ group.title ]]</strong>
                                <span class="status-badge status-badge--neutral">[[ group.count ]] 项</span>
                            </div>
                            <ul class="list-group list-group-flush">
                                <li v-for="(item, itemIndex) in group.items" :key="itemIndex" class="list-group-item">
                                    <span v-if="item.badge" class="badge status-badge" :class="badgeClass(item.badge)" :data-status="item.badge.status">[[ item.badge.label ]]</span>
                                    <strong>[[ item.label ]]</strong>
                                    <div class="text-secondary mt-1">[[ item.detail ]]</div>
                                </li>
                            </ul>
                        </div>
                    </template>
                    <div v-if="section.kind === 'metrics'" class="row g-3">
                        <div class="col-6 col-lg-3" v-for="metric in section.metrics" :key="metric.label">
                            <div class="card surface-card h-100"><div class="card-body">
                                <div class="metric-label">[[ metric.label ]]</div>
                                <div class="fs-5 fw-semibold mb-0">[[ metric.value ]]</div>
                            </div></div>
                        </div>
                    </div>
                    <dl v-if="section.kind === 'fields'" class="row mb-0">
                        <template v-for="field in section.fields" :key="field.label">
                            <dt class="col-sm-4 col-lg-3 text-secondary">[[ field.label ]]</dt>
                            <dd class="col-sm-8 col-lg-9">
                                <span v-if="field.badge" class="badge status-badge" :class="badgeClass(field.badge)" :data-status="field.badge.status">[[ field.badge.label ]]</span>
                                <template v-else>[[ field.value ]]</template>
                            </dd>
                        </template>
                    </dl>
                    <div v-if="section.kind === 'list'" class="list-group list-group-flush">
                        <div v-for="(item, index) in section.items" :key="index" class="list-group-item px-0">
                            <div class="d-flex justify-content-between gap-2">
                                <strong>[[ item.label ]]</strong>
                                <span v-if="item.badge" class="badge status-badge" :class="badgeClass(item.badge)" :data-status="item.badge.status">[[ item.badge.label ]]</span>
                            </div>
                            <div v-if="item.meta" class="small text-secondary">[[ item.meta ]]</div>
                            <div v-if="item.detail" class="small text-break mt-1">[[ item.detail ]]</div>
                            <a v-if="item.url" :href="item.url" class="small">[[ item.action || '查看详情' ]]</a>
                        </div>
                        <p v-if="!section.items.length" class="text-secondary mb-0">[[ section.empty || '暂无内容' ]]</p>
                    </div>
                    <template v-if="section.kind === 'form'">
                        <p v-if="section.note" class="text-secondary">[[ section.note ]]</p>
                        <dl class="row small mb-0">
                            <template v-for="field in section.fields" :key="field.label">
                                <dt class="col-sm-3">[[ field.label ]]</dt>
                                <dd class="col-sm-9 mb-0">[[ field.value ]]</dd>
                            </template>
                        </dl>
                        <form method="post" :action="section.submit.url" class="d-flex flex-wrap gap-2 align-items-end mt-3"
                              :data-confirm-message="section.submit.confirm || null">
                            <input type="hidden" name="csrfmiddlewaretoken" :value="csrf">
                            <div v-for="input in section.inputs" :key="input.name">
                                <label class="visually-hidden" :for="'field-' + input.name">[[ input.label ]]</label>
                                <input class="form-control form-control-sm" :type="input.type || 'text'" :id="'field-' + input.name"
                                       :name="input.name" :autocomplete="input.autocomplete || 'off'" :placeholder="input.label">
                            </div>
                            <button :class="actionClass(section.submit.variant)" type="submit">[[ section.submit.label ]]</button>
                        </form>
                    </template>
                    <div v-if="section.kind === 'text'">
                        <div class="detail-text">[[ section.text ]]</div>
                        <a v-if="section.link" class="btn btn-outline-secondary btn-sm mt-3" :href="section.link.url">[[ section.link.label ]]</a>
                    </div>
                </div>
            </section>
        </div>
        <details v-if="disclosure" class="card surface-card card-body mt-3">
            <summary>[[ disclosure.heading ]]</summary>
            <pre class="json-view text-wrap text-break">[[ disclosure.text ]]</pre>
        </details>
    </div>`,
};
