const test = require('node:test');
const assert = require('node:assert/strict');

const {createStatusPolling, hasPendingStatus, refreshTaskDetail} = require('../../static/app/js/common/task_status_poll.js');

function pollingFixture(pending = true) {
    const timers = [];
    const clock = {value: 0, clears: 0};
    const documentRoot = {
        hidden: false,
        querySelector: selector => (pending && selector === '[data-task-pending="1"]' ? {id: 'task-detail'} : null),
    };
    const browserWindow = {
        addEventListener(type, handler) { this.handlers = {...this.handlers, [type]: handler}; },
        removeEventListener() {},
        setTimeout(fn, delay) {
            timers.push({fn, delay, id: ++clock.value});
            return clock.value;
        },
        clearTimeout() { clock.clears += 1; },
    };
    return {timers, clock, documentRoot, browserWindow, setPending: value => { pending = value; }};
}

test('polling only starts when the page still has a pending task', () => {
    const idle = pollingFixture(false);
    const idlePolling = createStatusPolling({...idle, refresh: async () => {}});
    idlePolling.start();
    assert.equal(idlePolling.isPolling(), false);
    assert.equal(idle.timers.length, 0, '没有要等的任务就不该排定时器');

    const busy = pollingFixture(true);
    const busyPolling = createStatusPolling({...busy, refresh: async () => {}});
    busyPolling.start();
    assert.equal(busyPolling.isPolling(), true);
    assert.equal(busy.timers.length, 1);
    assert.equal(busy.timers[0].delay, 5000);
});

test('polling stops as soon as the refreshed page has no pending task', async () => {
    const fixture = pollingFixture(true);
    let refreshes = 0;
    const polling = createStatusPolling({
        browserWindow: fixture.browserWindow,
        documentRoot: fixture.documentRoot,
        refresh: async () => {
            refreshes += 1;
            fixture.setPending(false);
        },
    });
    polling.start();
    await fixture.timers[0].fn();

    assert.equal(refreshes, 1);
    assert.equal(polling.isPolling(), false, '终态之后不该继续轮');
    assert.equal(fixture.timers.length, 1, '不再排下一拍');
});

test('a failed refresh keeps polling instead of dying on one error', async () => {
    const fixture = pollingFixture(true);
    let attempts = 0;
    const polling = createStatusPolling({
        browserWindow: fixture.browserWindow,
        documentRoot: fixture.documentRoot,
        refresh: async () => {
            attempts += 1;
            throw new Error('502');
        },
    });
    polling.start();
    await fixture.timers[0].fn();

    assert.equal(attempts, 1);
    assert.equal(polling.isPolling(), true);
    assert.equal(fixture.timers.length, 2, '失败后仍然排了下一拍');
});

test('a hidden page does not poll until it becomes visible again', async () => {
    const fixture = pollingFixture(true);
    fixture.documentRoot.hidden = true;
    let refreshes = 0;
    const polling = createStatusPolling({
        browserWindow: fixture.browserWindow,
        documentRoot: fixture.documentRoot,
        refresh: async () => { refreshes += 1; },
    });
    polling.start();
    assert.equal(fixture.timers.length, 0, '后台标签页不排定时器');

    fixture.documentRoot.hidden = false;
    fixture.browserWindow.handlers.visibilitychange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshes, 1, '回到前台立刻补一拍');
});

test('pending detection reads the server-rendered marker, not the badge text', () => {
    assert.equal(hasPendingStatus({querySelector: sel => sel === '[data-task-pending="1"]' ? {} : null}), true);
    assert.equal(hasPendingStatus({querySelector: () => null}), false);
    assert.equal(hasPendingStatus(null), false);
});

function detailFixture({detailUrl = ''} = {}) {
    const writes = [];
    const payload = {id: 'detail-bootstrap', text: '{"old": true}'};
    const freshPayload = {id: 'detail-bootstrap', text: '{"new": true}'};
    const freshHost = {id: 'task-detail'};
    const parent = {
        querySelector: selector => selector === '#detail-bootstrap' ? payload : null,
        replaceChild(next, current) { writes.push(['payload', next.cloned, current]); },
    };
    const box = detailUrl ? {dataset: {detailUrl}, closest: () => box} : null;
    const host = {
        closest: () => box,
        parentElement: parent,
        replaceWith(node) { writes.push(['host', node.cloned]); },
    };
    const requested = [];
    const documentRoot = {
        querySelector: selector => selector === '#task-detail' ? host : null,
        importNode: node => ({cloned: node}),
        addEventListener() {},
    };
    const browserWindow = {
        location: {href: 'http://localhost/tasks/7/'},
        fetch: async url => {
            requested.push(url);
            return {ok: true, text: async () => '<html></html>'};
        },
        DOMParser: class {
            parseFromString() {
                return {getElementById: id => (id === 'task-detail' ? freshHost : id === 'detail-bootstrap' ? freshPayload : null)};
            }
        },
        mountPages: async root => { writes.push(['mount', root]); },
    };
    return {writes, requested, documentRoot, browserWindow, parent, freshHost, freshPayload, payload};
}

test('detail refresh swaps the island together with its bootstrap payload', async () => {
    const fixture = detailFixture();
    await refreshTaskDetail({documentRoot: fixture.documentRoot, browserWindow: fixture.browserWindow});

    assert.deepEqual(fixture.requested, ['http://localhost/tasks/7/']);
    // 只换宿主不换 detail-bootstrap，重挂出来的岛读的还是旧进度。
    assert.deepEqual(fixture.writes[0], ['payload', fixture.freshPayload, fixture.payload]);
    assert.deepEqual(fixture.writes[1], ['host', fixture.freshHost]);
    assert.deepEqual(fixture.writes[2], ['mount', fixture.parent]);
});

test('detail refresh in a modal fetches the fragment source, not the page url', async () => {
    const fixture = detailFixture({detailUrl: 'http://localhost/tasks/42/?modal=1'});
    await refreshTaskDetail({documentRoot: fixture.documentRoot, browserWindow: fixture.browserWindow});
    assert.deepEqual(fixture.requested, ['http://localhost/tasks/42/?modal=1']);
});
