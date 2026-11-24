/* 「表格导入」的前端解析：逗号/制表符两种分隔、表头跳过、引号里的逗号。
   解析结果直接决定 POST /api/ai/knowledge/import/ 的 rows，改坏了导入会静默丢数据。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import page from '../../static/app/vue/pages/ai_chat.mjs';

function parse(text) {
    const methods = page.methods;
    return methods.parseTable.call({splitCells: methods.splitCells}, text);
}

test('CSV：逗号分隔、跳过表头与空行', () => {
    const rows = parse('title,content,category\n\n核心交换机离线,先查上联口与电源,网络设备\n');
    assert.deepEqual(rows, [
        {title: '核心交换机离线', content: '先查上联口与电源', category: '网络设备'},
    ]);
});

test('Excel 复制：制表符分隔', () => {
    const rows = parse('标题\t内容\t分类\nAP 掉线\t先看 PoE 供电\t弱电设备\n');
    assert.deepEqual(rows, [
        {title: 'AP 掉线', content: '先看 PoE 供电', category: '弱电设备'},
    ]);
});

test('引号包裹的字段里可以有逗号，双引号用两个引号转义', () => {
    const rows = parse('"重启, 等待 30 秒","确认端口 ""up"""\n');
    assert.deepEqual(rows, [
        {title: '重启, 等待 30 秒', content: '确认端口 "up"', category: ''},
    ]);
});

test('没有表头时第一行就是数据，缺列填空串', () => {
    const rows = parse('巡检失败处置\n等待下次窗口重跑\n');
    assert.deepEqual(rows, [
        {title: '巡检失败处置', content: '', category: ''},
        {title: '等待下次窗口重跑', content: '', category: ''},
    ]);
});
