/* 设备状态概览：页头 + 概览条 + 卡片网格 + 巡检任务栏。
   卡片数字全部来自 index/dashboard/views.py 的 items，这里只按 kind 选布局。
   任务栏复用 PC 页那份 TaskBar，翻页走 tasks.json，不动地址栏。 */
import TaskBar from '../components/task_bar.mjs';

/* 同 pc_workspace：跟随 302 拿到登录页 HTML 时 response.ok 仍是 true，
   json() 抛的是 SyntaxError，原始信息对用户没有意义，换成能照着做的提示。 */
function readableFailure(error, fallback) {
    if (error instanceof SyntaxError) return fallback;
    return (error && error.message) || fallback;
}

function stampOf(value) {
    if (!value) return '暂无';
    const text = String(value);
    return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text;
}

export default {
    delimiters: ['[[', ']]'],
    components: {TaskBar},
    props: {
        page: {type: Object, default: () => ({})},
        items: {type: Array, default: () => []},
        taskbar: {type: Object, default: () => ({})},
    },
    data() {
        return {taskData: this.taskbar, taskBusy: false, taskError: ''};
    },
    methods: {
        stampOf,
        isDomain(item) {
            return item.key === 'domain';
        },
        hasDepartmentTotal(item) {
            return Boolean(item.department_total);
        },
        footerStamp(item) {
            return stampOf(item.last_run_at);
        },
        async goTaskPage(page) {
            const endpoint = this.taskData.endpoint;
            if (!endpoint || this.taskBusy) return;
            this.taskBusy = true;
            this.taskError = '';
            try {
                const response = await fetch(endpoint + '?task_page=' + encodeURIComponent(page), {
                    headers: {'X-Requested-With': 'XMLHttpRequest'},
                });
                /* 会话过期时服务端跟随 302 回一个 200 的登录页：ok 为真，
                   json() 却会抛。以前这条 rejection 没人接，等于点了翻页毫无反应；
                   现在两种情况都落到同一句提示上。 */
                if (!response.ok) throw new Error('任务列表加载失败，请刷新页面后重试。');
                this.taskData = {...await response.json(), endpoint};
            } catch (error) {
                this.taskError = readableFailure(error, '任务列表加载失败，请刷新页面后重试。');
            } finally {
                this.taskBusy = false;
            }
        },
        openTask(row) {
            // 行内「查看详情」已经挂了 data-detail-modal，点它就走 base.html 里
            // detail_modal.js 的统一弹窗；直接 location.assign 会把首页状态和
            // 任务栏的翻页位置一起丢掉，还整页重载一遍。
            if (!row || !row.detail_url) return;
            const taskRow = Array.from(this.$el.querySelectorAll('[data-task-id]'))
                .find((element) => element.dataset.taskId === String(row.id));
            const trigger = taskRow && taskRow.querySelector('[data-detail-modal]');
            if (trigger) trigger.click();
        },
    },
    template: `
    <div>
        <header class="page-heading">
            <div class="page-heading__copy">
                <p v-if="page.eyebrow" class="page-heading__eyebrow">[[ page.eyebrow ]]</p>
                <h1 class="page-heading__title">[[ page.title ]]</h1>
                <p v-if="page.description" class="page-heading__description">[[ page.description ]]</p>
            </div>
            <p v-if="page.refreshed_at" class="dashboard-refreshed-at">页面更新于 [[ page.refreshed_at ]]</p>
        </header>

        <section class="dashboard-overview" aria-labelledby="dashboard-overview-title">
            <div>
                <span class="dashboard-overview__label">统一资产视图</span>
                <h2 class="dashboard-overview__title" id="dashboard-overview-title">核心资源状态一屏掌握</h2>
                <p class="dashboard-overview__description">从资产健康、目录状态到最近任务，快速定位需要关注的区域。</p>
            </div>
            <div class="dashboard-overview__shortcut" aria-label="快捷入口">
                <a :href="'/tasks/?object=errors'"><span>异常记录</span><strong>查看待处理项</strong></a>
                <a href="/tasks/"><span>执行中心</span><strong>跟踪后台任务</strong></a>
            </div>
        </section>

        <div class="row g-4 dashboard-grid">
            <div class="col-12 col-md-4" v-for="item in items" :key="item.key">
                <section class="card h-100 surface-card metric-card glass-card"
                         :data-dashboard-card="item.key"
                         :data-dashboard-card-state="item.error ? 'error' : 'ready'">
                    <div class="card-body p-4 d-flex flex-column">
                        <div class="metric-card__status-row d-flex justify-content-between align-items-start mb-3">
                            <h2 class="h5 mb-0">[[ item.name ]]</h2>
                            <span v-if="item.note" class="badge text-bg-secondary">[[ item.note ]]</span>
                            <span v-else-if="!item.error" class="metric-card__ready">
                                <span class="status-dot status-dot--success" aria-hidden="true"></span>数据已加载
                            </span>
                        </div>

                        <div v-if="item.error" class="alert alert-danger metric-card__error mb-0" role="alert">
                            <strong>[[ item.name ]] 统计数据加载失败</strong>
                            <span class="d-block small mt-1">[[ item.error ]]</span>
                        </div>


                        <div v-else-if="isDomain(item)" class="row text-center g-2 metric-card__domain-columns"
                             role="list" aria-label="域控对象统计">
                            <div class="col-4">
                                <div class="metric">[[ item.account_total ]]</div>
                                <div class="metric-label">域账户</div>
                                <div class="metric-card__domain-breakdown flex-column align-items-center">
                                    <span>启用 <strong class="text-success">[[ item.account_normal ]]</strong></span>
                                    <span>停用 <strong class="text-danger">[[ item.account_abnormal ]]</strong></span>
                                </div>
                            </div>
                            <div class="col-4">
                                <div class="metric">[[ item.computer_total ]]</div>
                                <div class="metric-label">域计算机</div>
                                <div class="metric-card__domain-breakdown flex-column align-items-center">
                                    <span>启用 <strong class="text-success">[[ item.computer_normal ]]</strong></span>
                                    <span>停用 <strong class="text-danger">[[ item.computer_abnormal ]]</strong></span>
                                </div>
                            </div>
                            <div class="col-4">
                                <div class="metric">[[ item.group_total ]]</div>
                                <div class="metric-label">域分组</div>
                                <div class="metric-card__domain-breakdown flex-column align-items-center">
                                    <span>安全组 <strong>[[ item.security_group_total ]]</strong></span>
                                    <span>通讯组 <strong>[[ item.distribution_group_total ]]</strong></span>
                                </div>
                            </div>
                        </div>

                        <div v-else class="row text-center g-2 metric-card__metrics" role="list"
                             :aria-label="item.name + '状态统计'">
                            <div class="col-4">
                                <div class="metric">[[ item.total ]]</div>
                                <div class="metric-label">[[ item.total_label ]]</div>
                            </div>
                            <div class="col-4">
                                <div class="metric text-success">[[ item.normal ]]</div>
                                <div class="metric-label">[[ item.normal_label ]]</div>
                            </div>
                            <div class="col-4">
                                <template v-if="hasDepartmentTotal(item)">
                                    <div class="metric">[[ item.department_total ]]</div>
                                    <div class="metric-label">部门数</div>
                                </template>
                                <template v-else>
                                    <div class="metric" :class="item.abnormal ? 'text-danger' : ''">[[ item.abnormal ]]</div>
                                    <div class="metric-label">[[ item.abnormal_label ]]</div>
                                </template>
                            </div>
                        </div>
                    </div>
                    <div v-if="item.primary_action" class="card-footer metric-card__entry metric-card__footer metric-card__actions px-4 pb-4 d-flex gap-2 flex-wrap align-items-center justify-content-end">
                        <div class="metric-card__secondary-actions">
                            <a v-for="action in (item.secondary_actions || [])" :key="action.label"
                               :href="action.url" class="btn btn-outline-secondary btn-sm">[[ action.label ]]</a>
                        </div>
                        <form v-if="item.primary_action.kind === 'form'" method="post"
                              :action="item.primary_action.url" class="d-inline">
                            <input type="hidden" name="csrfmiddlewaretoken" :value="item.primary_action.csrf || ''">
                            <input v-for="(value, name) in (item.primary_action.fields || {})" :key="name"
                                   type="hidden" :name="name" :value="value">
                            <button class="btn btn-primary btn-sm metric-card__primary-action" type="submit">[[ item.primary_action.label ]]</button>
                        </form>
                        <a v-else class="btn btn-primary btn-sm metric-card__primary-action" :href="item.primary_action.url">[[ item.primary_action.label ]]</a>
                        <p v-if="item.last_run_label" class="metric-card__last-run text-secondary mb-0 text-end">
                            [[ item.last_run_label ]]：[[ footerStamp(item) ]]
                        </p>
                    </div>
                </section>
            </div>
        </div>

        <div class="mt-4 dashboard-task-region"
             :class="{'dashboard-task-region--empty': !(taskData.rows || []).length}">
            <p v-if="taskError" class="alert alert-danger py-2" role="alert">[[ taskError ]]</p>
            <task-bar :rows="taskData.rows || []" :count="taskData.count || 0"
                      :page="taskData.page || 1" :pages="taskData.pages || 1"
                      :selected-id="taskData.selected_id || ''"
                      :section-title="taskData.section_title || '巡检任务栏'"
                      :empty-title="taskData.empty_title || '暂无巡检任务'"
                      :busy="taskBusy"
                      @page="goTaskPage" @select="openTask"></task-bar>
        </div>
    </div>`,
};
