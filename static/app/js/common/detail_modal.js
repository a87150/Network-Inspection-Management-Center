/* 统一的"详情"弹窗：任何带 data-detail-modal 的按钮都在弹窗里打开，不再跳新页面。
   走 fetch 片段而不是 iframe，和设置类弹窗保持一致。
   打开的详情同步到 #detail=<路径>，所以链接可以分享，直接访问也会自动弹出。

   两次点击之间的体感要做对：
   1. 先画骨架再等网络，点下去立刻有反馈；
   2. Vue 模块提前预取，避免首次打开时现下载；
   3. 填充内容前后记住滚动位置，片段里的锚点或自动聚焦不会把页面顶走。 */
(function () {
    const MODAL_ID = 'genericDetailModal';
    const HASH_KEY = '#detail=';

    // 提前把 Vue 运行时要过来，第一次点详情就不用等它下载。
    const bootModule = import('/static/app/vue/boot.mjs');

    function target() {
        return document.querySelector('[data-generic-detail-body]');
    }

    function syncHash(path) {
        const base = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', path ? base + HASH_KEY + encodeURIComponent(path) : base);
    }

    function pathFromHash() {
        const hash = window.location.hash || '';
        if (!hash.startsWith(HASH_KEY)) return '';
        try {
            return decodeURIComponent(hash.slice(HASH_KEY.length));
        } catch (error) {
            return '';
        }
    }

    function skeleton() {
        return '<div class="detail-skeleton" aria-hidden="true">'
            + '<div class="detail-skeleton__bar" style="width:38%"></div>'
            + '<div class="detail-skeleton__bar" style="width:82%"></div>'
            + '<div class="detail-skeleton__bar" style="width:64%"></div>'
            + '<div class="detail-skeleton__bar" style="width:74%"></div>'
            + '</div>';
    }

    function nextFrame() {
        return new Promise(function (resolve) {
            window.requestAnimationFrame(function () { window.requestAnimationFrame(resolve); });
        });
    }

    async function open(path) {
        const modal = document.getElementById(MODAL_ID);
        const box = target();
        if (!modal || !box || !path) return;

        const scrollY = window.scrollY;
        box.innerHTML = skeleton();
        if (window.bootstrap && window.bootstrap.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modal).show();
        }
        // 让浏览器先把骨架画出来，再去等网络。
        await nextFrame();

        try {
            const response = await fetch(path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (!response.ok) throw new Error(String(response.status));
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const content = parsed.getElementById('main-content') || parsed.body;
            box.innerHTML = content ? content.innerHTML : '<p class="mb-0">没有可显示的内容。</p>';
            // 详情正文是 Vue 渲染的，塞进来之后要在这里重新挂一遍。
            const { mountPages } = await bootModule;
            await mountPages(box);
            // 片段里如果带了表格（比如任务的目标明细），它的表格行为也要重新初始化。
            if (window.AppTableWorkspace && window.AppTableWorkspace.initializeAll) {
                window.AppTableWorkspace.initializeAll(box, window.localStorage, window.location);
            }
        } catch (error) {
            box.innerHTML = '<p class="text-danger mb-0">详情加载失败，请稍后再试。</p>';
            return;
        } finally {
            // 片段里的锚点或自动聚焦可能动过滚动位置，恢复回去。
            if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
        }
        syncHash(path);
    }

    function close() {
        const box = target();
        if (box) box.innerHTML = '';
        syncHash('');
    }

    document.addEventListener('click', (event) => {
        const trigger = event.target.closest && event.target.closest('[data-detail-modal]');
        if (!trigger) return;
        event.preventDefault();
        event.stopPropagation();
        open(trigger.dataset.detailModal);
    });

    document.addEventListener('DOMContentLoaded', () => {
        const modal = document.getElementById(MODAL_ID);
        if (modal) modal.addEventListener('hidden.bs.modal', close);
        const initial = pathFromHash();
        if (initial) open(initial);
    });

    window.addEventListener('hashchange', () => {
        const path = pathFromHash();
        if (path) open(path);
    });
}());
