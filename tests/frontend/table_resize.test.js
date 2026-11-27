'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// table_resize.js 是经典脚本：一 require 就会扫描 document，所以先把最小 DOM
// 立起来，再加载它。列宽手柄的可访问性只能在真实 DOM 里验证，这些假节点
// 只实现 enhance() 用到的那几个方法。
function makeElement(tagName) {
    const attributes = new Map();
    const listeners = new Map();
    return {
        tagName: String(tagName).toUpperCase(),
        children: [],
        style: {},
        dataset: {},
        className: '',
        textContent: '',
        classList: {add() {}, remove() {}},
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        appendChild(child) { this.children.push(child); return child; },
        insertBefore(child) { this.children.push(child); return child; },
        addEventListener(type, listener) { listeners.set(type, listener); },
        dispatch(type, event) { listeners.get(type)?.(event); },
        getBoundingClientRect() { return {width: this.renderedWidth || 0}; },
    };
}

function buildTable() {
    let group = null;
    const head = makeElement('tr');
    const th = makeElement('th');
    const handles = [];
    th.textContent = '名称';
    th.renderedWidth = 160;
    th.querySelector = (selector) => (selector === '.table-resize-handle'
        ? (handles[0] || null) : null);
    th.appendChild = (child) => { handles.push(child); return child; };
    head.children = [th];
    head.querySelector = () => null;
    const table = makeElement('table');
    table.dataset = {tableKey: 'people'};
    table.renderedWidth = 640;
    table.querySelector = (selector) => ({
        'thead tr': head,
        colgroup: group,
    }[selector] || null);
    table.insertBefore = (node) => {
        if (node.tagName === 'COLGROUP') group = node;
        return node;
    };
    return {table, th, handles: () => handles};
}

const fixture = buildTable();
const saved = new Map();
const documentListeners = new Map();
const documentStub = {
    readyState: 'complete',
    body: {classList: {add() {}, remove() {}}},
    createElement: (tagName) => makeElement(tagName),
    querySelectorAll: (selector) => (selector === 'table.data-table' ? [fixture.table] : []),
    addEventListener: (type, listener) => { documentListeners.set(type, listener); },
    removeEventListener() {},
};
globalThis.document = documentStub;
globalThis.window = {};
globalThis.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
    removeItem: (key) => { saved.delete(key); },
};

require('../../static/app/js/common/table_resize.js');

const keyboard = (key) => {
    const event = {
        key,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
    };
    return event;
};

test('column resize handle is focusable and resizes from the keyboard', () => {
    const handle = fixture.handles()[0];
    assert.ok(handle, '表头应该挂上一个列宽手柄');
    assert.equal(handle.getAttribute('role'), 'separator');
    assert.equal(handle.getAttribute('tabindex'), '0');
    assert.match(handle.getAttribute('aria-label'), /方向键/);
    assert.equal(handle.getAttribute('aria-valuemin'), '72');

    const right = keyboard('ArrowRight');
    handle.dispatch('keydown', right);
    assert.equal(right.prevented, true);
    // 没拖过也没存过宽度时，从表头当前渲染宽度起跳，不能从 0 算。
    assert.equal(fixture.table.querySelector('colgroup').children[0].style.width, '176px');
    assert.equal(handle.getAttribute('aria-valuenow'), '176');

    handle.dispatch('keydown', keyboard('ArrowLeft'));
    handle.dispatch('keydown', keyboard('ArrowLeft'));
    assert.equal(fixture.table.querySelector('colgroup').children[0].style.width, '144px');

    // 方向键夹在同一份下限里，和拖拽不会互相踩回去。
    for (let step = 0; step < 10; step += 1) handle.dispatch('keydown', keyboard('ArrowLeft'));
    assert.equal(fixture.table.querySelector('colgroup').children[0].style.width, '72px');

    // End 撑到整表宽度，Home 回到自动列宽（把保存值删掉）。
    handle.dispatch('keydown', keyboard('End'));
    assert.equal(fixture.table.querySelector('colgroup').children[0].style.width, '640px');

    handle.dispatch('keydown', keyboard('Home'));
    assert.equal(fixture.table.querySelector('colgroup').children[0].style.width, '');
    assert.deepEqual(JSON.parse(saved.get('table-widths:people')), {});
});

test('unrelated keys keep their default behaviour inside the handle', () => {
    const handle = fixture.handles()[0];
    const tab = keyboard('Tab');
    handle.dispatch('keydown', tab);
    assert.equal(tab.prevented, false);
    assert.equal(tab.stopped, false);
});
