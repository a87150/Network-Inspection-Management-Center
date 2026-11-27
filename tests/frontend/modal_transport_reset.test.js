'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {installModalTransport} = require('../../static/app/js/common/modal_transport.js');

// 关闭弹窗只看 hidden.bs.modal 这一条路径：它必须把表单复位、把上一次的错误块
// 摘掉，否则下次打开会先看到上次的输入和上次的报错。
function fixture() {
    const listeners = {};
    const field = {name: 'hostname', value: 'edited name', defaultValue: 'server value'};
    const form = {
        id: 'config-form',
        elements: [field],
        resetCalls: 0,
        reset() {
            this.resetCalls += 1;
            field.value = field.defaultValue;
        },
        getAttribute: () => '/save/',
        closest: () => modal,
    };
    const blocks = [
        {name: '[data-modal-feedback]', removed: false, remove() { this.removed = true; }},
        {name: '[data-modal-result]', removed: false, remove() { this.removed = true; }},
        {name: '.invalid-feedback', removed: false, remove() { this.removed = true; }},
    ];
    const modal = {
        id: 'profileConfigModal',
        querySelectorAll(selector) {
            return selector === 'form' ? [form] : blocks;
        },
    };
    const doc = {
        addEventListener(name, handler) { listeners[name] = handler; },
        getElementById: () => null,
        createElement: () => ({dataset: {}, setAttribute() {}}),
        querySelector: () => null,
    };
    const win = {
        location: {href: 'http://localhost/assets/networks/', origin: 'http://localhost'},
        bootstrap: {Modal: {getOrCreateInstance: () => ({show() {}})}},
        fetch: async () => { throw new Error('closing must not fetch'); },
    };
    installModalTransport(doc, win);
    let reloaded = 0;
    doc.addEventListener('app:modal-updated', () => { reloaded += 1; });
    return {
        field,
        form,
        blocks,
        close: () => listeners['hidden.bs.modal']({target: modal}),
        reloaded: () => reloaded,
    };
}

test('closing a modal resets the form and clears the previous error blocks', () => {
    const state = fixture();
    assert.equal(state.field.value, 'edited name');

    state.close();

    assert.equal(state.form.resetCalls, 1);
    assert.equal(state.field.value, 'server value');
    assert.deepEqual(state.blocks.map((block) => block.removed), [true, true, true]);
    // 关闭本身不该再触发列表刷新，除非这次提交标记过 reloadOnClose。
    assert.equal(state.reloaded(), 0);
});
