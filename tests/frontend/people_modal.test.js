const test = require('node:test');
const assert = require('node:assert/strict');
const {submitPeopleModal, createLinkRequests, installPeopleModal} = require('../../static/app/js/people/modal.js');

test('submits POST without navigating and displays validation HTML in current modal', async () => {
    let result;
    await submitPeopleModal({action: 'http://localhost/integrations/people/preview/'}, {
        body: 'provider=feishu',
        fetchImpl: async (url, options) => {
            assert.equal(options.method, 'POST');
            assert.equal(options.body, 'provider=feishu');
            return {status: 400, ok: false, text: async () => '<div>预览失效</div>'};
        },
        render: html => { result = html; },
    });
    assert.equal(result, '<div>预览失效</div>');
});

test('server errors are not rendered as a replacement page', async () => {
    let rendered = false;
    await assert.rejects(submitPeopleModal({action: '/preview/'}, {
        body: '', fetchImpl: async () => ({status: 405, ok: false}),
        render: () => { rendered = true; },
    }));
    assert.equal(rendered, false);
});

function fakeLink(href) {
    const attributes = {};
    return {
        href,
        attributes,
        setAttribute(name, value) { attributes[name] = value; },
        removeAttribute(name) { delete attributes[name]; },
    };
}

test('a link already being read ignores the second click', () => {
    const link = fakeLink('/integrations/people/operations/7/');
    const requests = createLinkRequests();

    const first = requests.begin(link);
    assert.equal(first.isLatest(), true);
    assert.equal(link.attributes['aria-busy'], 'true');

    // 双击：第二次点击不再发请求，等第一次的结果就够。
    assert.equal(requests.begin(link), null);

    first.finish();
    assert.equal(link.attributes['aria-busy'], undefined);
    assert.ok(requests.begin(link), '读完这一份之后还能再点');
});

test('only the newest click may render', () => {
    const requests = createLinkRequests();
    const older = requests.begin(fakeLink('/integrations/people/operations/1/'));
    const newer = requests.begin(fakeLink('/integrations/people/operations/2/'));

    // 旧请求后到也不能落地：否则用户点了 B，看到的却是 A 的结果。
    assert.equal(older.isLatest(), false);
    assert.equal(newer.isLatest(), true);
    older.finish();
    assert.equal(newer.isLatest(), true, '旧请求收尾不影响新请求的资格');
});

/* 结果弹窗里的链接点击：去重与"只让最新响应落地"必须在真实处理链里成立。 */
function clickFixture() {
    const handlers = {};
    const rendered = [];
    const modal = {
        id: 'importModal',
        classList: {contains: () => false},
        setAttribute() {},
        querySelector: selector => selector === '.modal-content'
            ? {replaceWith(node) { rendered.push(node); }}
            : {prepend() {}},
    };
    const document = {
        addEventListener(type, handler) { handlers[type] = handler; },
        querySelector: () => null,
        getElementById: () => null,
        createElement: () => ({className: '', setAttribute() {}, prepend() {}}),
        dispatchEvent() {},
    };
    const window = {
        location: {href: 'http://localhost/'},
        Event: class { constructor(type) { this.type = type; } },
        FormData: class {},
        /* 解析出来的内容带上原始响应体，测试才能看出是哪一次响应落了地。 */
        DOMParser: class {
            parseFromString(html) {
                return {
                    querySelector: selector => selector === '#peoplePreviewModal' ? {
                        id: 'peoplePreviewModal',
                        getAttribute: () => '',
                        querySelector: () => ({cloneNode: () => ({mark: html})}),
                    } : null,
                    querySelectorAll: () => [],
                };
            }
        },
    };
    return {handlers, modal, document, window, rendered};
}

function clickableLink(href, modal) {
    return {
        href,
        closest: () => modal,
        matches: () => false,
        setAttribute() {},
        removeAttribute() {},
    };
}

test('a double click on one result link issues a single request', async () => {
    const {handlers, modal, document, window} = clickFixture();
    const requests = [];
    installPeopleModal(document, window, href => {
        requests.push(href);
        return new Promise(() => {});   // 悬着不返回：模拟慢响应窗口里的第二次点击
    });
    const link = clickableLink('http://localhost/integrations/people/operations/9/', modal);

    handlers.click({target: {closest: target => target === 'a' ? link : null}, preventDefault() {}});
    handlers.click({target: {closest: target => target === 'a' ? link : null}, preventDefault() {}});

    assert.deepEqual(requests, ['http://localhost/integrations/people/operations/9/']);
});

test('a stale response does not overwrite the newer result', async () => {
    const {handlers, modal, document, window, rendered} = clickFixture();
    const pending = new Map();
    installPeopleModal(document, window, href => new Promise(resolve => pending.set(href, resolve)));
    const olderLink = clickableLink('http://localhost/integrations/people/operations/1/', modal);
    const newerLink = clickableLink('http://localhost/integrations/people/operations/2/', modal);
    const click = link => handlers.click({target: {closest: target => target === 'a' ? link : null}, preventDefault() {}});

    click(olderLink);
    click(newerLink);
    // 新请求先回来：这份内容可以落地。
    pending.get('http://localhost/integrations/people/operations/2/')({ok: true, text: async () => 'new'});
    await new Promise(resolve => setImmediate(resolve));
    // 旧请求后回来：已经过期，不能把新内容盖掉。
    pending.get('http://localhost/integrations/people/operations/1/')({ok: true, text: async () => 'old'});
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(rendered.map(node => node.mark), ['new']);
});
