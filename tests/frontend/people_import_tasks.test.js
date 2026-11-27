const test = require('node:test');
const assert = require('node:assert/strict');

const {createPeopleTaskController} = require('../../static/app/js/people/import_tasks.js');

function fixture(payloads, {workflowOpen = false} = {}) {
    const posts = [];
    const timers = [];
    const handlers = {};
    const state = {
        running: [], message: '', href: '', shows: 0, inline: [], jumpHandler: null,
        resultRequests: [], events: [], appended: [], requests: 0, closeHandler: null,
    };
    const root = {
        dataset: {statusUrl: '/status/', csrfToken: 'csrf'},
        querySelector(selector) {
            return {
                '[data-people-running-list]': {replaceChildren: (...items) => { state.running = items; }},
                '[data-people-completion-message]': {set textContent(value) { state.message = value; }},
                '[data-people-completion-jump]': {
                    set href(value) { state.href = value; },
                    addEventListener(_name, handler) { state.jumpHandler = handler; },
                },
                '[data-people-completion-close]': {addEventListener(_name, handler) { state.closeHandler = handler; }},
                '#peopleTaskCompletionModal': {},
            }[selector];
        },
    };
    const incomingModal = {
        cloneNode() {
            return {
                id: 'peoplePreviewModal',
                querySelector: () => null,
                setAttribute() {},
            };
        },
    };
    const document = {
        hidden: false,
        querySelector: selector => selector === '[data-people-task-notifications]' ? root : (
            workflowOpen ? {querySelector: () => ({prepend: notice => state.inline.push(notice)})} : null
        ),
        body: {appendChild(node) { state.appended.push(node); }},
        dispatchEvent(event) { state.events.push(event); },
        addEventListener(type, handler) { (handlers[type] ||= []).push(handler); },
        createElement(tag) {
            return {
                tag, className: '', textContent: '', type: '', dataset: {}, children: [],
                append(...children) { this.children.push(...children); },
                addEventListener(_name, handler) { this.handler = handler; },
            };
        },
    };
    const window = {
        location: {assignCalls: [], assign(value) { this.assignCalls.push(value); }},
        bootstrap: {Modal: {getOrCreateInstance: () => ({show: () => { state.shows += 1; }})}},
        CustomEvent: class {
            constructor(type, options) { this.type = type; this.detail = options?.detail; }
        },
        DOMParser: class {
            parseFromString(html, type) {
                assert.equal(html, '<html>result page</html>');
                assert.equal(type, 'text/html');
                return {querySelector: selector => selector === '#peoplePreviewModal' ? incomingModal : null};
            }
        },
        addEventListener(type, handler) { (handlers[type] ||= []).push(handler); },
        /* 定时器只排队不自动执行：退避间隔要能被断言，重试也要能由测试自己驱动。 */
        setTimeout(fn, delay) { timers.push({fn, delay}); return timers.length; },
        clearTimeout() {},
    };
    const fetchImpl = async (url, options = {}) => {
        if (options.method === 'POST') {
            posts.push([url, options.body]);
            return {ok: true, json: async () => ({acknowledged: true})};
        }
        if (url !== root.dataset.statusUrl) {
            state.resultRequests.push(url);
            return {ok: true, text: async () => '<html>result page</html>'};
        }
        state.requests += 1;
        const next = payloads.shift();
        if (next && next.error) throw new Error('status failed');
        return {ok: true, json: async () => next || {tasks: []}};
    };
    /* 跑掉最老的那一拍定时器，模拟"退避时间到了"。 */
    async function runNextTimer() {
        const next = timers.shift();
        if (next) await next.fn();
        return next?.delay;
    }
    const controller = createPeopleTaskController({document, window, fetchImpl});
    return {controller, state, posts, window, document, timers, runNextTimer, handlers};
}

test('poll renders running notice without navigating or reloading', async () => {
    const task = {id: '1', message: '飞书预览正在后台运行。', status: 'running',
        show_running: true, show_terminal: false, ack_url: '/ack/1/', jump_url: '/task/1/'};
    const {controller, state, window} = fixture([{tasks: [task]}]);

    await controller.poll();

    assert.equal(state.running.length, 1);
    assert.match(state.running[0].textContent, /飞书预览正在后台运行/);
    assert.deepEqual(window.location.assignCalls, []);
});

