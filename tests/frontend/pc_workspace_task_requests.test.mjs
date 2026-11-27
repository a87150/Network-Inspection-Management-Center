/* 分析面板的两条网络路径（点任务换统计、任务栏翻页）以前都是裸 fetch：
   !ok 直接 return（点了没有任何反馈），会话过期时服务端跟随 302 给出 200 的
   登录页 HTML，response.json() 抛出的 rejection 没人接（控制台报错、界面不动）。
   连点两条任务还会互相覆盖。这里把四条都钉住。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import page from '../../static/app/vue/pages/pc_workspace.mjs';

const BASE_PROPS = {page: {view: 'analyses'}, blocks: [], table: {}, assets: {}, logs: {}, analyses: {}, urls: {}, csrf: ''};

function fixture(analyses, extra = {}) {
    const context = {...page.data.call(BASE_PROPS), analyses, ...extra};
    Object.entries(page.methods).forEach(([name, method]) => {
        context[name] = method.bind(context);
    });
    Object.entries(page.computed || {}).forEach(([name, compute]) => {
        Object.defineProperty(context, name, {get: () => compute.call(context)});
    });
    return context;
}

const ANALYSES = {
    statsUrl: '/api/x/stats/',
    tasks: {endpoint: '/api/x/tasks/', rows: [], page: 1, pages: 3},
};

function jsonResponse(body, {status = 200} = {}) {
    return {ok: status < 400, status, json: async () => body};
}

function htmlResponse() {
    return {ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }};
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return {promise, resolve, reject};
}

test('点任务遇到非 2xx：给出提示，统计保持原样', async () => {
    globalThis.fetch = async () => jsonResponse({message: 'nope'}, {status: 500});
    const context = fixture(ANALYSES, {statsView: {total: 7}});

    await context.selectTask({id: 3});

    assert.equal(context.statsView.total, 7);
    assert.match(context.taskError, /加载失败/);
    assert.equal(context.statsBusy, false);
});

test('点任务拿到登录页 HTML 时不产生未处理的 rejection', async () => {
    globalThis.fetch = async () => htmlResponse();
    const context = fixture(ANALYSES, {statsView: {total: 7}});
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
        await context.selectTask({id: 3});
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(unhandled, []);
    assert.equal(context.statsView.total, 7);
    assert.match(context.taskError, /加载失败/);
});

test('连点两条任务时后点的赢，先发的旧响应不覆盖', async () => {
    const first = deferred();
    const second = deferred();
    globalThis.fetch = (url) => (String(url).includes('task=1') ? first.promise : second.promise);
    const context = fixture(ANALYSES);

    const older = context.selectTask({id: 1});
    const newer = context.selectTask({id: 2});
    second.resolve(jsonResponse({total: 22}));
    await newer;
    first.resolve(jsonResponse({total: 11}));
    await older;

    assert.equal(context.statsView.total, 22);
    assert.equal(context.taskData.selected_id, 2);
    assert.equal(context.statsBusy, false);
    assert.equal(context.taskError, '');
});

test('旧请求的失败也不许写入提示', async () => {
    const first = deferred();
    const second = deferred();
    globalThis.fetch = (url) => (String(url).includes('task=1') ? first.promise : second.promise);
    const context = fixture(ANALYSES);

    const older = context.selectTask({id: 1});
    const newer = context.selectTask({id: 2});
    second.resolve(jsonResponse({total: 22}));
    await newer;
    first.reject(new Error('网络断了'));
    await older;

    assert.equal(context.taskError, '');
    assert.equal(context.statsView.total, 22);
});

test('任务栏翻页拿到登录页 HTML 时给提示并解除 busy', async () => {
    globalThis.fetch = async () => htmlResponse();
    const context = fixture(ANALYSES);

    await context.goTaskPage(2);

    assert.match(context.taskError, /加载失败/);
    assert.equal(context.tasksBusy, false);
    assert.equal(context.tasks, null);
});

test('任务栏翻页遇到非 2xx 也不静默', async () => {
    globalThis.fetch = async () => jsonResponse({}, {status: 403});
    const context = fixture(ANALYSES, {taskError: '之前那条'});

    await context.goTaskPage(2);

    assert.match(context.taskError, /加载失败/);
    assert.equal(context.tasksBusy, false);
});
