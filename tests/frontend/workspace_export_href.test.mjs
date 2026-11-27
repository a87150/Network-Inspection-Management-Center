/* 导出链接必须保留服务端拼好的查询串。
   以前 exportHref 整体赋 url.search，把 exportUrl 自带的东西全冲掉：
   问题明细导出的 category 与 format=csv 一起没了，导出 100% 落 404；
   地址栏里的 task 也跟着丢，导出会导错任务。
   现在以自带 query 为基线，只叠加筛选参数。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import WorkspaceTable from '../../static/app/vue/components/workspace_table.mjs';

function stubGlobals() {
    globalThis.window = {location: {origin: 'http://test.local', search: ''}};
}

function exportFor(component, exportUrl, draftFilters = {}) {
    stubGlobals();
    const context = Object.assign(Object.create(null), component.methods || {});
    context.exportUrl = exportUrl;
    context.urlVersion = 0;
    context.selectedIds = [];
    context.draftFilters = draftFilters;
    context.columns = [];
    context.columnVisibility = {};
    context.shownColumns = [];
    return component.computed.exportHref.call(context);
}

test('导出保留服务端拼好的 category 与 format', () => {
    const href = exportFor(WorkspaceTable,
        '/inspections/tables/analysis-problems/export/?category=cpu&format=csv');
    const url = new URL(href, 'http://test.local');
    assert.equal(url.searchParams.get('category'), 'cpu');
    assert.equal(url.searchParams.get('format'), 'csv');
});

test('导出保留地址栏带来的 task 参数', () => {
    const href = exportFor(WorkspaceTable,
        '/tables/devices/export/?task=42');
    assert.equal(new URL(href, 'http://test.local').searchParams.get('task'), '42');
});

test('筛选参数叠加在自带 query 之上，不是替换', () => {
    const href = exportFor(WorkspaceTable,
        '/tables/devices/export/?format=csv',
        {vendor: 'h3c'});
    const url = new URL(href, 'http://test.local');
    assert.equal(url.searchParams.get('format'), 'csv');
    // apiParams 会给筛选键加 filter_ 前缀，前缀只用于接口层。
    assert.equal(url.searchParams.get('filter_vendor'), 'h3c');
});

test('导出不带页码', () => {
    const href = exportFor(WorkspaceTable, '/tables/devices/export/?format=csv&page=3');
    assert.equal(new URL(href, 'http://test.local').searchParams.get('page'), null);
});

test('勾选行时带上 target_ids，且原有参数仍在', () => {
    stubGlobals();
    const context = Object.assign(Object.create(null), WorkspaceTable.methods || {});
    context.exportUrl = '/tables/devices/export/?format=csv';
    context.urlVersion = 0;
    context.selectedIds = ['7', '9'];
    context.draftFilters = {};
    context.columns = [];
    context.columnVisibility = {};
    context.shownColumns = [];
    const url = new URL(WorkspaceTable.computed.exportHref.call(context), 'http://test.local');
    assert.equal(url.searchParams.get('target_ids'), '7,9');
    assert.equal(url.searchParams.get('format'), 'csv');
});

test('没有 exportUrl 时不给链接', () => {
    assert.equal(exportFor(WorkspaceTable, ''), '');
});