test('running acknowledgement does not prevent one terminal popup', async () => {
    const running = {id: '2', message: '钉钉测试正在后台运行。', status: 'running',
        show_running: true, show_terminal: false, ack_url: '/ack/2/', jump_url: '/task/2/'};
    const done = {...running, message: '连接测试已完成。', status: 'success',
        show_running: false, show_terminal: true};
    const {controller, state, posts} = fixture([{tasks: [running]}, {tasks: [done]}, {tasks: [done]}]);

    await controller.poll();
    await controller.dismissRunning(running);
    await controller.poll();
    await controller.poll();

    assert.deepEqual(posts[0], ['/ack/2/', 'kind=running']);
    assert.equal(state.shows, 1);
    assert.equal(state.href, '/task/2/');
});

test('terminal acknowledgement posts terminal kind', async () => {
    const task = {id: '3', ack_url: '/ack/3/'};
    const {controller, posts} = fixture([]);

    await controller.acknowledgeTerminal(task);

    assert.deepEqual(posts[0], ['/ack/3/', 'kind=terminal']);
});

test('completed task stays inside an open workflow without stacking a second modal', async () => {
    const task = {id: '4', status: 'success', show_terminal: true,
        message: '预览已完成', jump_url: '/task/4/', ack_url: '/ack/4/'};
    const {controller, state} = fixture([{tasks: [task]}], {workflowOpen: true});
    await controller.poll();
    assert.equal(state.shows, 0);
    assert.equal(state.inline.length, 1);
    assert.equal(state.inline[0].children[0].href, '/task/4/');
});

test('result jump acknowledges the task then opens the preview in place', async () => {
    const task = {id: '5', status: 'success', show_terminal: true,
        message: '预览已完成', jump_url: '/task/5/', ack_url: '/ack/5/'};
    const {controller, state, posts, window} = fixture([{tasks: [task]}]);

    await controller.poll();
    const event = {
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
    };
    await state.jumpHandler(event);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(posts, [['/ack/5/', 'kind=terminal']]);
    // 结果页的预览弹窗就地展开：不整页跳，也不改地址栏。
    assert.deepEqual(window.location.assignCalls, []);
    assert.deepEqual(state.resultRequests, ['/task/5/']);
    assert.deepEqual(state.appended.map(node => node.id), ['peoplePreviewModal']);
    assert.equal(state.shows, 2);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].type, 'app:modal-updated');
});

test('every terminal task gets shown, one popup at a time', async () => {
    const first = {id: 'a', status: 'success', show_terminal: true,
        message: 'A 预览完成', jump_url: '/task/a/', ack_url: '/ack/a/'};
    const second = {id: 'b', status: 'failed', show_terminal: true,
        message: 'B 预览失败', jump_url: '/task/b/', ack_url: '/ack/b/'};
    const {controller, state} = fixture([{tasks: [first, second]}]);

    await controller.poll();

    // 一轮里两个终态：先给一个。弹窗被下一个顶掉，前一个结果就再也回不去了。
    assert.equal(state.shows, 1);
    assert.match(state.message, /A 预览完成/);

    // 关掉这个，队列里的下一个当场补上——不依赖下一次轮询（终态后轮询本来就停了）。
    await state.closeHandler();
    assert.equal(state.shows, 2);
    assert.match(state.message, /B 预览失败/);

    await state.closeHandler();
    assert.equal(state.shows, 2);
});

test('a failed status poll backs off and keeps retrying', async () => {
    const done = {id: 'c', status: 'success', show_terminal: true,
        message: '导入完成', jump_url: '/task/c/', ack_url: '/ack/c/'};
    const {controller, state, runNextTimer, timers} = fixture([
        {error: true}, {error: true}, {error: true},
    ]);

    await controller.poll();
    assert.equal(timers[0].delay, 3000);
    await runNextTimer();
    assert.equal(timers[0].delay, 6000);
    await runNextTimer();
    assert.equal(timers[0].delay, 12000);
    // 一次失败就永久停摆的话，这里根本不会有第三拍。
    assert.equal(state.requests, 3);

    // 服务恢复后按正常节奏继续，终态照常发现。
    const recovered = fixture([{tasks: [done]}]);
    await recovered.controller.poll();
    assert.equal(recovered.state.shows, 1);
    assert.equal(recovered.timers.length, 0);
});

test('coming back into view or online polls immediately', async () => {
    const {controller, state, document, handlers} = fixture([{tasks: []}, {tasks: []}, {tasks: []}]);
    await controller.poll();
    const before = state.requests;

    // 后台标签页的定时器会被节流甚至冻结，回到前台不能等残留的那一拍。
    document.hidden = false;
    handlers.visibilitychange[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.requests, before + 1);

    handlers.online[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.requests, before + 2);
});
