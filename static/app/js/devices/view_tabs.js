/* 资产页顶部大方块：点一下只换下面那块内容，不整页刷新，?object= 仍同步到地址栏。 */
(function () {
    const VIEW_LABELS = { rows: '台账', records: '巡检记录', access: '门禁记录', departments: '部门' };

    function pane() {
        return document.getElementById('asset-pane-rows') || document.getElementById('asset-pane-other');
    }

    function highlight(view) {
        document.querySelectorAll('[data-view-tab]').forEach((tab) => {
            const active = tab.dataset.viewTab === view;
            tab.classList.toggle('border-primary', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    async function load(view, url, push) {
        const target = pane();
        if (!target) return;
        const parent = target.parentNode;
        target.style.opacity = '.45';
        try {
            const response = await fetch(url + '&fragment=pane', {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) throw new Error(String(response.status));
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const next = parsed.querySelector('[data-view-pane]');
            if (next) parent.replaceChild(document.importNode(next, true), target);
        } catch (error) {
            target.style.opacity = '';
            return;
        }
        highlight(view);
        const resolved = new URL(url, window.location.href);
        if (push) window.history.pushState({ view }, '', resolved.toString());
        else window.history.replaceState({ view }, '', resolved.toString());
        document.dispatchEvent(new CustomEvent('app:pane-loaded'));
    }

    document.addEventListener('click', (event) => {
        const tab = event.target.closest && event.target.closest('[data-view-tab]');
        if (!tab) return;
        event.preventDefault();
        load(tab.dataset.viewTab, tab.dataset.viewUrl, true);
    });

    window.addEventListener('popstate', (event) => {
        const view = (event.state && event.state.view) || 'rows';
        const url = new URL(window.location.href);
        if (view === 'rows') url.searchParams.delete('object');
        load(view, url.toString(), false);
    });
}());
