function bindAlertPolicy(form) {
    const update = () => {
        const inherit = form.querySelector('[name="mode"]:checked')?.value === 'inherit';
        const editor = form.querySelector('[data-alert-override-channels]');
        const inherited = form.querySelector('[data-alert-inherited-channels]');
        if (editor) { editor.hidden = inherit; editor.disabled = inherit; }
        if (inherited) inherited.hidden = !inherit;
    };
    form.addEventListener('change', update);
    form.addEventListener('modal-draft-restored', update);
    update();
}

function switchProfile(select, location, doc, transport = typeof window !== 'undefined' ? window.AppModalTransport : null) {
    const url = new URL(location.href);
    const single = select.closest('.modal').querySelector?.('[name="single_target_id"]')?.value;
    if (single) url.searchParams.set('task_single_target', single);
    else url.searchParams.delete('task_single_target');
    url.searchParams.set('task_profile', select.value);
    url.searchParams.set('task_modal', select.closest('.modal').id === 'runTaskModal' ? 'run' : 'profile');
    url.searchParams.set('task_mode', doc.querySelector('[name="target_mode"]:checked')?.value || 'all');
    url.searchParams.set('task_targets', Array.from(doc.querySelectorAll('[name="target_ids"]:checked'), box => box.value).join(','));
    return transport?.navigate(select.closest('.modal'), url.toString());
}

function selectRow(doc, id) {
    doc.querySelectorAll('[name="target_ids"]').forEach(box => { box.checked = box.value === id; box.dispatchEvent?.(new Event('change', {bubbles: true})); });
    doc.querySelectorAll('[name="target_mode"]').forEach(mode => { if (mode.type === 'hidden') mode.value = 'selected'; else mode.checked = mode.value === 'selected'; });
    const singleTarget = doc.querySelector('[name="single_target_id"]');
    if (singleTarget) singleTarget.value = id;
}

function clearRowTarget(doc) {
    doc.querySelectorAll('[name="target_ids"]').forEach(box => { box.checked = false; box.dispatchEvent?.(new Event('change', {bubbles: true})); });
    doc.querySelectorAll('[name="target_mode"]').forEach(mode => {
        if (mode.type === 'hidden') mode.value = '';
        else mode.checked = false;
    });
    const singleTarget = doc.querySelector('[name="single_target_id"]');
    if (singleTarget) singleTarget.value = '';
}

function filterTargetDeviceChoices(choices, query, visibility, vendor = '', deviceType = '') {
    const normalizedQuery = (query || '').trim().toLocaleLowerCase();
    choices.forEach(choice => {
        const matchesQuery = !normalizedQuery || choice.label.toLocaleLowerCase().includes(normalizedQuery);
        const matchesVisibility = visibility !== 'selected' || choice.input.checked;
        const matchesVendor = !vendor || choice.vendor === vendor;
        const matchesType = !deviceType || choice.deviceType === deviceType;
        choice.hidden = !(matchesQuery && matchesVisibility && matchesVendor && matchesType);
    });
}

function updateTargetDeviceSelection(choices, action) {
    choices.filter(choice => !choice.hidden).forEach(choice => {
        choice.input.checked = action === 'invert' ? !choice.input.checked : action === 'all';
    });
}

function updateCheckboxSelection(inputs, action) {
    inputs.filter(input => !input.disabled).forEach(input => {
        input.checked = action === 'invert' ? !input.checked : action === 'all';
    });
}

function applicableTargetItems(choices) {
    // 一台没选就没有「能执行的项目」，所以这里是空集；不要退回全部设备的并集。
    return new Set(choices.filter(choice => choice.input.checked).flatMap(choice => choice.items || []));
}

function applicableMethodNotes(choices) {
    // Map<项目, 该项目在所选设备上会用到的采集方式>；一台没选就是空 Map。
    const notes = new Map();
    choices.filter(choice => choice.input.checked).forEach(choice => {
        Object.entries(choice.methods).forEach(([item, note]) => {
            if (!notes.has(item)) notes.set(item, []);
            note.split('/').forEach(part => {
                if (!notes.get(item).includes(part)) notes.get(item).push(part);
            });
        });
    });
    return notes;
}

