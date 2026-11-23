/* 访客汇总页：只有聚合数字和台账入口，没有任何权限控件。
   一份 bootstrap JSON 渲染整页，首页与人员统计两种形态靠 departments 是否为空区分。 */

export default {
    delimiters: ['[[', ']]'],
    props: {
        page: {type: Object, default: () => ({})},
        people: {type: Object, default: () => ({})},
        people_url: {type: String, default: ''},
        inventories: {type: Array, default: () => []},
        departments: {type: Array, default: null},
        people_title: {type: String, default: ''},
        people_link_label: {type: String, default: ''},
        ledger_link_label: {type: String, default: ''},
        department_caption: {type: String, default: ''},
        department_empty: {type: String, default: ''},
    },
    methods: {
        departmentName(row) {
            return row.department || '未填写';
        },
    },
    template: `
    <div>
        <h1>[[ page.title ]]</h1>
        <p class="text-muted">[[ page.eyebrow ]]</p>
        <section v-if="!inventories.length" class="card surface-card p-4 mb-4" aria-label="人员汇总">
            <h2 class="h4">[[ people_title ]]</h2>
            <dl class="row mb-0">
                <dt class="col-sm-2">总人数</dt><dd class="col-sm-2">[[ people.total ]]</dd>
                <dt class="col-sm-2">在职人数</dt><dd class="col-sm-2">[[ people.active ]]</dd>
                <dt class="col-sm-2">离职人数</dt><dd class="col-sm-2">[[ people.inactive ]]</dd>
            </dl>
            <a :href="people_url">[[ people_link_label ]]</a>
        </section>
        <div v-if="inventories.length" class="row g-3">
            <div v-for="inventory in inventories" :key="inventory.title" class="col-sm-6 col-lg-4">
                <section class="card surface-card p-4 h-100">
                    <h2 class="h4">[[ inventory.title ]]</h2>
                    <p class="fs-3">[[ inventory.total ]]</p>
                    <a :href="inventory.url">[[ ledger_link_label ]]</a>
                </section>
            </div>
        </div>
        <div v-if="departments" class="card surface-card p-4 table-responsive">
            <table class="table">
                <caption>[[ department_caption ]]</caption>
                <thead><tr><th scope="col">部门</th><th scope="col">总人数</th><th scope="col">在职</th><th scope="col">离职</th></tr></thead>
                <tbody>
                    <tr v-for="(row, index) in departments" :key="index">
                        <td>[[ departmentName(row) ]]</td>
                        <td>[[ row.total ]]</td>
                        <td>[[ row.active ]]</td>
                        <td>[[ row.inactive ]]</td>
                    </tr>
                    <tr v-if="!departments.length"><td colspan="4">[[ department_empty ]]</td></tr>
                </tbody>
            </table>
        </div>
    </div>`,
};
