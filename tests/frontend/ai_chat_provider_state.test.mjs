/* 提供方列表与切换的两处状态坑：
   1) loadProviders 失败时不能把 providers 清空 —— 下拉会回落成「未配置」，
      用户以为保存的服务丢了；
   2) 输入区那个 select 只有单向 :value 绑定，激活失败必须把下拉拨回去，
      否则界面显示的和服务端实际生效的不是同一条。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import page from '../../static/app/vue/pages/ai_chat.mjs';

function stubGlobals() {
    globalThis.window = {location: {origin: 'http://test.local'}, setTimeout: () => 0, clearTimeout: () => {}};
    globalThis.document = {querySelector: () => null, cookie: ''};
}

function response(body, options = {}) {
    const status = options.status ?? 200;
    return {
        ok: options.ok ?? (status < 400),
        status,
        redirected: false,
        url: 'http://test.local/api/ai/providers/',
        headers: {get: () => (options.contentType || 'application/json')},
        json: async () => body,
    };
}

function queueFetch(responses) {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({url: String(url), method: options.method || 'GET'});
        const next = responses.shift();
        if (!next) throw new Error('没有预置的响应了：' + url);
        return next;
    };
    return calls;
}

function fixture(extra = {}) {
    const context = {...page.data.call({}), ...extra};
    Object.entries(page.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    Object.entries(page.computed || {}).forEach(([name, compute]) => {
        Object.defineProperty(context, name, {get: () => compute.call(context)});
    });
    return context;
}

const SAVED = [
    {id: 1, name: '旧的服务', is_active: true, base_url: 'http://a/v1', chat_model: 'm1', has_key: true},
    {id: 2, name: '新的服务', is_active: false, base_url: 'http://b/v1', chat_model: 'm2', has_key: true},
];

test('拉取提供方失败时保留上一份列表，只把错误说出来', async () => {
    stubGlobals();
    queueFetch([response({message: '后端暂时不可用'}, {status: 500})]);
    const context = fixture({providers: SAVED.map((row) => ({...row}))});

    await context.loadProviders();

    assert.equal(context.providers.length, 2);
    assert.equal(context.providers[0].name, '旧的服务');
    assert.match(context.providersError, /后端暂时不可用/);
});

test('拉取成功后错误提示清空，列表换成新的', async () => {
    stubGlobals();
    queueFetch([response({rows: [SAVED[0]]})]);
    const context = fixture({providers: [], providersError: '上一次失败'});

    await context.loadProviders();

    assert.equal(context.providers.length, 1);
    assert.equal(context.providersError, '');
});

test('激活失败时把下拉拨回服务端仍然生效的那条', async () => {
    stubGlobals();
    queueFetch([response({message: '没有权限'}, {status: 403})]);
    const context = fixture({providers: SAVED.map((row) => ({...row}))});
    const select = {value: '2'};

    await context.switchProvider({target: select});

    assert.equal(select.value, '1');
    assert.equal(context.activeProviderId, 1);
    assert.match(context.error, /权限/);
});

test('激活成功时下拉停在新选项，生效值跟着变', async () => {
    stubGlobals();
    queueFetch([
        response({ok: true}),
        response({rows: [{...SAVED[0], is_active: false}, {...SAVED[1], is_active: true}]}),
    ]);
    const context = fixture({providers: SAVED.map((row) => ({...row}))});
    const select = {value: '2'};

    await context.switchProvider({target: select});

    assert.equal(select.value, '2');
    assert.equal(context.error, '');
    assert.equal(context.activeProviderId, 2);
});
