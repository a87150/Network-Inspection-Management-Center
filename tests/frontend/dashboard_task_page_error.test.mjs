/* 首页巡检任务栏翻页：以前是裸 fetch 无 catch。
   会话过期时视图回 302 → /login/，fetch 跟随后拿到 200 的 HTML，response.ok 为真，
   json() 抛出的 rejection 没人接 —— 用户点翻页毫无反应。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import page from '../../static/app/vue/pages/dashboard_index.mjs';

const TASKBAR = {
    endpoint: '/api/x/tasks/',
    rows: [{id: 9, title: '最新任务'}],
    count: 30,
    page: 1,
    pages: 3,
};

function fixture(extra = {}) {
    const context = {...page.data.call({taskbar: TASKBAR}), ...extra};
    Object.entries(page.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    return context;
}

function htmlResponse() {
    // 登录页：ok 为真，body 不是 JSON。
    return {ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }};
}

test('翻页拿到登录页 HTML 时给提示，不产生未处理的 rejection', async () => {
    globalThis.fetch = async () => htmlResponse();
    const context = fixture();
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
        await context.goTaskPage(2);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(unhandled, []);
    assert.match(context.taskError, /加载失败/);
    assert.equal(context.taskBusy, false);
    assert.equal(context.taskData.page, 1);
});

test('翻页遇到非 2xx 也说出来', async () => {
    globalThis.fetch = async () => ({ok: false, status: 500, json: async () => ({})});
    const context = fixture();

    await context.goTaskPage(2);

    assert.match(context.taskError, /加载失败/);
    assert.equal(context.taskBusy, false);
});

test('翻页成功时换掉任务栏并清掉上一次的错误', async () => {
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({...TASKBAR, page: 2, rows: [{id: 8, title: '第二页任务'}]}),
    });
    const context = fixture({taskError: '上一次失败'});

    await context.goTaskPage(2);

    assert.equal(context.taskData.page, 2);
    assert.equal(context.taskData.rows[0].id, 8);
    // endpoint 不跟着 payload 走的话，翻第二页就会丢掉地址。
    assert.equal(context.taskData.endpoint, '/api/x/tasks/');
    assert.equal(context.taskError, '');
    assert.equal(context.taskBusy, false);
});
