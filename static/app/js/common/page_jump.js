// 页码输入框：回车或失焦跳到对应页，其他查询参数沿用 data-page-jump 里的串。
// 有表格工作区时只换表格内容，地址栏不动。
(function () {
    function go(input) {
        const base = input.dataset.pageJump || '';
        const total = Number(input.max) || 1;
        let page = Number(input.value);
        if (!Number.isFinite(page)) return;
        page = Math.min(Math.max(Math.trunc(page), 1), total);
        input.value = page;
        const params = new URLSearchParams(base);
        params.set('page', String(page));
        const href = '?' + params.toString();
        const controller = window.AppTableWorkspace;
        if (typeof controller?.refreshTableWorkspaces === 'function') {
            let storage = null;
            try {
                storage = window.localStorage;
            } catch (_error) {
                storage = null;
            }
            controller.refreshTableWorkspaces(document, href, storage, window);
            return;
        }
        window.location.assign(href);
    }

    document.addEventListener('keydown', function (event) {
        const input = event.target.closest('[data-page-jump]');
        if (!input || event.key !== 'Enter') return;
        event.preventDefault();
        go(input);
    });

    document.addEventListener('change', function (event) {
        const input = event.target.closest('[data-page-jump]');
        if (input) go(input);
    });
})();
