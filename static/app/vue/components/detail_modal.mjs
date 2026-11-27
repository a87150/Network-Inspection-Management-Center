/* 详情弹窗：点下去立刻支起弹窗，数据回来再填。
   五个工作区页面共用，URL 不动、页面不刷新。 */
import { api } from '../api.mjs';
import ResourceDetail from '../pages/resource_detail.mjs';

export default {
    delimiters: ['[[', ']]'],
    components: {ResourceDetail},
    props: {
        base: {type: String, default: ''},
        title: {type: String, default: '详情'},
        modalId: {type: String, default: 'workspaceDetailModal'},
    },
    data() {
        return {detail: null, loading: false, error: ''};
    },
    mounted() {
        // 弹窗关闭事件用原生监听：Vue 模板里带点的事件名会被当成修饰符。
        const element = this.$refs.modal;
        if (element) element.addEventListener('hidden.bs.modal', this.close);
    },
    unmounted() {
        const element = this.$refs.modal;
        if (element) element.removeEventListener('hidden.bs.modal', this.close);
    },
    methods: {
        async open(id) {
            if (!id || !this.base || this.loading) return;
            this.loading = true;
            this.error = '';
            this.detail = null;
            this.show();
            /* resource_detail.mjs 的 detailBase() 靠祖先上的 [data-detail-url] 认接口锚点。
               这里是 Vue 侧的弹窗，不写这个属性它就会回落到 window.location.pathname——
               也就是列表页地址，弹窗里对详情表格排序/翻页会打到列表页上，拿不到分区。 */
            const element = this.$refs.modal;
            if (element) element.dataset.detailUrl = this.base + id + '/';
            try {
                this.detail = await api.get(this.base + id + '/detail.json');
            } catch (failure) {
                this.error = failure.message || '详情加载失败';
            } finally {
                this.loading = false;
            }
        },
        show() {
            const element = this.$refs.modal;
            if (!element) return;
            if (window.bootstrap && window.bootstrap.Modal) {
                window.bootstrap.Modal.getOrCreateInstance(element).show();
                return;
            }
            element.classList.add('show');
            element.style.display = 'block';
            element.removeAttribute('aria-hidden');
        },
        close() {
            this.detail = null;
            this.error = '';
        },
    },
    template: `
    <div class="modal fade" :id="modalId" ref="modal" tabindex="-1" :aria-labelledby="modalId + 'Title'" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable modal-shell">
            <div class="modal-content modal-surface">
                <div class="modal-header">
                    <h2 class="modal-title fs-5" :id="modalId + 'Title'">[[ (detail && detail.title) || title ]]</h2>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
                </div>
                <div class="modal-body modal-body--scroll">
                    <p v-if="error" class="alert alert-danger py-2 mb-2" role="alert">[[ error ]]</p>
                    <div v-if="loading" class="detail-skeleton" aria-hidden="true">
                        <div class="detail-skeleton__bar" style="width:38%"></div>
                        <div class="detail-skeleton__bar" style="width:82%"></div>
                        <div class="detail-skeleton__bar" style="width:64%"></div>
                    </div>
                    <resource-detail v-else-if="detail" v-bind="detail"></resource-detail>
                </div>
            </div>
        </div>
    </div>`,
};
