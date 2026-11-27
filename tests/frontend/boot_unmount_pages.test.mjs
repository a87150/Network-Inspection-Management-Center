/* 弹窗里塞进来的详情片段本身是一个 Vue 岛：换内容前必须先 unmountPages，
   否则 innerHTML 一覆盖，宿主节点没了但实例还在 ——
   它挂的 document 级监听器、定时器只增不减，开几次就攒几套。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {unmountPages} from '../../static/app/vue/boot.mjs';

function host(unmount) {
    const element = {dataset: {vuePage: 'record-detail'}};
    if (unmount) element.__vue_app__ = {unmount};
    return element;
}

function rootOf(hosts) {
    return {querySelectorAll: () => hosts};
}

test('挂过 __vue_app__ 的宿主被 unmount，属性也清掉', () => {
    let unmounted = 0;
    const mounted = host(() => { unmounted += 1; });
    const bare = host(null);

    unmountPages(rootOf([mounted, bare]));

    assert.equal(unmounted, 1);
    // 不清掉的话，mountPages 会以为这里已经挂过了，之后再也不挂。
    assert.equal(mounted.__vue_app__, undefined);
    assert.equal(bare.__vue_app__, undefined);
});

test('一个岛卸载失败不影响其他岛', () => {
    const order = [];
    const boom = host(() => { order.push('boom'); throw new Error('卸载炸了'); });
    const fine = host(() => { order.push('fine'); });
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
        unmountPages(rootOf([boom, fine]));
    } finally {
        console.error = originalError;
    }

    assert.deepEqual(order, ['boom', 'fine']);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /卸载/);
    // 抛错的那个也要清属性，否则它永远挂不回来了。
    assert.equal(boom.__vue_app__, undefined);
});

test('没有 querySelectorAll 的根直接跳过', () => {
    assert.doesNotThrow(() => unmountPages(null));
    assert.doesNotThrow(() => unmountPages({}));
});
