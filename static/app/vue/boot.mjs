/* Page mounter: one registry entry per migrated page, no build step. */
import { createApp } from '../../vendor/vue/vue.esm-browser.prod.js';

const pages = {
    'maintenance-list': () => import('./pages/maintenance_list.mjs'),
    // IP 管理整页也是一个岛，键名沿用旧值：tests/devices/test_ip_management_page.py
    // 断言了 data-vue-page="ip-subnet-form"。
    'ip-subnet-form': () => import('./pages/ip_management.mjs'),
    'alert-list': () => import('./pages/alert_list.mjs'),
    'alert-detail': () => import('./pages/resource_detail.mjs'),
    'asset-detail': () => import('./pages/resource_detail.mjs'),
    'record-detail': () => import('./pages/resource_detail.mjs'),
    'log-detail': () => import('./pages/resource_detail.mjs'),
    'task-detail': () => import('./pages/resource_detail.mjs'),
    'inspection-records': () => import('./pages/resource_table.mjs'),
    'error-records': () => import('./pages/resource_table.mjs'),
    'access-records': () => import('./pages/resource_table.mjs'),
    'pc-logs': () => import('./pages/resource_table.mjs'),
    'pc-errors': () => import('./pages/resource_table.mjs'),
    'task-runs': () => import('./pages/resource_table.mjs'),
    'domain-objects': () => import('./pages/resource_table.mjs'),
    // 六个工作区页：一份 bootstrap JSON 渲染整页，逐页迁移，旧页面阶段 5 再删。
    'asset-workspace': () => import('./pages/asset_workspace.mjs'),
    'pc-workspace': () => import('./pages/pc_workspace.mjs'),
    // 三个设备页共用一份组件：差异只有方块和 access 页签，都在 bootstrap 里。
    'network-workspace': () => import('./pages/device_workspace.mjs'),
    'server-workspace': () => import('./pages/device_workspace.mjs'),
    'weakcurrent-workspace': () => import('./pages/device_workspace.mjs'),
    'people-workspace': () => import('./pages/people_workspace.mjs'),
    'people-statistics': () => import('./pages/people_statistics.mjs'),
    'dashboard-index': () => import('./pages/dashboard_index.mjs'),
    // 分析详情弹窗里的问题明细：整表复用 workspace-table。
    'analysis-problems': () => import('./pages/problem_rows.mjs'),
    // 只读页：配置差异、配置备份历史、访客汇总与访客列表。
    'configuration-diff': () => import('./pages/configuration_diff.mjs'),
    'configuration-backups': () => import('./pages/configuration_backups.mjs'),
    'public-summary': () => import('./pages/public_summary.mjs'),
    'public-list': () => import('./pages/public_list.mjs'),
    // AI 问答页：一条会话，历史/提问/清空都走 /api/ai/。
    'ai-chat': () => import('./pages/ai_chat.mjs'),
};

/* scope 用来避开弹窗里的同位 id：详情片段塞进弹窗后，
   它的 bootstrap 脚本和主页面上同名，必须先在本地区域里找。 */
export function readBootstrap(id, scope) {
    const node = (scope && scope.querySelector(`[id="${id}"]`)) || document.getElementById(id);
    if (!node) return {};
    try {
        return JSON.parse(node.textContent);
    } catch (error) {
        console.error('bootstrap 解析失败：', id, error);
        return {};
    }
}

/* 页面是用整页导航切过去的，Bootstrap 的弹窗状态带不过去：
   残留的遮罩层和 body 锁滚动会在新页面上留一层黑，进页面先清掉。 */
function clearStaleModalState() {
    document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('padding-right');
    document.querySelectorAll('.modal.show').forEach((node) => {
        node.classList.remove('show');
        node.style.removeProperty('display');
        node.setAttribute('aria-hidden', 'true');
    });
}

/* 收起一段子树里已经挂上的岛。mount() 会给宿主写 __vue_app__，
   直接把子树的 innerHTML 换掉只是把 DOM 丢了：组件里的 document 级监听器、
   定时器和 watcher 都还活着，换几次就攒几套，旧闭包还会在后续事件里一起触发。
   换内容之前先调这里，再拼新 HTML。 */
export function unmountPages(root = document) {
    const hosts = root && root.querySelectorAll
        ? Array.from(root.querySelectorAll('[data-vue-page]'))
        : [];
    hosts.forEach((host) => {
        const app = host.__vue_app__;
        if (!app || typeof app.unmount !== 'function') return;
        try {
            app.unmount();
        } catch (error) {
            console.error('卸载 Vue 岛失败：', host.dataset && host.dataset.vuePage, error);
        }
        // unmount() 不会清掉这个属性，留着的话下次 mountPages 会以为已经挂过了。
        delete host.__vue_app__;
    });
}

export async function mountPages(root = document) {
    if (root === document) clearStaleModalState();
    const hosts = Array.from(root.querySelectorAll('[data-vue-page]'));
    for (const host of hosts) {
        if (host.__vue_app__) continue;
        const loader = pages[host.dataset.vuePage];
        if (!loader) {
            console.warn('未注册的 Vue 页面：', host.dataset.vuePage);
            continue;
        }
        const module = await loader();
        const props = readBootstrap(host.dataset.vueBootstrap || '', host.parentElement);
        const app = createApp(module.default, props);
        app.config.errorHandler = (error) => console.error(error);
        app.mount(host);
    }
    // 表格是组件渲染出来的，勾选框在挂载后才存在；让页面上那些按 DOM 抓元素的脚本重绑。
    document.dispatchEvent(new CustomEvent('app:modal-updated'));
}

// 换进来一段新 HTML 的页面（Ajax 分页签等）要重新挂岛，普通 script 拿不到模块导出。
if (typeof window !== 'undefined') {
    window.mountPages = mountPages;
    window.unmountPages = unmountPages;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => mountPages(), {once: true});
    } else {
        mountPages();
    }
}