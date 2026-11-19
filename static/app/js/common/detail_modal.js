/* 统一的"详情"弹窗：任何带 data-detail-modal 的按钮都在弹窗里打开，不再跳新页面。
   走 fetch 片段而不是 iframe，和设置类弹窗保持一致。 */
(function () {
    const MODAL_ID = 'genericDetailModal';

    function body(doc) {
        const modal = doc.getElementById(MODAL_ID);
        return modal ? modal.querySelector('[data-generic-detail-body]') : null;
    }

    async function open(trigger) {
        const modal = document.getElementById(MODAL_ID);
        const target = body(document);
        if (!modal || !target) return;
        target.innerHTML = '<p class="text-secondary mb-0">加载中…</p>';
        if (window.bootstrap && window.bootstrap.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modal).show();
        }
        try {
            const response = await fetch(trigger.dataset.detailModal, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) throw new Error(String(response.status));
            const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
            const content = parsed.getElementById('main-content') || parsed.body;
            target.innerHTML = content ? content.innerHTML : '<p class="mb-0">没有可显示的内容。</p>';
        } catch (error) {
            target.innerHTML = '<p class="text-danger mb-0">详情加载失败，请稍后再试。</p>';
        }
    }

    document.addEventListener('click', (event) => {
        const trigger = event.target.closest && event.target.closest('[data-detail-modal]');
        if (!trigger) return;
        event.preventDefault();
        open(trigger);
    });
}());
