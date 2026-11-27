/* 任务·异常同页切换：只换下面那块，页面不动，?object= 同步到地址栏。

   键盘要有 WAI-ARIA tab 的那两个动作：左右方向键在页签间移动并激活，
   Home/End 到首尾。只改 aria-selected 不够——没被选中的页签必须退出 Tab 序列，
   否则键盘用户得按两次 Tab 才越得过这个 tablist。 */
(function () {
    function pane() {
        return document.getElementById('task-center-pane');
    }

    function tabs() {
        return Array.from(document.querySelectorAll('[data-center-tab]'));
    }

    /* 整块换内容的面板没有自己的报错位：失败只能走全局 live region。 */
    function announce(text) {
        const liveRegion = document.getElementById('app-live-region');
        if (liveRegion) liveRegion.textContent = text;
    }

    function currentView() {
        return pane()?.dataset?.centerPane || 'tasks';
    }

    function highlight(view) {
        tabs().forEach((tab) => {
            const active = tab.dataset.centerTab === view;
            tab.classList.toggle('border-primary', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            // 选中那个留在 Tab 序列里，其余退出去：这是 tablist 的键盘契约。
            tab.setAttribute('tabindex', active ? '0' : '-1');
        });
    }

    /* 片段地址统一在这里拼：入口有 ?object=... 形式，也有整条 href，
       直接字符串接 "&fragment=pane" 在 href 没有查询串时会拼出非法地址。 */
    function paneUrl(url) {
        const next = new URL(url, window.location.href);
        next.searchParams.set('fragment', 'pane');
        return next.toString();
    }

    /* 换进来的表格 DOM 是全新的：列显隐、筛选按钮、每页条数都要重新接线，
       否则工具栏看着在、点着没反应。refreshTableWorkspaces 会顺手整块重取一次
       表格，手动切换时正合适；轮询时面板本身就是刚渲染的，只接线。 */
    function bindTableWorkspaces(root) {
        let storage = null;
        try {
            storage = window.localStorage;
        } catch (_) {
            /* 偏好可选。 */
        }
        window.AppTableWorkspace?.initializeAll?.(root, storage, window.location);
    }

    async function load(view, url, {reloadTables = true, announceFailure = true} = {}) {
        const target = pane();
        if (!target) return;
        target.style.opacity = '.45';
        try {
            const response = await fetch(paneUrl(url), {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) throw new Error(String(response.status));
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const next = parsed.getElementById('task-center-pane');
            if (!next) throw new Error('pane missing');
            target.replaceWith(document.importNode(next, true));
            highlight(view);
            // 面板切换是页面内部行为，不写地址栏；URL 只由外部入口决定。
            window.AppModalFeedback?.bind?.(document);
            window.AppModalTransport?.install?.(document);
            const fresh = pane();
            if (fresh && reloadTables) window.AppTableWorkspace?.refreshTableWorkspaces?.();
            else if (fresh) bindTableWorkspaces(fresh);
            // 换进来的表是新的 Vue 岛，必须重新挂载，否则只有表头没有行。
            // 等它挂完：状态轮询要读岛所在的 DOM 判断还有没有运行中的任务。
            if (fresh && window.mountPages) await window.mountPages(fresh);
        } catch (error) {
            // 失败要说话：面板停在旧视图而卡片已经高亮成新的，用户会以为看见的是
            // 新视图的内容。顺手把高亮还原回真正显示着的那个视图。
            // 轮询刷新不播报：每几秒念一遍"刷新失败"只会盖掉真正要说的话，
            // 下一拍成功了自己就恢复。
            if (announceFailure) announce('切换视图失败，下面显示的仍是原来的内容，请重试。');
            highlight(currentView());
            return;
        } finally {
            // 两条返回路径都要摘掉半透明：留着它等于把面板锁死（视觉上还像在加载）。
            const current = pane();
            if (current) current.style.opacity = '';
        }
    }

    /* 状态轮询用：按当前显示的面板重新取一次，不碰地址栏。 */
    async function refresh() {
        const url = new URL(window.location.href);
        url.searchParams.set('object', currentView());
        await load(currentView(), url.toString(), {reloadTables: false, announceFailure: false});
    }

    document.addEventListener('click', (event) => {
        const tab = event.target.closest && event.target.closest('[data-center-tab]');
        if (!tab) return;
        event.preventDefault();
        load(tab.dataset.centerTab, tab.dataset.centerUrl);
    });

    document.addEventListener('keydown', (event) => {
        const tab = event.target.closest && event.target.closest('[data-center-tab]');
        if (!tab) return;
        const list = tabs();
        const index = list.indexOf(tab);
        if (index < 0) return;
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        let next = null;
        if (step) next = list[(index + step + list.length) % list.length];
        else if (event.key === 'Home') next = list[0];
        else if (event.key === 'End') next = list[list.length - 1];
        if (!next || next === tab) {
            if (next === tab) event.preventDefault();
            return;
        }
        event.preventDefault();
        next.focus?.();
        // 自动激活：方向键移过去就换内容，和 ARIA 的 automatic activation 一致。
        load(next.dataset.centerTab, next.dataset.centerUrl);
    });

    window.addEventListener('popstate', (event) => {
        const view = (event.state && event.state.view) || 'tasks';
        load(view, '?object=' + view);
    });

    window.AppTaskCenterTabs = {refresh, highlight};
}());
