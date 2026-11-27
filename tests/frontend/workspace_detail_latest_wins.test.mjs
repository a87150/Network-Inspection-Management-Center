/* 详情弹窗的请求闸门。
   以前用 loading / detailLoading 当闸门，loading 期内的第二次点击被整条丢弃：
   弹窗最终显示的是第一次点的那行；第一次请求要是挂住不回来，后续点击永久失效。
   现在改成请求序号，后点的那次赢。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import DetailModal from '../../static/app/vue/components/detail_modal.mjs';
import AssetWorkspace from '../../static/app/vue/pages/asset_workspace.mjs';

function stubGlobals() {
    globalThis.window = {location: {origin: 'http://test.local', search: ''}, bootstrap: null};
    globalThis.document = {querySelector: () => null, cookie: ''};
}

function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        redirected: false,
        url: 'http://test.local/detail.json',
        headers: {get: () => 'application/json'},
        json: async () => body,
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return {promise, resolve, reject};
}

function fixture(component, extra = {}) {
    const context = {...component.data.call({}), ...extra};
    Object.entries(component.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    Object.entries(component.computed || {}).forEach(([name, compute]) => {
        Object.defineProperty(context, name, {get: () => compute.call(context)});
    });
    return context;
}

function fakeModal() {
    const classes = new Set();
    return {
        dataset: {},
        style: {},
        classList: {add: (name) => classes.add(name), remove: (name) => classes.delete(name)},
        removeAttribute: () => {},
        classes,
    };
}

function modalFixture(extra = {}) {
    const modal = fakeModal();
    return fixture(DetailModal, {base: '/assets/', $refs: {modal}, ...extra});
}

test('详情弹窗：loading 期内的第二次点击不会被丢掉', async () => {
    stubGlobals();
    const requests = [];
    globalThis.fetch = (url) => {
        const pending = deferred();
        requests.push({url: String(url), pending});
        return pending.promise;
    };
    const context = modalFixture();

    context.open('1');
    context.open('2');

    assert.equal(requests.length, 2);
    // api.get 走 URL 拼装，url 是绝对地址；这里只认路径部分，两次都发出去了就算过。
    assert.deepEqual(requests.map((item) => new URL(item.url).pathname), [
        '/assets/1/detail.json',
        '/assets/2/detail.json',
    ]);
    // 收尾，避免悬着的 promise 泄漏到别的用例。
    requests.forEach((item) => item.pending.resolve(jsonResponse({title: 'x'})));
});

test('详情弹窗：先点的慢响应回来也不覆盖后点的结果', async () => {
    stubGlobals();
    const first = deferred();
    const second = deferred();
    globalThis.fetch = (url) => (String(url).includes('/1/') ? first.promise : second.promise);
    const context = modalFixture();

    const older = context.open('1');
    const newer = context.open('2');
    second.resolve(jsonResponse({title: '第二行'}));
    await newer;
    first.resolve(jsonResponse({title: '第一行'}));
    await older;

    assert.equal(context.detail.title, '第二行');
    assert.equal(context.loading, false);
    assert.equal(context.error, '');
});

test('详情弹窗：先点的请求失败也不写错误提示', async () => {
    stubGlobals();
    const first = deferred();
    const second = deferred();
    globalThis.fetch = (url) => (String(url).includes('/1/') ? first.promise : second.promise);
    const context = modalFixture();

    const older = context.open('1');
    const newer = context.open('2');
    second.resolve(jsonResponse({title: '第二行'}));
    await newer;
    first.reject(new Error('网络断了'));
    await older;

    assert.equal(context.error, '');
    assert.equal(context.detail.title, '第二行');
});

test('详情弹窗：关窗作废在途请求，慢响应不会再往里填数据', async () => {
    stubGlobals();
    const request = deferred();
    globalThis.fetch = () => request.promise;
    const context = modalFixture();

    const pending = context.open('1');
    context.close();
    request.resolve(jsonResponse({title: '迟到的第一行'}));
    await pending;

    assert.equal(context.detail, null);
    assert.equal(context.loading, false);
});

test('资产工作区：连点两行时后点的赢', async () => {
    stubGlobals();
    const first = deferred();
    const second = deferred();
    globalThis.fetch = (url) => (String(url).includes('/1/') ? first.promise : second.promise);
    const context = fixture(AssetWorkspace, {
        detailBase: '/assets/',
        $refs: {detailModal: fakeModal()},
    });

    const older = context.openDetail({id: '1'});
    const newer = context.openDetail({id: '2'});
    second.resolve(jsonResponse({title: '第二行'}));
    await newer;
    first.resolve(jsonResponse({title: '第一行'}));
    await older;

    assert.equal(context.detail.title, '第二行');
    assert.equal(context.detailId, '2');
    assert.equal(context.detailLoading, false);
});

test('资产工作区：第一次请求挂死也不挡住之后的点击', async () => {
    stubGlobals();
    const stuck = deferred();
    globalThis.fetch = (url) => (String(url).includes('/1/') ? stuck.promise : Promise.resolve(jsonResponse({title: '第二行'})));
    const context = fixture(AssetWorkspace, {
        detailBase: '/assets/',
        $refs: {detailModal: fakeModal()},
    });

    context.openDetail({id: '1'});
    await context.openDetail({id: '2'});

    assert.equal(context.detail.title, '第二行');
    assert.equal(context.detailLoading, false);
    stuck.resolve(jsonResponse({title: '第一行'}));
});

test('资产工作区：先点的失败不覆盖后点的成功', async () => {
    stubGlobals();
    const first = deferred();
    const second = deferred();
    globalThis.fetch = (url) => (String(url).includes('/1/') ? first.promise : second.promise);
    const context = fixture(AssetWorkspace, {
        detailBase: '/assets/',
        $refs: {detailModal: fakeModal()},
    });

    const older = context.openDetail({id: '1'});
    const newer = context.openDetail({id: '2'});
    second.resolve(jsonResponse({title: '第二行'}));
    await newer;
    first.reject(new Error('第一行加载失败'));
    await older;

    assert.equal(context.detailError, '');
    assert.equal(context.detail.title, '第二行');
});
