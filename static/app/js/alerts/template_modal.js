(function (factory) {
    'use strict';

    const controller = factory();
    if (typeof module === 'object' && module.exports) module.exports = controller;
    if (typeof document !== 'undefined') {
        controller.installTemplateModalLoader(document, window.AppModalTransport);
    }
}(function () {
    'use strict';

    function installTemplateModalLoader(documentRoot, modalTransport) {
        documentRoot.addEventListener('show.bs.modal', event => {
            const modal = event.target;
            if (modal.id !== 'alertTemplateModal') return;
            modalTransport?.navigate(modal, modal.dataset.templateSettingsUrl);
        });

        /* 下拉切换模板：换一整版弹窗内容，框不关、地址栏不动。 */
        documentRoot.addEventListener('change', event => {
            const picker = event.target.closest('[data-template-switch]');
            if (!picker) return;
            const modal = picker.closest('.modal');
            if (!modal) return;
            const base = modal.dataset.templateSettingsUrl;
            if (!base) return;
            const target = picker.value === 'new'
                ? base + '?new=1'
                : base + '?template=' + encodeURIComponent(picker.value);
            modalTransport?.navigate(modal, target);
        });
    }

    return {installTemplateModalLoader};
}));