const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const {templatePath} = require('./templates.js');

const root = resolve(__dirname, '../..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

test('shared responsive rules assign horizontal overflow only to table regions', () => {
  const foundation = read('static/app/css/foundation.css');
  const operations = read('static/app/css/operations.css');
  const combined = `${foundation}\n${operations}`;

  assert.match(combined, /\.table-responsive\s*\{[^}]*overflow-x:\s*auto/s);
  assert.doesNotMatch(combined, /(?:body|\.app-main)\s*\{[^}]*overflow-x:\s*auto/s);
});

test('shared action and pagination groups wrap instead of overflowing', () => {
  const foundation = read('static/app/css/foundation.css');
  const operations = read('static/app/css/operations.css');
  const combined = `${foundation}\n${operations}`;

  assert.match(combined, /\.table-filter-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(combined, /\.page-heading__actions[^\{]*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(combined, /\.page-pagination \.pagination\s*\{[^}]*flex-wrap:\s*wrap/s);
});

test('mobile and reduced-motion contracts use shared breakpoints and touch token', () => {
  const tokens = read('static/app/css/tokens.css');
  const foundation = read('static/app/css/foundation.css');
  const modal = read('static/app/css/modal-workflows.css');
  const combined = `${foundation}\n${modal}`;

  assert.match(tokens, /--control-touch-size:\s*2\.75rem/);
  assert.match(combined, /@media \(max-width:\s*767\.98px\)/);
  assert.match(combined, /@media \(max-width:\s*575\.98px\)/);
  assert.match(combined, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(combined, /min-height:\s*var\(--control-touch-size\)/);
});

test('table and modal components own scrolling without assigning it to modal content', () => {
  const modal = read('static/app/css/modal-workflows.css');
  const templates = [
    templatePath('inspections/profile_modal.html'),
    templatePath('pc/config_modal.html'),
    templatePath('common/import_modal.html'),
    templatePath('domain/group_members.html'),
  ].map(read).join('\n');

  assert.match(modal, /\.modal-body--scroll\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(modal, /\.modal-content\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(modal, /max-height:\s*calc\(100dvh - 1rem\)/);
  assert.match(modal, /\.modal-shell \.modal-header,[\s\S]*?flex:\s*0 0 auto/);
  assert.match(modal, /@media \(max-width:\s*575\.98px\)[\s\S]*?\.modal-footer--sticky/);
  assert.equal((templates.match(/modal-dialog-scrollable/g) || []).length >= 4, true);
  assert.equal((templates.match(/modal-footer--sticky/g) || []).length >= 4, true);
});

test('decorative workspace glows stay inside the page canvas', () => {
  const foundation = read('static/app/css/foundation.css');
  const glowRule = foundation.match(/\.execution-workspace::before,[\s\S]*?\{([^}]+)\}/);

  assert.ok(glowRule, 'shared execution glow rule should exist');
  assert.match(glowRule[1], /right:\s*0/);
  assert.doesNotMatch(glowRule[1], /right:\s*-[\d.]+(?:rem|px)/);
});


test('operational ledger cells are read through the cell() contract', () => {
  // 后端给的是 {cells: {key: {text, sub, code, href}}}，不是扁平的 {key: 文本}。
  // 直接写 row[column.key] 会把整个对象插值进单元格，弹窗能打开、行数也对，
  // 但每一格都是空的——这种"看着有数据却读不出来"比报错更难被发现。
  const template = read('topology/templates/topology/operations_overview.html');
  const app = read('static/app/js/operations-overview/app.js');

  assert.ok(
    !/row\[\s*column\.key\s*\]/.test(template),
    '台账单元格必须走 cell(row, column.key)，不能直接 row[column.key]',
  );
  assert.ok(
    template.includes('cell(row, column.key).text'),
    '台账单元格必须渲染 cell(...).text',
  );
  assert.match(
    app,
    /cell\(row, key\)\s*\{/,
    'app.js 必须提供 cell(row, key) 取值函数',
  );
});

test('cell() falls back to plain text for legacy flat rows', () => {
  // 万一后端某天回退成扁平结构，cell() 要能兜住而不是抛错。
  const source = read('static/app/js/operations-overview/app.js');
  const index = source.indexOf('cell(row, key) {');
  assert.ok(index > 0, '找不到 cell() 实现');
  const body = source.slice(index, index + 400);
  assert.ok(body.includes('row.cells'), 'cell() 必须从 row.cells 取');
  assert.ok(body.includes('String(value)'), 'cell() 对非对象值要转成文本');
});