function bindTargetDevicePicker(picker) {
    const search = picker.querySelector('[data-target-device-search]');
    const vendor = picker.querySelector('[data-target-device-vendor]');
    const deviceType = picker.querySelector('[data-target-device-type]');
    const visibility = picker.querySelector('[data-target-device-visibility]');
    const count = picker.querySelector('[data-target-device-count]');
    const mode = picker.closest('.inspection-config-block').querySelector('[data-target-device-mode]');
    const choices = Array.from(picker.querySelectorAll('[data-target-device-option]'), option => ({
        get hidden() { return option.hidden; },
        set hidden(value) { option.hidden = value; },
        label: option.dataset.targetDeviceLabel || option.textContent,
        vendor: option.dataset.targetDeviceVendor || '',
        deviceType: option.dataset.targetDeviceType || '',
        items: (option.dataset.targetDeviceItems || '').split(',').filter(Boolean),
        methods: (option.dataset.targetDeviceMethods || '').split(';').filter(Boolean)
            .map(pair => pair.split('=')).reduce((all, [item, note]) => {
                if (item && note) all[item] = note;
                return all;
            }, {}),
        input: option.querySelector('input[type="checkbox"]'),
    }));
    const refresh = () => {
        filterTargetDeviceChoices(choices, search.value, visibility.value, vendor?.value || '', deviceType.value);
        const selectedCount = choices.filter(choice => choice.input.checked).length;
        mode.value = selectedCount ? 'selected' : 'all';
        count.textContent = `已选 ${selectedCount} / ${choices.length} 台`;
        const allowed = applicableTargetItems(choices);
        const form = picker.closest('form');
        if (choices.length) form.querySelectorAll('[name="selected_items"]').forEach(input => {
            input.disabled = !allowed.has(input.value);
            input.closest('label').hidden = input.disabled;
        });
        // 备注跟着所选设备走：多台设备用到的不同方式按斜杠并列，一台没选则清空。
        const notes = applicableMethodNotes(choices);
        form.querySelectorAll('[data-item-method]').forEach(span => {
            const parts = notes.get(span.dataset.itemMethod);
            span.textContent = parts && parts.length ? `（${parts.join('/')}）` : '';
        });
    };
    search.addEventListener('input', refresh);
    vendor?.addEventListener('change', refresh);
    deviceType.addEventListener('change', refresh);
    visibility.addEventListener('change', refresh);
    picker.querySelector('[data-target-device-select-all]').addEventListener('click', () => {
        updateTargetDeviceSelection(choices, 'all');
        refresh();
    });
    picker.querySelector('[data-target-device-invert]').addEventListener('click', () => {
        updateTargetDeviceSelection(choices, 'invert');
        refresh();
    });
    choices.forEach(choice => choice.input.addEventListener('change', refresh));
    refresh();
}

function bindBulkChoiceGroup(group) {
    const inputs = () => Array.from(group.querySelectorAll('[data-bulk-choice]'));
    group.querySelector('[data-bulk-select-all]').addEventListener('click', () => updateCheckboxSelection(inputs(), 'all'));
    group.querySelector('[data-bulk-invert]').addEventListener('click', () => updateCheckboxSelection(inputs(), 'invert'));
}

if (typeof module !== 'undefined') module.exports = {bindAlertPolicy,applicableTargetItems,applicableMethodNotes, switchProfile, selectRow, clearRowTarget, filterTargetDeviceChoices, updateTargetDeviceSelection, updateCheckboxSelection};

const boundTaskControls = new WeakSet();
function bindInspectionRuleFilter(container) {
    const search = container.querySelector('[data-rule-search]');
    const scope = container.querySelector('[data-rule-scope]');
    const count = container.querySelector('[data-rule-count]');
    const rules = Array.from(container.querySelectorAll('[data-inspection-rule]'));
    const update = () => {
        const keyword = (search?.value || '').trim().toLocaleLowerCase();
        let visible = 0;
        rules.forEach(rule => {
            const mode = rule.querySelector('[data-rule-mode] select')?.value || 'inherit';
            const matches = (rule.dataset.ruleLabel || '').toLocaleLowerCase().includes(keyword)
                && (!scope?.value || scope.value === 'all' || mode === scope.value);
            rule.hidden = !matches;
            if (matches) visible += 1;
        });
        if (count) count.textContent = `显示 ${visible} / ${rules.length} 项；筛选只影响显示，保存仍包含全部项目。`;
    };
    container.addEventListener('invalid', event => {
        const rule = event.target.closest('[data-inspection-rule]');
        if (!rule) return;
        if (search) search.value = '';
        if (scope) scope.value = 'all';
        update();
        rule.open = true;
    }, true);
    container.addEventListener('input', update);
    container.addEventListener('change', update);
    container.closest('form')?.addEventListener('modal-draft-restored', update);
    update();
}

