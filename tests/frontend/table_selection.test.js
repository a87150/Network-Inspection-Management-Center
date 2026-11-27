'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let selection = {};
try {
    selection = require('../../static/app/js/common/table_selection.js');
} catch (_error) {
    selection = {};
}

test('selection module builds one or many device configuration downloads', () => {
    assert.equal(typeof selection.configurationDownloadState, 'function');
    const href = 'https://example.test/assets/networks/configurations.zip';

    assert.deepEqual(selection.configurationDownloadState(href, []), {
        href: '',
        disabled: true,
        label: '请先选择设备',
    });
    assert.equal(
        selection.configurationDownloadState(href, ['a', 'b']).href,
        'https://example.test/assets/networks/configurations.zip?target_ids=a%2Cb',
    );
});

test('selection module inverts enabled choices only', () => {
    assert.equal(typeof selection.updateTargetSelection, 'function');
    const targets = [
        {checked: true, disabled: false},
        {checked: false, disabled: false},
        {checked: false, disabled: true},
    ];

    selection.updateTargetSelection(targets, 'invert');

    assert.deepEqual(targets.map(target => target.checked), [false, true, false]);
});

test('clearing every selected device drops the stale download link', () => {
    assert.equal(typeof selection.updateConfigurationDownload, 'function');
    const attributes = new Map([
        ['href', 'https://example.test/assets/networks/configurations.zip?target_ids=old-a%2Cold-b'],
    ]);
    const classes = new Set();
    const button = {
        textContent: '下载所选配置（2）',
        getAttribute: name => attributes.get(name) ?? null,
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); },
        classList: {toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }},
    };

    selection.updateConfigurationDownload(button, [
        {checked: false, value: 'old-a'},
        {checked: false, value: 'old-b'},
    ]);

    // href 还挂着上一次的 target_ids 时，中键/右键「在新标签页打开」照样能下到那批配置。
    assert.equal(attributes.has('href'), false);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('tabindex'), '-1');
    assert.equal(classes.has('disabled'), true);

    // 再选回来时靠留底的原地址还原，不能拼到已被摘掉的 href 后面。
    selection.updateConfigurationDownload(button, [{checked: true, value: 'new-a'}]);
    assert.equal(
        attributes.get('href'),
        'https://example.test/assets/networks/configurations.zip?target_ids=new-a',
    );
    assert.equal(attributes.has('tabindex'), false);
});

test('selection module keeps failed downloads in same-layer feedback', async () => {
    assert.equal(typeof selection.handleConfigurationDownload, 'function');
    const attributes = new Map([['aria-disabled', 'false']]);
    const feedback = {hidden: true, textContent: ''};
    const link = {
        href: '/configurations.zip?target_ids=a',
        getAttribute(name) { return attributes.get(name); },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
    };
    const result = await selection.handleConfigurationDownload(
        {preventDefault() {}},
        link,
        feedback,
        {fetch: async () => ({
            ok: false,
            status: 409,
            headers: {get: () => 'text/plain'},
            text: async () => '没有可下载配置。',
        })},
    );

    assert.equal(result.ok, false);
    assert.equal(feedback.textContent, '没有可下载配置。');
    assert.equal(feedback.hidden, false);
});
