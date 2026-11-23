'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let controller = {};
try {
    controller = require('../../static/app/js/access/source_modal.js');
} catch (_error) {
    controller = {};
}

test('access source page refreshes in place only after a saved editor closes', () => {
    assert.equal(typeof controller.installSourceModalReload, 'function');
    const listeners = new Map();
    const dispatched = [];
    const refreshes = [];
    const document = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        dispatchEvent(event) { dispatched.push(event); },
        querySelector(selector) { return selector === '[data-table-workspace]' ? {} : null; },
    };
    const browserWindow = {
        location: {href: 'https://example.test/access/records/', reloads: 0, reload() { this.reloads += 1; }},
        CustomEvent: class {
            constructor(type, options) { this.type = type; this.detail = options?.detail; }
        },
        AppTableWorkspace: {
            refreshTableWorkspaces(...args) { refreshes.push(args); },
        },
    };
    const modal = {
        id: 'accessSourceModal',
        querySelector(selector) { return selector === '[data-source-saved]' ? {} : null; },
    };

    controller.installSourceModalReload(document, browserWindow);
    listeners.get('app:modal-updated')({detail: {modal}});
    listeners.get('hidden.bs.modal')({target: modal});

    // 关窗后只换页内内容：不重载整页，也不碰地址栏。
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0][1], 'https://example.test/access/records/');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'app:modal-updated');
    assert.equal(browserWindow.location.reloads, 0);
});

test('closing an editor that was not saved leaves the page alone', () => {
    const listeners = new Map();
    const refreshes = [];
    const document = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        dispatchEvent() {},
        querySelector() { return {}; },
    };
    const browserWindow = {
        location: {href: 'https://example.test/access/records/'},
        CustomEvent: class {},
        AppTableWorkspace: {refreshTableWorkspaces(...args) { refreshes.push(args); }},
    };
    const modal = {id: 'accessSourceModal', querySelector() { return null; }};

    controller.installSourceModalReload(document, browserWindow);
    listeners.get('app:modal-updated')({detail: {modal}});
    listeners.get('hidden.bs.modal')({target: modal});

    assert.deepEqual(refreshes, []);
});
