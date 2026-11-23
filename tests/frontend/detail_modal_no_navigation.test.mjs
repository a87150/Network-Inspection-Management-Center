/* 详情弹窗内的翻页、排序、筛选必须是岛内 fetch 重载：
   section.pagination.page_url 只是接口锚点，不许碰地址栏、不许开第二层弹窗。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import ResourceDetail from '../../static/app/vue/pages/resource_detail.mjs';

const BOOTSTRAP = JSON.stringify({
    sections: [
        {kind: 'alert', level: 'success', text: '第二页'},
        {kind: 'table', heading: '目标', columns: [{label: '名称'}], rows: [['第二页的行']]},
    ],
});

function stubWindow(overrides = {}) {
    const location = {pathname: '/inspections/tasks/9/', search: '', hash: ''};
    globalThis.window = {location, bootstrap: null, ...overrides};
    return location;
}

function stubNetwork() {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({url: String(url), headers: options.headers || {}});
        return {
            ok: true,
            status: 200,
            text: async () => '<html><body><script id="detail-bootstrap" type="application/json">'
                + BOOTSTRAP + '</script></body></html>',
        };
    };
    globalThis.DOMParser = class {
        parseFromString() {
            return {
                getElementById: (id) => (id === 'detail-bootstrap'
                    ? {textContent: BOOTSTRAP}
                    : null),
            };
        }
    };
    return calls;
}

function fixture(extra = {}) {
    const context = {...ResourceDetail.data.call({}), ...extra};
    for (const [name, method] of Object.entries(ResourceDetail.methods)) {
        context[name] = method.bind(context);
    }
    return context;
}

test('翻页只在岛内重载分区，不写地址栏、不开新弹窗', async () => {
    const location = stubWindow();
    const calls = stubNetwork();
    const context = fixture({
        $el: {dataset: {vueBootstrap: 'detail-bootstrap'}, closest: () => null},
    });

    await context.goSectionPage(
        {pagination: {page_url: '/inspections/tasks/9/?target_page='}},
        2,
    );

    assert.deepEqual(calls.map((call) => call.url), ['/inspections/tasks/9/?target_page=2']);
    assert.equal(calls[0].headers['X-Requested-With'], 'XMLHttpRequest');
    assert.equal(context.liveSections[1].rows[0][0], '第二页的行');
    assert.equal(location.hash, '');
    assert.equal(context.reloading, false);
});

test('弹窗里用 data-detail-url 当接口锚点，排序和筛选都拼到详情页地址上', () => {
    stubWindow();
    stubNetwork();
    const context = fixture({
        $el: {
            dataset: {vueBootstrap: 'detail-bootstrap'},
            closest: () => ({dataset: {detailUrl: '/inspections/tasks/9/?modal=1'}}),
        },
    });

    assert.equal(context.sortHref({sort_url: '?sort=name&order=asc'}),
        '/inspections/tasks/9/?sort=name&order=asc');
    assert.equal(context.detailBase(), '/inspections/tasks/9/');
});

test('独立详情页没有 data-detail-url 时退回当前地址', async () => {
    stubWindow();
    const calls = stubNetwork();
    const context = fixture({
        $el: {dataset: {vueBootstrap: 'detail-bootstrap'}, closest: () => null},
    });

    await context.reloadWith('?filter_status=abnormal');

    assert.deepEqual(calls.map((call) => call.url),
        ['/inspections/tasks/9/?filter_status=abnormal']);
});

test('返回列表在弹窗里是关弹窗，在独立详情页里放行链接', () => {
    stubWindow();
    stubNetwork();
    let hidden = 0;
    globalThis.window.bootstrap = {
        Modal: {getOrCreateInstance: () => ({hide: () => { hidden += 1; }})},
    };

    const inside = fixture({$el: {dataset: {}, closest: () => ({})}});
    let prevented = 0;
    inside.closeAction({preventDefault: () => { prevented += 1; }});
    assert.equal(prevented, 1);
    assert.equal(hidden, 1);

    const standalone = fixture({$el: {dataset: {}, closest: () => null}});
    prevented = 0;
    standalone.closeAction({preventDefault: () => { prevented += 1; }});
    assert.equal(prevented, 0);
    assert.equal(hidden, 1);
});

test('取不到详情数据时保留旧分区，不炸掉弹窗', async () => {
    stubWindow();
    globalThis.fetch = async () => ({ok: false, status: 500, text: async () => ''});
    globalThis.DOMParser = class {
        parseFromString() { return {getElementById: () => null}; }
    };
    const context = fixture({
        $el: {dataset: {vueBootstrap: 'detail-bootstrap'}, closest: () => null},
    });
    context.liveSections = [{kind: 'text', text: '旧内容'}];
    const originalError = console.error;
    console.error = () => {};
    try {
        await context.reloadWith('?target_page=3');
    } finally {
        console.error = originalError;
    }
    assert.equal(context.liveSections[0].text, '旧内容');
    assert.equal(context.reloading, false);
});
