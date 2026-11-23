/* 页内方块切换：三份列表都已经在 DOM 里，点方块只切显隐。
   不取数据、不重写地址栏——URL 只由外部入口决定。 */
document.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-panel-switch]');
    if (!trigger) return;
    const host = document.querySelector('[data-domain-panels]');
    // 没有本地面板容器就按普通链接走，别的页面复用这个属性也不会被拦住。
    if (!host) return;
    const name = new URLSearchParams(trigger.dataset.panelSwitch).get('object') || '';
    event.preventDefault();
    host.querySelectorAll('[data-domain-panel]').forEach(function (panel) {
        panel.hidden = panel.dataset.domainPanel !== name;
    });
    host.dataset.activePanel = name;
    // 暗淡效果和 PC/人员页共用同一条规则（operations.css 里按
    // .metric-card[role="tab"][aria-selected="false"] 压透明度），
    // 这里只维护 aria-selected，不要再单独发明一套 class 开关。
    document.querySelectorAll('[data-panel-switch]').forEach(function (card) {
        const mine = (new URLSearchParams(card.dataset.panelSwitch).get('object') || '') === name;
        card.setAttribute('aria-selected', mine ? 'true' : 'false');
        card.classList.toggle('border-primary', mine);
        if (mine) card.setAttribute('aria-current', 'page');
        else card.removeAttribute('aria-current');
    });
});

/* 首屏按服务端选中的面板把状态摆正，否则刚进来三张都是亮的。 */
document.addEventListener('DOMContentLoaded', function () {
    const host = document.querySelector('[data-domain-panels]');
    if (!host) return;
    const active = host.dataset.activePanel || '';
    document.querySelectorAll('[data-panel-switch]').forEach(function (card) {
        const mine = (new URLSearchParams(card.dataset.panelSwitch).get('object') || '') === active;
        card.setAttribute('aria-selected', mine ? 'true' : 'false');
    });
});
