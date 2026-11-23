/* IP 管理页：一份 bootstrap JSON 渲染整页——查询表单、定位结果、IP 台账。
   查询走 ?fragment=lookup 重取这一段，不跳转、不改地址栏；
   「增加 IP 段」仍是本页弹窗（ip_subnet_form.mjs），提交走 REST。 */
import { api } from '../api.mjs';
import IpSubnetForm from './ip_subnet_form.mjs';

export default {
    delimiters: ['[[', ']]'],
    components: {IpSubnetForm},
    props: {
        page: {type: Object, default: () => ({})},
        endpoint: {type: String, default: '/api/v1/ip-subnets/'},
        can_administer: {type: Boolean, default: false},
        purposes: {type: Array, default: () => []},
        csrf: {type: String, default: ''},
        query: {type: String, default: ''},
        hint: {type: String, default: ''},
        lookup: {type: Object, default: null},
        ledger: {type: Object, default: () => ({})},
    },
    data() {
        return {
            term: this.query,
            result: this.lookup,
            loading: false,
            error: '',
        };
    },
    computed: {
        /** 命中上限时补一行说明。 */
        truncated() {
            return Boolean(this.result && this.result.rows.length && this.result.truncated);
        },
        /** 弹窗组件的 props 名是下划线写法，用对象整体传，避免模板里写带下划线的属性名。 */
        subnetProps() {
            return {
                endpoint: this.endpoint,
                purposes: this.purposes,
                can_administer: this.can_administer,
            };
        },
    },
    methods: {
        cell(row, key) {
            return (row.cells && row.cells[key]) || {text: '—'};
        },
        async run() {
            if (this.loading) return;
            this.loading = true;
            this.error = '';
            try {
                const payload = await api.get(window.location.pathname, {
                    fragment: 'lookup',
                    q: this.term,
                });
                this.result = this.term ? payload : null;
            } catch (failure) {
                this.error = failure.message || '查询失败';
            } finally {
                this.loading = false;
            }
        },
        clear() {
            this.term = '';
            this.result = null;
            this.error = '';
        },
        /** 保存完网段后原地重取台账，不整页刷新。 */
        async reloadAll() {
            try {
                const payload = await api.get(window.location.pathname, {fragment: 'ledger'});
                if (payload && payload.ledger) this.ledger = payload.ledger;
            } catch (failure) {
                this.error = failure.message || '台账刷新失败';
            }
            if (this.term) await this.run();
        },
    },
    template: `
    <div>
        <header class="page-heading">
            <div class="page-heading__copy">
                <p class="page-heading__eyebrow">[[ page.eyebrow ]]</p>
                <h1 class="page-heading__title">[[ page.title ]]</h1>
                <p class="page-heading__description">[[ page.description ]]</p>
            </div>
            <div class="page-heading__actions">
                <ip-subnet-form v-bind="subnetProps" @saved="reloadAll"></ip-subnet-form>
            </div>
        </header>

        <section class="card surface-card ip-lookup-card" aria-label="IP 查询">
            <div class="card-body">
                <form class="ip-lookup-form" role="search" @submit.prevent="run">
                    <label class="visually-hidden" for="ip-lookup-query">IP 或 MAC</label>
                    <input class="form-control" id="ip-lookup-query" v-model.trim="term" placeholder="10.1.1.20 或 aabb.ccdd.eeff" maxlength="64" autocomplete="off">
                    <button type="submit" class="btn btn-primary" :disabled="loading">查询</button>
                    <button v-if="result" type="button" class="btn btn-outline-secondary" @click="clear">清空</button>
                </form>
                <p v-if="error" class="alert alert-danger py-2 mt-3 mb-0" role="alert">[[ error ]]</p>
                <p class="ip-lookup-hint">[[ hint ]]</p>
            </div>
        </section>

        <section v-if="result" class="card surface-card table-scroll-shell" aria-label="查询结果">
            <div class="card-header surface-card__header"><h2 class="h5 mb-0">[[ result.label ]]</h2></div>
            <div v-if="result.rows.length" class="table-responsive" role="region" :aria-label="result.region_label" tabindex="0">
                <table class="table data-table table-hover align-middle mb-0">
                    <caption class="visually-hidden">匹配到的设备、接口、VLAN、来源与采集时间</caption>
                    <thead><tr><th v-for="column in result.columns" :key="column.key" scope="col">[[ column.label ]]</th></tr></thead>
                    <tbody>
                        <tr v-for="row in result.rows" :key="row.id">
                            <td><code>[[ cell(row, 'ip').text ]]</code></td>
                            <td><code>[[ cell(row, 'mac').text ]]</code></td>
                            <td>
                                <a :href="cell(row, 'device').href">[[ cell(row, 'device').text ]]</a><br>
                                <span class="text-secondary">[[ cell(row, 'device').sub ]]</span>
                            </td>
                            <td>[[ cell(row, 'interface').text ]]</td>
                            <td>[[ cell(row, 'vlan').text ]]</td>
                            <td>[[ cell(row, 'source').text ]]</td>
                            <td>
                                [[ cell(row, 'observed_at').text ]]<template v-if="cell(row, 'observed_at').href"><br>
                                <a :href="cell(row, 'observed_at').href">[[ cell(row, 'observed_at').href_text ]]</a></template>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div v-if="truncated" class="card-body"><p class="mb-0 text-secondary">[[ result.truncated_message ]]</p></div>
            <div v-if="!result.rows.length" class="card-body"><div class="empty-state">
                <strong>[[ result.empty_title ]]</strong><span>[[ result.empty_message ]]</span>
            </div></div>
        </section>

        <section class="card surface-card" aria-label="IP 台账">
            <div class="card-header surface-card__header configuration-backup-header">
                <h2 class="h5 mb-0">[[ ledger.label ]]</h2>
                <ul class="configuration-backup-summary" aria-label="台账摘要">
                    <li v-for="item in ledger.counts" :key="item.label"><span>[[ item.label ]]</span><strong>[[ item.value ]]</strong></li>
                </ul>
            </div>
            <div v-if="ledger.issues.length" class="card-body ip-issue-list">
                <div v-for="(issue, index) in ledger.issues" :key="index" class="ip-issue" :class="'ip-issue--' + (issue.tone === 'danger' ? 'error' : 'warning')">
                    <span class="status-badge" :class="'status-badge--' + issue.tone">[[ issue.label ]]</span>
                    <div><strong>[[ issue.title ]]</strong><p>[[ issue.detail ]]</p></div>
                </div>
                <p v-if="ledger.issue_more" class="ip-issue-more">[[ ledger.issue_more ]]</p>
            </div>
            <div v-else-if="ledger.rows.length" class="card-body"><p class="mb-0 text-secondary">[[ ledger.consistent_message ]]</p></div>
            <div v-if="ledger.rows.length" class="table-responsive" role="region" :aria-label="ledger.region_label" tabindex="0">
                <table class="table data-table table-hover align-middle mb-0">
                    <caption class="visually-hidden">网段、用途、网关、地址池与登记数量</caption>
                    <thead><tr><th v-for="column in ledger.columns" :key="column.key" scope="col">[[ column.label ]]</th></tr></thead>
                    <tbody>
                        <tr v-for="row in ledger.rows" :key="row.id">
                            <td><code>[[ cell(row, 'cidr').text ]]</code><template v-if="cell(row, 'cidr').sub"><br>
                                <span class="text-secondary">[[ cell(row, 'cidr').sub ]]</span></template></td>
                            <td>[[ cell(row, 'purpose').text ]]</td>
                            <td>[[ cell(row, 'vlan').text ]]</td>
                            <td>[[ cell(row, 'gateway').text ]]</td>
                            <td><template v-if="cell(row, 'pool').muted"><span class="text-secondary">[[ cell(row, 'pool').text ]]</span></template><template v-else><code>[[ cell(row, 'pool').text ]]</code><br><span class="text-secondary">[[ cell(row, 'pool').sub ]]</span></template></td>
                            <td>[[ cell(row, 'usable').text ]]</td>
                            <td>[[ cell(row, 'registered').text ]]</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div v-if="!ledger.rows.length" class="card-body"><div class="empty-state">
                <strong>[[ ledger.empty_title ]]</strong><span>[[ ledger.empty_message ]]</span>
            </div></div>
            <div v-if="ledger.unplanned.length" class="card-body ip-unplanned">
                <strong>[[ ledger.unplanned_label ]]</strong>
                <p class="mb-0"><code>[[ ledger.unplanned.join('  ') ]]</code></p>
            </div>
        </section>
        <div hidden><input type="hidden" name="csrfmiddlewaretoken" :value="csrf"></div>
    </div>`,
};
