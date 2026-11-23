"""前端表格列 key 必须和后端 TableDefinition 的字段 key 一致。

data-column-key 有两个消费方，都按 key 集合做判断：
  1. table_workspace.js 的自定义表格（列开关）给 th/td 打 hidden；
  2. 排序参数 sort=<key> 由 apply_table_filters 按 definition 过滤。
对不上的列会被永久藏掉，排序也会被静默忽略——所以这里直接拿 registry 当基准比。
"""
import re
from pathlib import Path

from django.test import SimpleTestCase

from index.common.table_registry import get_table_definition

PAGES_ROOT = Path(__file__).resolve().parents[2] / 'static' / 'app' / 'vue' / 'pages'


def frontend_column_keys(page):
    source = (PAGES_ROOT / page).read_text(encoding='utf-8')
    block = re.search(r'columns: \[(.*?)\n\s*\],', source, re.S)
    return re.findall(r"key: '([^']+)'", block.group(1)) if block else []


class AlertListColumnKeyTests(SimpleTestCase):
    def test_alert_list_columns_follow_the_registry_fields(self):
        expected = [field.key for field in get_table_definition('alert_events').fields]

        self.assertEqual(frontend_column_keys('alert_list.mjs'), expected)
