/* 任务·异常同页切换：只换下面那块，页面不动，?object= 同步到地址栏。 */
(function () {
    function pane() {
        return document.getElementById('task-center-pane');
    }

    function highlight(view) {
        document.querySelectorAll('[data-center-tab]').forEach((tab) => {
            const active = tab.dataset.centerTab === view;
            tab.classList.toggle('border-primary', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    async function load(view, url, push) {
        const target = pane();
        if (!target) return;
        target.style.opacity = '.45';
        try {
            const response = await fetch(url + '&fragment=pane', {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) throw new Error(String(response.status));
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const next = parsed.getElementById('task-center-pane');
            if (next) target.replaceWith(document.importNode(next, true));
            else return;
        } catch (error) {
            target.style.opacity = '';
            return;
        }
        highlight(view);
        // 面板切换是页面内部行为，不写地址栏；URL 只由外部入口决定。
        // 换进来的表要重新挂一次表格与弹窗行为。
        window.AppTableTools && window.AppTableTools.refresh && window.AppTableTools.refresh();
        window.AppModalWorkflows && window.AppModalWorkflows.bind && window.AppModalWorkflows.bind(document);
    }

    document.addEventListener('click', (event) => {
        const tab = event.target.closest && event.target.closest('[data-center-tab]');
        if (!tab) return;
        event.preventDefault();
        load(tab.dataset.centerTab, tab.dataset.centerUrl, true);
    });

    window.addEventListener('popstate', (event) => {
        const view = (event.state && event.state.view) || 'tasks';
        load(view, '?object=' + view, false);
    });
}());
