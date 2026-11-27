/* detail_modal.js 是经典脚本，一加载就注册捕获阶段的 click 监听。
   这里用最小 DOM 把它跑起来，验两件事：连点两次详情只有最后一次算数，
   以及 Ctrl/⌘/Shift/中键点击不能被当成"打开弹窗"。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODAL_ID = 'genericDetailModal';
const box = {
    dataset: {},
    innerHTML: '',
    attributes: new Map(),
    listeners: new Map(),
    querySelectorAll: () => [],
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
};
const documentListeners = new Map();
const modal = {
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
};
const scriptUrl = pathToFileURL(
    path.resolve('static/app/js/common/detail_modal.js'),
).href;
let scheduledTimers = [];

// boot.mjs 会把 Vue 运行时拉进来，它自己也摸 document：这里补上最小的一层，
// 否则加载阶段就会因为缺 createElement 抛错，测不到我们关心的 open 逻辑。
function stubNode(tagName = 'div') {
    return {
        tagName: String(tagName).toUpperCase(),
        // boot.mjs 在模块顶层会调一次 mountPages()，它要清掉残留的弹窗状态。
        style: {removeProperty() {}, setProperty() {}},
        dataset: {},
        children: [],
        classList: {add() {}, remove() {}, contains: () => false},
        setAttribute() {},
        removeAttribute() {},
        getAttribute: () => null,
        appendChild(child) { return child; },
        insertBefore(child) { return child; },
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll: () => [],
        querySelector: () => null,
    };
}

globalThis.document = {
    currentScript: {src: scriptUrl},
    body: stubNode('body'),
    head: stubNode('head'),
    createElement: (tagName) => stubNode(tagName),
    createTextNode: (text) => ({textContent: text}),
    querySelectorAll: () => [],
    // boot.mjs 挂完岛会广播 app:modal-updated，空页面也要能收。
    dispatchEvent() {},
    getElementById: (id) => (id === MODAL_ID ? modal : null),
    querySelector: (selector) => (selector === '[data-generic-detail-body]' ? box : null),
    addEventListener(type, listener) { documentListeners.set(type, listener); },
};
globalThis.window = {
    scrollY: 0,
    scrollTo(value) { this.scrollY = value; },
    requestAnimationFrame(callback) { callback(); return 1; },
    setTimeout(callback, delay) { scheduledTimers.push({callback, delay}); return scheduledTimers.length; },
    clearTimeout() {},
    bootstrap: null,
    location: {hash: ''},
    addEventListener() {},
};
globalThis.DOMParser = class {
    parseFromString(html) {
        return {getElementById: () => ({innerHTML: html})};
    }
};

let requests = [];
globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    const entry = {url: String(url), options, resolve, reject};
    requests.push(entry);
    options?.signal?.addEventListener?.('abort', () => {
        reject(new Error('aborted'));
    });
});

await import(scriptUrl);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function clickDetail(overrides = {}) {
    const trigger = {dataset: {detailModal: overrides.path || '/inspections/tasks/9/'}};
    const event = {
        button: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        prevented: false,
        stopped: false,
        target: {closest: (selector) => (selector === '[data-detail-modal]' ? trigger : null)},
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        ...overrides,
    };
    documentListeners.get('click')(event);
    return event;
}

test('two detail clicks resolve in reverse order but only the last one is rendered', async () => {
    requests = [];
    clickDetail({path: '/inspections/tasks/1/'});
    await flush();
    clickDetail({path: '/inspections/tasks/2/'});
    await flush();
    assert.deepEqual(requests.map((request) => request.url),
        ['/inspections/tasks/1/', '/inspections/tasks/2/']);

    // 后点的先回：它才是用户要看的详情。
    requests[1].resolve({ok: true, status: 200, async text() { return '<p>第二次</p>'; }});
    await flush();
    assert.match(box.innerHTML, /第二次/);
    assert.equal(box.dataset.detailUrl, '/inspections/tasks/2/');

    // 先点的那次后到，谁也不许覆盖。
    requests[0].resolve({ok: true, status: 200, async text() { return '<p>第一次</p>'; }});
    await flush();
    assert.match(box.innerHTML, /第二次/);
    assert.doesNotMatch(box.innerHTML, /第一次/);
});

test('modified clicks inside the loaded detail keep the browser navigation too', () => {
    const listener = box.listeners.get('click');
    assert.ok(listener, '详情加载成功后应该给弹窗正文绑上站内链接处理');
    const event = {
        button: 0,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        prevented: false,
        target: {
            closest: () => ({
                target: '',
                getAttribute: () => '/inspections/tasks/2/?page=2',
                hasAttribute: () => false,
            }),
        },
        preventDefault() { this.prevented = true; },
    };

    listener(event);

    assert.equal(event.prevented, false);
});

test('modified clicks keep the browser navigation instead of opening the modal', () => {
    requests = [];
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
        const event = clickDetail({path: '/inspections/tasks/3/', [modifier]: true});
        assert.equal(event.prevented, false, modifier + ' 点击应该放行');
        assert.equal(event.stopped, false);
    }
    const middle = clickDetail({path: '/inspections/tasks/3/', button: 1});
    assert.equal(middle.prevented, false);
    assert.deepEqual(requests, []);
});

test('a hanging detail request aborts on timeout and shows the error instead of a skeleton', async () => {
    requests = [];
    scheduledTimers = [];
    clickDetail({path: '/inspections/tasks/4/'});
    await flush();
    assert.equal(requests.length, 1);

    // 详情接口一直不回：定时器到点后必须 abort，不能留着骨架永久转圈。
    assert.equal(scheduledTimers.length, 1);
    assert.equal(scheduledTimers[0].delay, 8000);
    scheduledTimers[0].callback();
    await flush();

    assert.match(box.innerHTML, /详情加载失败/);
});
