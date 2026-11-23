(function (factory) {
    'use strict';

    const controller = factory();
    if (typeof module === 'object' && module.exports) module.exports = controller;
    if (typeof document !== 'undefined') controller.installSourceModalReload(document, window);
}(function () {
    'use strict';

    /* 保存过来源后关窗：只换页内内容并通知页面重取，地址栏不动。
       挂 data-source-saved 的编辑框保存成功后交给这里。 */
    function refreshPage(documentRoot, browserWindow) {
        let storage = null;
        try {
            storage = browserWindow.localStorage;
        } catch (_error) {
            storage = null;
        }
        // 表格刷新已经由 form_ajax 的成功回调做过一次；这里只派事件，
        // 让岛化表格自己重取，避免同一页连刷两遍。
        void storage;
        documentRoot.dispatchEvent(new browserWindow.CustomEvent('app:modal-updated', {detail: {}}));
    }

    function installSourceModalReload(documentRoot, browserWindow) {
        let saved = false;
        documentRoot.addEventListener('app:modal-updated', event => {
            const modal = event.detail?.modal;
            if (modal?.id === 'accessSourceModal' && modal.querySelector('[data-source-saved]')) {
                saved = true;
            }
        });
        documentRoot.addEventListener('hidden.bs.modal', event => {
            if (event.target.id !== 'accessSourceModal' || !saved) return;
            saved = false;
            refreshPage(documentRoot, browserWindow);
        });
    }

    return {installSourceModalReload};
}));
