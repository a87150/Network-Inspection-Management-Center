const test = require('node:test');
const assert = require('node:assert/strict');

const {createPeopleTaskController} = require('../../static/app/js/people/import_tasks.js');

function fixture(payloads, {workflowOpen = false} = {}) {
    const posts = [];
    const state = {
        running: [], message: '', href: '', shows: 0, inline: [], jumpHandler: null,
        resultRequests: [], events: [], appended: [],
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
                '[data-people-completion-close]': {addEventListener() {}},
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
        querySelector: selector => selector === '[data-people-task-notifications]' ? root : (
            workflowOpen ? {querySelector: () => ({prepend: notice => state.inline.push(notice)})} : null
        ),
        body: {appendChild(node) { state.appended.push(node); }},
        dispatchEvent(event) { state.events.push(event); },
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
        setTimeout: () => 1,
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
        return {ok: true, json: async () => payloads.shift() || {tasks: []}};
    };
    return {controller: createPeopleTaskController({document, window, fetchImpl}), state, posts, window};
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
