/* 表头「全选本页」那个勾选框的状态来源。
   行勾选框是服务端 payload 通过 v-bind 塞进 DOM 的，Vue 不追踪它们的 checked，
   所以模板里必须绑 data 上的派生值；绑 methods 上的函数名拿到的是函数对象，
   恒真 —— 表头永久显示已勾选、indeterminate 永不出现。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import page from '../../static/app/vue/pages/resource_table.mjs';

function fakeDocument() {
    const listeners = new Map();
    return {
        querySelectorAll: () => [],
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const list = listeners.get(type) || [];
            listeners.set(type, list.filter((item) => item !== handler));
        },
        dispatch(type) {
            (listeners.get(type) || []).slice().forEach((handler) => handler({type}));
        },
        count(type) {
            return (listeners.get(type) || []).length;
        },
    };
}

function fixture(boxes, extra = {}) {
    const context = {...page.data.call({}), select_attr: 'data-pick', ...extra};
    Object.entries(page.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    context.$el = {querySelectorAll: () => boxes};
    context.$nextTick = (callback) => callback();
    return context;
}

test('模板绑的是状态值，不是 methods 上的函数名', () => {
    assert.match(page.template, /:checked="allChecked"/);
    assert.match(page.template, /:indeterminate\.prop="someChecked && !allChecked"/);
    assert.doesNotMatch(page.template, /:checked="allSelected"/);
    assert.equal(typeof page.methods.allSelected, 'undefined');
    assert.equal(typeof page.methods.refreshSelection, 'function');
});

test('全选、部分选、全不选三种状态都算对', () => {
    const all = [{'checked': true}, {checked: true}];
    const some = [{checked: true}, {checked: false}];
    const none = [{checked: false}, {checked: false}];

    const context = fixture(all);
    context.refreshSelection();
    assert.equal(context.allChecked, true);
    assert.equal(context.someChecked, true);

    context.$el = {querySelectorAll: () => some};
    context.refreshSelection();
    assert.equal(context.allChecked, false);
    assert.equal(context.someChecked, true);

    context.$el = {querySelectorAll: () => none};
    context.refreshSelection();
    assert.equal(context.allChecked, false);
    assert.equal(context.someChecked, false);
});

test('本页没有行时表头不算全选', () => {
    const context = fixture([]);
    context.refreshSelection();
    assert.equal(context.allChecked, false);
    assert.equal(context.someChecked, false);
});

test('点表头全选后状态立刻跟上（程序改 checked 不派发 change）', () => {
    const boxes = [{checked: false}, {checked: false}];
    const context = fixture(boxes);
    context.toggleAll({target: {checked: true}});
    assert.deepEqual(boxes.map((box) => box.checked), [true, true]);
    assert.equal(context.allChecked, true);

    context.toggleAll({target: {checked: false}});
    assert.equal(context.allChecked, false);
    assert.equal(context.someChecked, false);
});

test('行勾选框的 change 冒泡到 document 时重算状态，且只挂一个监听', () => {
    const boxes = [{checked: false}, {checked: false}];
    const context = fixture(boxes);
    const doc = fakeDocument();
    const original = globalThis.document;
    globalThis.document = doc;
    try {
        page.mounted.call(context);
        assert.equal(doc.count('change'), 1);
        boxes.forEach((box) => { box.checked = true; });
        doc.dispatch('change');
        assert.equal(context.allChecked, true);

        page.unmounted.call(context);
        assert.equal(doc.count('change'), 0);
    } finally {
        globalThis.document = original;
    }
});
