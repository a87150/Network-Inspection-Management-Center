/* IP 管理页的「增加 IP 段」：本页弹窗，提交走 REST，成功后刷新台账。 */
import { api } from '../api.mjs';

const EMPTY = () => ({
    cidr: '',
    purpose: 'office',
    vlan: '',
    gateway: '',
    pool_start: '',
    pool_end: '',
    note: '',
});

export default {
    delimiters: ['[[', ']]'],
    props: {
        endpoint: {type: String, default: '/api/v1/ip-subnets/'},
        purposes: {type: Array, default: () => []},
        can_administer: {type: Boolean, default: false},
    },
    data() {
        return {
            open: false,
            submitting: false,
            message: '',
            errors: {},
            form: EMPTY(),
            // 打开弹窗时焦点在哪：关窗要还回去，否则键盘用户被丢到页面顶部。
            returnFocusTo: null,
        };
    },
    mounted() {
        // 弹窗是自绘的，Bootstrap 那套 Esc 与焦点圈闭都不在，得自己接键盘。
        document.addEventListener('keydown', this.onKeydown);
    },
    unmounted() {
        document.removeEventListener('keydown', this.onKeydown);
    },
    methods: {
        show() {
            this.form = EMPTY();
            this.message = '';
            this.errors = {};
            this.returnFocusTo = typeof document !== 'undefined' ? document.activeElement : null;
            this.open = true;
            // 节点是 v-if 渲染的，等这一帧画完才有东西可聚焦。
            this.$nextTick(() => this.focusFirst());
        },
        hide() {
            if (this.submitting) return;
            this.closeModal();
        },
        /** 关窗的唯一出口：收起节点 + 把焦点还给触发按钮。 */
        closeModal() {
            this.open = false;
            const target = this.returnFocusTo;
            this.returnFocusTo = null;
            if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
        },
        /** 弹窗内可聚焦的控件，Tab 圈闭用它排队。 */
        focusable() {
            const root = this.$refs.dialog;
            if (!root || !root.querySelectorAll) return [];
            return Array.from(root.querySelectorAll(
                'a[href], button:not([disabled]), input:not([disabled]), '
                + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            ));
        },
        focusFirst() {
            const list = this.focusable();
            // 首个输入框比右上角关闭按钮有用：打开弹窗就是要填网段。
            const field = list.find((node) => /^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName || ''));
            const target = field || list[0];
            if (target) target.focus();
        },
        onKeydown(event) {
            if (!this.open) return;
            if (event.key === 'Escape' || event.key === 'Esc') {
                // 提交中不许关，和 hide() 同一道闸。
                if (this.submitting) return;
                event.preventDefault();
                this.hide();
                return;
            }
            if (event.key !== 'Tab') return;
            /* 自绘弹窗没有焦点圈闭：不拦 Tab，焦点会顺着 document 走到遮罩背后
               那张表格上，键盘用户直接跑出弹窗。 */
            const list = this.focusable();
            if (!list.length) return;
            const first = list[0];
            const last = list[list.length - 1];
            const active = document.activeElement;
            if (!this.$refs.dialog || !this.$refs.dialog.contains(active)) {
                event.preventDefault();
                first.focus();
                return;
            }
            if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        },
        errorFor(name) {
            const value = this.errors[name];
            if (!value) return '';
            return Array.isArray(value) ? value.join(' ') : String(value);
        },
        async submit() {
            if (this.submitting) return;
            this.submitting = true;
            this.message = '';
            this.errors = {};
            try {
                await api.post(this.endpoint, {...this.form});
                // 先让按钮活过来再关窗，否则 hide() 会被 submitting 挡回去，弹窗关不掉。
                this.submitting = false;
                this.closeModal();
                this.$emit('saved');
                if (typeof document !== 'undefined') {
                    document.dispatchEvent(new CustomEvent('app:subnet-saved'));
                }
            } catch (error) {
                this.message = error.message || '保存失败';
                this.errors = (error.payload && error.payload.errors) || {};
                this.submitting = false;
            }
        },
    },
    template: `
    <div class="d-inline-block">
        <button v-if="can_administer" class="btn btn-primary" type="button" @click="show">增加 IP 段</button>

        <div v-if="open" ref="dialog" class="modal fade show d-block" role="dialog" aria-modal="true" aria-labelledby="ip-subnet-modal-title" @click.self="hide">
            <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-shell">
                <div class="modal-content modal-surface">
                    <form @submit.prevent="submit">
                        <div class="modal-header">
                            <h2 class="modal-title fs-5" id="ip-subnet-modal-title">增加 IP 段</h2>
                            <button type="button" class="btn-close" aria-label="关闭" @click="hide"></button>
                        </div>
                        <div class="modal-body modal-body--scroll">
                            <p v-if="message" class="alert alert-danger py-2" role="alert">[[ message ]]</p>
                            <p v-if="errorFor('__all__')" class="alert alert-danger py-2" role="alert">[[ errorFor('__all__') ]]</p>

                            <div class="row g-3">
                                <div class="col-12">
                                    <label class="form-label" for="ip-subnet-cidr">网段</label>
                                    <input class="form-control" :class="{'is-invalid': errorFor('cidr')}" id="ip-subnet-cidr" v-model.trim="form.cidr" placeholder="10.1.1.0/24" maxlength="43" required autocomplete="off">
                                    <div class="invalid-feedback d-block" v-if="errorFor('cidr')">[[ errorFor('cidr') ]]</div>
                                    <div class="form-text" v-else>按 CIDR 填写，主机位会被规范到网络地址。</div>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label" for="ip-subnet-purpose">用途</label>
                                    <select class="form-select" id="ip-subnet-purpose" v-model="form.purpose">
                                        <option v-for="item in purposes" :key="item.value" :value="item.value">[[ item.label ]]</option>
                                    </select>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label" for="ip-subnet-vlan">VLAN</label>
                                    <input class="form-control" :class="{'is-invalid': errorFor('vlan')}" id="ip-subnet-vlan" v-model.trim="form.vlan" maxlength="32" autocomplete="off">
                                    <div class="invalid-feedback d-block" v-if="errorFor('vlan')">[[ errorFor('vlan') ]]</div>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label" for="ip-subnet-gateway">网关</label>
                                    <input class="form-control" :class="{'is-invalid': errorFor('gateway')}" id="ip-subnet-gateway" v-model.trim="form.gateway" placeholder="10.1.1.1" maxlength="39" autocomplete="off">
                                    <div class="invalid-feedback d-block" v-if="errorFor('gateway')">[[ errorFor('gateway') ]]</div>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label" for="ip-subnet-pool-start">地址池开始</label>
                                    <input class="form-control" :class="{'is-invalid': errorFor('pool_start')}" id="ip-subnet-pool-start" v-model.trim="form.pool_start" placeholder="10.1.1.100" maxlength="39" autocomplete="off">
                                    <div class="invalid-feedback d-block" v-if="errorFor('pool_start')">[[ errorFor('pool_start') ]]</div>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label" for="ip-subnet-pool-end">地址池结束</label>
                                    <input class="form-control" :class="{'is-invalid': errorFor('pool_end')}" id="ip-subnet-pool-end" v-model.trim="form.pool_end" placeholder="10.1.1.200" maxlength="39" autocomplete="off">
                                    <div class="invalid-feedback d-block" v-if="errorFor('pool_end')">[[ errorFor('pool_end') ]]</div>
                                    <div class="form-text" v-else>开始和结束要一起填，留空表示没有 DHCP 池。</div>
                                </div>
                                <div class="col-12">
                                    <label class="form-label" for="ip-subnet-note">备注</label>
                                    <input class="form-control" :class="{'is-invalid': errorFor('note')}" id="ip-subnet-note" v-model.trim="form.note" maxlength="200" autocomplete="off">
                                    <div class="invalid-feedback d-block" v-if="errorFor('note')">[[ errorFor('note') ]]</div>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer modal-footer--sticky">
                            <button type="button" class="btn btn-outline-secondary" @click="hide" :disabled="submitting">取消</button>
                            <button type="submit" class="btn btn-primary" :disabled="submitting">[[ submitting ? '保存中…' : '保存网段' ]]</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
        <div v-if="open" class="modal-backdrop fade show"></div>
    </div>`,
};
