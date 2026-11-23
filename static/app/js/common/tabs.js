// 方块切换：自己接管 tab 的显隐，不等 Bootstrap 初始化，也不会出现两个面板同时展开。
// 切换只在页内换内容，不动地址栏；带 ?object= 进来仍然认，那是外链直达用的。
(function () {
    function activate(trigger) {
        const selector = trigger.getAttribute('data-bs-target') || trigger.getAttribute('href');
        if (!selector || !selector.startsWith('#')) return false;
        const target = document.querySelector(selector);
        if (!target) return false;
        const content = target.parentElement;
        if (!content) return false;

        content.querySelectorAll(':scope > .tab-pane').forEach(function (pane) {
            pane.classList.remove('active');
            pane.classList.remove('show');
        });
        target.classList.add('active');
        target.classList.add('show');

        const list = trigger.closest('[role="tablist"]');
        if (list) {
            list.querySelectorAll('[role="tab"]').forEach(function (tab) {
                const on = tab === trigger;
                tab.classList.toggle('active', on);
                tab.setAttribute('aria-selected', on ? 'true' : 'false');
            });
        }

        return true;
    }

    document.addEventListener('click', function (event) {
        const trigger = event.target.closest('[data-bs-toggle="tab"][data-bs-target], [data-bs-toggle="tab"][href^="#"]');
        if (!trigger) return;
        if (activate(trigger)) {
            event.preventDefault();
        }
    });

    // 带 ?object= 进来（外链直达）时，首屏就把对应面板打开。地址栏保持原样。

    window.addEventListener('DOMContentLoaded', function () {
        const params = new URLSearchParams(window.location.search);
        const object = params.get('object');
        if (!object) return;
        const trigger = document.querySelector('[data-bs-toggle="tab"][href="?object=' + object + '"]');
        if (!trigger) return;
        activate(trigger);
        // 外部链接带 ?object= 进来就停在这个面板上；地址栏保持原样，刷新还能定位。
    });
})();