function bindTaskUI(root) {
    const once = (selector, bind) => root.querySelectorAll(selector).forEach(element => {
        if (boundTaskControls.has(element)) return;
        boundTaskControls.add(element);
        bind(element);
    });
    once('#task-profile, #config-profile', select => {
        select.addEventListener('change', () => switchProfile(select, window.location, document));
    });
    once('[data-task-target]', button => {
        button.addEventListener('click', () => selectRow(document, button.dataset.taskTarget));
    });    once('[data-bs-target="#runTaskModal"]', button => {
        if (!button.dataset.taskTarget) button.addEventListener('click', () => {
            clearRowTarget(document);
            const url = new URL(window.location.href);
            url.searchParams.delete('task_single_target');
            url.searchParams.set('task_modal', 'run');
            window.AppModalTransport?.navigate(document.getElementById('runTaskModal'), url.toString());
        });
    });
    once('[data-target-device-picker]', bindTargetDevicePicker);
    once('[data-rule-filter]', bindInspectionRuleFilter);
    once('[data-alert-policy-form]', bindAlertPolicy);
    once('[data-inspection-rule]', (rule) => {
        const method=rule.querySelector('[data-rule-method] select');
        const mode=rule.querySelector('[data-rule-mode] select');
        const update=()=>{
            const editor=rule.querySelector('[data-rule-editor]');
            if (editor) {
                editor.hidden=mode?.value==='inherit';
                editor.querySelectorAll('input, select, textarea, button').forEach(control=>{control.disabled=editor.hidden;});
            }
            rule.querySelectorAll('[data-rule-protocol]').forEach(section=>{
                section.hidden=!method || method.value!==section.dataset.ruleProtocol;
            });
        };
        method?.addEventListener('change',update);
        mode?.addEventListener('change',update);
        rule.closest('form')?.addEventListener('modal-draft-restored',update);
        update();
    });
    once('[data-template-parent] select', (select) => {
        select.addEventListener('change',()=>{
            const form=select.closest('form');
            const preview=form?.querySelector('button[name="preview_inheritance"]');
            if (preview)form.requestSubmit(preview);
        });
    });
    once('[data-bulk-choice-group]', bindBulkChoiceGroup);

    const updateFileTimeFields = (select) => {
        const form = select.closest('form');
        const dateRange = select.value === 'date_range';
        form.querySelectorAll('[data-recent-days]').forEach((field) => { field.hidden = dateRange; });
        form.querySelectorAll('[data-date-range]').forEach((field) => { field.hidden = !dateRange; });
    };
    once('[data-file-time-mode]', (select) => {
        updateFileTimeFields(select);
        select.addEventListener('change', () => updateFileTimeFields(select));
    });
}
if (typeof window !== 'undefined') window.AppTaskUI = {bind: bindTaskUI};
/* 任务表：点行把下方结果换成那一次，点「详情」开弹窗。
   行跳转保留全部现有查询参数，只改 task，翻页和筛选不会丢。 */
async function selectTask(row) {
    const region = document.getElementById('task-results-region');
    if (!region) return;
    const table = row.closest('.inspection-taskbar');
    const url = new URL(window.location.href);
    url.searchParams.set('task', row.dataset.taskId);
    url.searchParams.set('fragment', 'results');
    url.searchParams.delete('page');
    region.classList.add('is-loading');
    try {
        const response = await fetch(url.toString(), {
            headers: {'X-Requested-With': 'XMLHttpRequest'}, credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(String(response.status));
        // 只换结果区的内容：滚动位置、筛选栏、任务表都留在原地。
        region.innerHTML = await response.text();
        table.querySelectorAll('[data-task-row]').forEach((item) => {
            item.classList.toggle('is-selected', item === row);
        });
        // 选中任务是页面内部切换，不写地址栏。
    } catch (error) {
        region.classList.remove('is-loading');
        return;
    }
    region.classList.remove('is-loading');
}

function bindTaskTable(doc) {
    // 委托到 document，只绑一次。绑在 .inspection-taskbar 上的话，任务栏翻页
    // 是 replaceWith 整块换节点，处理器跟着旧节点一起消失 —— 新节点上照样是
    // 手型光标和 role=link，点了却没有任何反应。
    const root = doc === document ? document.documentElement : doc;
    if (!root || root.dataset.taskTableBound === '1') return;
    root.dataset.taskTableBound = '1';
    doc.addEventListener('click', (event) => {
        // 详情按钮交给共享的 detail_modal.js，这里只管任务行的原地切换。
        if (event.target.closest?.('[data-detail-modal]')) return;
        const row = event.target.closest?.('[data-task-row]');
        if (!row || !row.closest('.inspection-taskbar')) return;
        selectTask(row);
    });
    doc.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest?.('[data-task-row]');
        if (!row || !row.closest('.inspection-taskbar')) return;
        event.preventDefault();
        row.click();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bindTaskUI(document);
    bindTaskTable(document);
    document.querySelectorAll('.modal[data-auto-open="true"]').forEach((modal) => {
        if (window.bootstrap?.Modal) window.bootstrap.Modal.getOrCreateInstance(modal).show();
    });
});