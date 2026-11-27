/* 「增加 IP 段」是自绘弹窗：没有 Bootstrap 的 Esc、没有焦点转移、没有焦点圈闭。
   键盘用户打开后焦点还在触发按钮上，Tab 会顺着 document 走到遮罩背后的表格，
   关窗以后焦点也不回来。这里钉住 Esc、首次聚焦、Tab 圈闭、焦点回位四条。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import page from '../../static/app/vue/pages/ip_subnet_form.mjs';

function focusableNode(tagName) {
    const node = {tagName, focused: false};
    node.focus = () => {
        node.focused = true;
        ownerDoc.activeElement = node;
    };
    node.contains = () => false;
    return node;
}

let ownerDoc = null;

function fakeDocument(nodes) {
    const listeners = new Map();
    const doc = {
        activeElement: null,
        nodes: new Set(nodes),
        cookie: '',
        querySelector: () => null,
        contains(node) { return this.nodes.has(node); },
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            listeners.set(type, (listeners.get(type) || []).filter((item) => item !== handler));
        },
        keydown(event) {
            (listeners.get('keydown') || []).slice().forEach((handler) => handler(event));
        },
        count(type) { return (listeners.get(type) || []).length; },
        dispatchEvent: () => {},
    };
    ownerDoc = doc;
    return doc;
}

const CLOSE_BUTTON = () => focusableNode('BUTTON');
const CIDR_INPUT = () => focusableNode('INPUT');
const PURPOSE_SELECT = () => focusableNode('SELECT');
const SAVE_BUTTON = () => focusableNode('BUTTON');

function fixture(nodes) {
    const dialog = {contains: (node) => nodes.includes(node)};
    dialog.querySelectorAll = () => nodes;
    const context = {...page.data.call({})};
    Object.entries(page.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    context.$refs = {dialog};
    context.$nextTick = (callback) => callback();
    context.$emit = () => {};
    return context;
}

function keyEvent(key, extra = {}) {
    const record = {prevented: 0};
    return {
        event: {
            key,
            shiftKey: Boolean(extra.shiftKey),
            preventDefault: () => { record.prevented += 1; },
        },
        record,
    };
}

function setup() {
    const nodes = [CLOSE_BUTTON(), CIDR_INPUT(), PURPOSE_SELECT(), SAVE_BUTTON()];
    const doc = fakeDocument(nodes);
    globalThis.document = doc;
    globalThis.window = {location: {origin: 'http://test.local'}};
    return {nodes, doc, context: fixture(nodes)};
}

test('打开时记住触发按钮，并把焦点挪到第一个输入框', () => {
    const {nodes, doc, context} = setup();
    const trigger = focusableNode('BUTTON');
    doc.nodes.add(trigger);
    trigger.focus();
    assert.equal(doc.activeElement, trigger);

    context.show();

    assert.equal(context.open, true);
    assert.equal(nodes[1].focused, true);
    assert.equal(context.returnFocusTo, trigger);
});

test('Esc 关闭弹窗，并把焦点还给触发按钮', () => {
    const {doc, context} = setup();
    const trigger = focusableNode('BUTTON');
    // 触发按钮在弹窗外面，但确实还在页面上：document.contains 为真。
    doc.nodes.add(trigger);
    trigger.focus();
    context.show();

    const {event, record} = keyEvent('Escape');
    context.onKeydown(event);

    assert.equal(record.prevented, 1);
    assert.equal(context.open, false);
    assert.equal(doc.activeElement, trigger);
});

test('提交中的 Esc 不关窗，和 hide() 同一道闸', () => {
    const {context} = setup();
    context.show();
    context.submitting = true;

    context.onKeydown(keyEvent('Escape').event);

    assert.equal(context.open, true);
    context.submitting = false;
});

test('Tab 到最后一个控件后回到第一个，Shift+Tab 反过来', () => {
    const {nodes, doc, context} = setup();
    context.show();
    doc.activeElement = nodes[3];

    const forward = keyEvent('Tab');
    context.onKeydown(forward.event);
    assert.equal(forward.record.prevented, 1);
    assert.equal(nodes[0].focused, true);

    doc.activeElement = nodes[0];
    const backward = keyEvent('Tab', {shiftKey: true});
    context.onKeydown(backward.event);
    assert.equal(backward.record.prevented, 1);
    assert.equal(nodes[3].focused, true);
});

test('焦点跑到遮罩背后时，Tab 把焦点拉回弹窗', () => {
    const {nodes, doc, context} = setup();
    context.show();
    const outside = focusableNode('A');
    doc.activeElement = outside;

    const tab = keyEvent('Tab');
    context.onKeydown(tab.event);

    assert.equal(tab.record.prevented, 1);
    assert.equal(nodes[0].focused, true);
});

test('弹窗没开时完全不碰键盘事件', () => {
    const {context} = setup();
    const {event, record} = keyEvent('Escape');
    context.onKeydown(event);
    assert.equal(record.prevented, 0);
    assert.equal(context.open, false);
});

test('mounted 挂监听、unmounted 摘监听，一次只一份', () => {
    const {doc, context} = setup();
    page.mounted.call(context);
    assert.equal(doc.count('keydown'), 1);
    page.unmounted.call(context);
    assert.equal(doc.count('keydown'), 0);
});

test('提交成功后关窗并回位焦点', async () => {
    const {doc, context} = setup();
    globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type) { this.type = type; } };
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: {get: () => 'application/json'},
        json: async () => ({id: 1}),
    });
    const trigger = focusableNode('BUTTON');
    doc.nodes.add(trigger);
    trigger.focus();
    context.show();

    await context.submit();

    assert.equal(context.open, false);
    assert.equal(doc.activeElement, trigger);
    assert.equal(context.submitting, false);
});
