const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const SOURCE = fs.readFileSync(require.resolve('../../static/app/js/inspections/task_center_tabs.js'), 'utf8');

function fakeTab(view, url) {
    return {
        dataset: {centerTab: view, centerUrl: url},
        attributes: {},
        classList: {toggle() {}},
        setAttribute(name, value) { this.attributes[name] = value; },
        focus() { this.focused = true; },
    };
}

function centerFixture({view = 'tasks', nextView = 'errors', responses = []} = {}) {
    const handlers = {};
    const requests = [];
    const liveRegion = {textContent: ''};
    const state = {};
    const makePane = value => ({
        dataset: {centerPane: value},
        style: {},
        replaceWith(node) { state.current = node; },
    });
    state.current = makePane(view);
    const nextPane = makePane(nextView);
    const tabs = [fakeTab('tasks', '?object=tasks'), fakeTab('errors', '?object=errors')];
    const document = {
        getElementById: id => (id === 'task-center-pane' ? state.current
            : id === 'app-live-region' ? liveRegion : null),
        querySelectorAll: selector => (selector === '[data-center-tab]' ? tabs : []),
        importNode: node => node,
        addEventListener(type, handler) { handlers[type] = handler; },
    };
    const window = {
        location: {href: 'http://localhost/tasks/'},
        mountPages: async () => {},
        addEventListener(type, handler) { handlers['window:' + type] = handler; },
    };
    const sandbox = {
        module: {exports: {}},
        URL,
        document,
        window,
        DOMParser: class {
            parseFromString() {
                return {getElementById: id => (id === 'task-center-pane' ? nextPane : null)};
            }
        },
        fetch: async url => {
            requests.push(url);
            if (responses.length && responses.shift() === 'fail') {
                return {ok: false, status: 500, text: async () => ''};
            }
            return {ok: true, text: async () => '<html></html>'};
        },
    };
    vm.runInNewContext(SOURCE, sandbox);
    return {handlers, requests, tabs, nextPane, liveRegion, window, pane: () => state.current};
}

async function flush() {
    await new Promise(resolve => setImmediate(resolve));
}

function keyEvent(key, tab) {
    return {
        key,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        target: {closest: selector => (selector === '[data-center-tab]' ? tab : null)},
    };
}

function clickOnTab(fixture, tab) {
    fixture.handlers.click({
        target: {closest: selector => (selector === '[data-center-tab]' ? tab : null)},
        preventDefault() {},
    });
}

test('arrow right moves to the next tab and switches the pane', async () => {
    const fixture = centerFixture();
    const [tasks, errors] = fixture.tabs;

    fixture.handlers.keydown(keyEvent('ArrowRight', tasks));
    await flush();

    assert.equal(errors.focused, true);
    assert.equal(tasks.attributes['aria-selected'], 'false');
    assert.equal(errors.attributes['aria-selected'], 'true');
    // 未被选中的页签退出 Tab 序列，键盘用户才不用连按两次 Tab 才越得过去。
    assert.equal(tasks.attributes.tabindex, '-1');
    assert.equal(errors.attributes.tabindex, '0');
    const url = new URL(fixture.requests[0]);
    assert.equal(url.searchParams.get('object'), 'errors');
    assert.equal(url.searchParams.get('fragment'), 'pane');
});

test('arrow left wraps around from the first tab to the last', async () => {
    const fixture = centerFixture();
    const event = keyEvent('ArrowLeft', fixture.tabs[0]);

    fixture.handlers.keydown(event);
    await flush();

    assert.equal(event.defaultPrevented, true);
    assert.equal(fixture.tabs[1].focused, true);
});

test('refresh reuses the pane currently on screen', async () => {
    const fixture = centerFixture({view: 'errors'});
    await fixture.window.AppTaskCenterTabs.refresh();

    const url = new URL(fixture.requests[0]);
    assert.equal(url.searchParams.get('object'), 'errors');
    assert.equal(url.searchParams.get('fragment'), 'pane');
});

test('a failed pane load says so and drops the half-lit state', async () => {
    const fixture = centerFixture({view: 'tasks', nextView: 'errors', responses: ['fail']});
    clickOnTab(fixture, fixture.tabs[1]);
    await flush();

    assert.match(fixture.liveRegion.textContent, /切换视图失败/);
    // 半透明要摘掉：留着等于把面板锁死，看起来还像在加载。
    assert.equal(fixture.pane().style.opacity, '');
    // 面板没换成，卡片也不能留在新视图上：高亮回到真正显示着的那个。
    assert.equal(fixture.tabs[0].attributes['aria-selected'], 'true');
    assert.equal(fixture.tabs[1].attributes['aria-selected'], 'false');
});
