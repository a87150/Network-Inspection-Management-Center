/* 列宽手柄必须能用键盘操作：它原来只是个 span + mousedown，
   Tab 根本走不到，方向键也没有任何处理，键盘用户完全调不了列宽。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import page from '../../static/app/vue/components/data_table.mjs';

const MIN = 72;
const STEP = 16;

function stubStorage() {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, value); },
    };
    return store;
}

function fixture(widths = {}) {
    const context = {...page.data.call({}), tableKey: 'demo', widths};
    Object.entries(page.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    return context;
}

function keyEvent(key, extra = {}) {
    const record = {key, prevented: 0, stopped: 0, ...extra};
    return {
        event: {
            key,
            preventDefault: () => { record.prevented += 1; },
            stopPropagation: () => { record.stopped += 1; },
            currentTarget: {closest: () => ({getBoundingClientRect: () => ({width: extra.thWidth || 200})})},
        },
        record,
    };
}

test('手柄可以聚焦，并且挂了 keydown', () => {
    assert.match(page.template, /class="table-resize-handle"[^>]*tabindex="0"/);
    assert.match(page.template, /@keydown="resizeByKeyboard\(column, \$event\)"/);
    assert.match(page.template, /@mousedown="startResize\(column, \$event\)"/);
});

test('右键扩大一档，并写进 localStorage', () => {
    const store = stubStorage();
    const context = fixture({});
    const {event, record} = keyEvent('ArrowRight', {thWidth: 200});
    context.resizeByKeyboard({key: 'name'}, event);
    assert.equal(context.widths.name, 200 + STEP);
    assert.equal(record.prevented, 1);
    assert.equal(JSON.parse(store.get('table-widths:demo')).name, 200 + STEP);
});

test('左键缩小，但不越过和拖拽同一个下限', () => {
    stubStorage();
    const context = fixture({name: 90});
    context.resizeByKeyboard({key: 'name'}, keyEvent('ArrowLeft', {thWidth: 90}).event);
    assert.equal(context.widths.name, 90 - STEP);

    context.widths = {name: MIN};
    context.resizeByKeyboard({key: 'name'}, keyEvent('ArrowLeft', {thWidth: MIN}).event);
    assert.equal(context.widths.name, MIN);
});

test('拖过一次之后方向键从存下来的宽度起步，而不是从实际渲染宽度', () => {
    stubStorage();
    const context = fixture({name: 320});
    context.resizeByKeyboard({key: 'name'}, keyEvent('ArrowRight', {thWidth: 40}).event);
    assert.equal(context.widths.name, 320 + STEP);
});

test('Home 清掉这一列存下来的宽度，回到自动排版', () => {
    const store = stubStorage();
    const context = fixture({name: 300});
    context.resizeByKeyboard({key: 'name'}, keyEvent('Home', {thWidth: 300}).event);
    assert.deepEqual(context.widths, {});
    assert.equal(JSON.parse(store.get('table-widths:demo')).name, undefined);
});

test('别的键不动列宽，也不拦默认行为', () => {
    stubStorage();
    const context = fixture({name: 150});
    const {event, record} = keyEvent('ArrowUp', {thWidth: 150});
    context.resizeByKeyboard({key: 'name'}, event);
    assert.equal(context.widths.name, 150);
    assert.equal(record.prevented, 0);
});
