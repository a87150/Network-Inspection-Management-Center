function refreshDomainOperationSummary(doc, actionSelect, form) {
    const action = actionSelect.value;
    const option = actionSelect.options[actionSelect.selectedIndex];
    const actionHolder = form.querySelector('[data-domain-operation-action-value]');
    if (actionHolder) actionHolder.value = action;
    form.querySelector('[data-domain-confirm-action]').textContent = option ? option.textContent : action;
    form.querySelectorAll('[data-domain-parameter-for]').forEach((field) => {
        field.hidden = !field.dataset.domainParameterFor.split(' ').includes(action);
        field.querySelectorAll?.('input, select').forEach((input) => { input.disabled = field.hidden; });
    });
    const selected = doc.querySelectorAll('[data-domain-target-checkbox]:checked');
    form.querySelector('[data-domain-confirm-target-count]').textContent = String(
        action === 'create_user' ? 1 : selected.length,
    );

    const scope = {
        move_ou: ['destination_dn', '目标 OU'],
        add_group: ['group_dn', '安全组'],
    }[action];
    const scopeRow = form.querySelector('[data-domain-confirm-scope-row]');
    scopeRow.hidden = !scope;
    if (scope) {
        const input = Array.from(form.querySelectorAll('[data-domain-summary-input]')).find(
            (item) => item.dataset.domainSummaryInput === scope[0],
        );
        form.querySelector('[data-domain-confirm-scope-label]').textContent = scope[1];
        form.querySelector('[data-domain-confirm-scope]').textContent = input?.value || '—';
    }
}

const boundDomainForms = new WeakSet();

/* 三个面板各有一份动作下拉框（accounts / computers / groups），它们共用同一个
   弹窗。用 doc.querySelector 只会拿到 DOM 里的第一个——也就是 accounts 的那份，
   于是从计算机页签提交时，action 永远是账户下拉框的值。改成记住弹窗是被哪个
   面板打开的，只读那份下拉框。 */
let activeActionSelect = null;

function bindDomainOperationModal(doc) {
    const form = doc.querySelector('[data-domain-operation-form]');
    if (!form) return;
    if (boundDomainForms.has(form)) return;
    boundDomainForms.add(form);

    const modal = doc.querySelector('#domainOperationModal');
    modal?.addEventListener('show.bs.modal', (event) => {
        const panel = event.relatedTarget?.closest('[data-domain-operation-controls]');
        activeActionSelect = panel?.querySelector('[data-domain-operation-action]')
            || doc.querySelector('[data-domain-operation-action]');
        refresh();
    });

    const actionSelectOf = () => activeActionSelect
        || doc.querySelector('[data-domain-operation-action]');
    const refresh = () => {
        const actionSelect = actionSelectOf();
        if (actionSelect) refreshDomainOperationSummary(doc, actionSelect, form);
    };

    // 三个面板各有一份下拉框，哪个都可能是当前的：
    // 在 doc 上委托能覆盖面板切换，直接绑当前这份则保证单测与老路径照常工作。
    doc.addEventListener?.('change', (event) => {
        if (event.target?.matches?.('[data-domain-operation-action]')) refresh();
    });
    actionSelectOf()?.addEventListener?.('change', refresh);
    form.querySelectorAll('[data-domain-summary-input]').forEach((input) => {
        input.addEventListener('input', refresh);
        input.addEventListener('change', refresh);
    });
    doc.querySelectorAll('[data-domain-target-checkbox]').forEach((checkbox) => {
        checkbox.addEventListener('change', refresh);
    });
    form.addEventListener('submit', () => {
        const holder = form.querySelector('[data-domain-selected-targets]');
        holder.replaceChildren();
        doc.querySelectorAll('[data-domain-target-checkbox]:checked').forEach((checkbox) => {
            const input = doc.createElement('input');
            input.type = 'hidden';
            input.name = 'target_ids';
            input.value = checkbox.value;
            holder.appendChild(input);
        });
        refresh();
    });
    refresh();
}

/* 表格是 Vue 渲染的，勾选框什么时候出现不确定：用事件委托，一次绑定长期有效。 */
let delegatedDomainChange = false;
function delegateDomainCheckboxes(doc) {
    if (delegatedDomainChange) return;
    delegatedDomainChange = true;
    doc.addEventListener('change', (event) => {
        if (!event.target.matches('[data-domain-target-checkbox]')) return;
        const actionSelect = activeActionSelect
            || doc.querySelector('[data-domain-operation-action]');
        const form = doc.querySelector('[data-domain-operation-form]');
        if (actionSelect && form) refreshDomainOperationSummary(doc, actionSelect, form);
    });
}

if (typeof module !== 'undefined') {
    module.exports = {bindDomainOperationModal, refreshDomainOperationSummary};
}
if (typeof document !== 'undefined') {
    const boot = () => {
        delegateDomainCheckboxes(document);
        bindDomainOperationModal(document);
    };
    // 脚本可能在本文件加载前 DOMContentLoaded 就已经过去了，readyState 兜一下。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
    document.addEventListener('app:modal-updated', boot);
}