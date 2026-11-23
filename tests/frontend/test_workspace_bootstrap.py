"""五张工作区页的 bootstrap 契约。

页面外观靠浏览器点测，但「响应里的 JSON 形状对不对」可以在服务端守住：
同一份断言跑五页，任何一页长歪都会先在这里红掉。
"""
import json
import re

from django.test import TestCase

from tests.auth import login_admin

PAGES = (
    ('pc-workspace', '/assets/computers/'),
    ('network-workspace', '/assets/networks/'),
    ('server-workspace', '/assets/servers/'),
    ('weakcurrent-workspace', '/assets/weakcurrent/'),
    ('people-workspace', '/assets/people/'),
)


class WorkspaceBootstrapTests(TestCase):
    def setUp(self):
        login_admin(self.client)

    def bootstrap_of(self, page_key, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, url)
        body = response.content.decode()
        self.assertIn('data-vue-page="%s"' % page_key, body)
        match = re.search(
            r'<script id="%s-bootstrap" type="application/json">(.*?)</script>'
            % page_key,
            body,
            re.S,
        )
        self.assertIsNotNone(match, page_key + ' 缺少 bootstrap json_script')
        # json_script 会把中文转义成 \uXXXX，直接当字符串断言不可靠。
        return json.loads(match.group(1))

    def test_every_page_emits_one_bootstrap_shape(self):
        for page_key, url in PAGES:
            payload = self.bootstrap_of(page_key, url)
            for field in ('page', 'blocks', 'table', 'urls'):
                self.assertIn(field, payload, page_key)
            self.assertEqual(payload['table']['page'], 1, page_key)

    def test_table_columns_carry_toolbar_flags(self):
        # 工具栏靠这两个字段决定常驻/折叠哪些筛选项，缺了筛选直接消失。
        for page_key, url in PAGES:
            table = self.bootstrap_of(page_key, url)['table']
            self.assertTrue(table['columns'], page_key)
            for column in table['columns']:
                self.assertIn('filterable', column, page_key)
                self.assertIn('default_filter', column, page_key)

    def test_first_screen_rows_keep_the_detail_modal_flag(self):
        # 首屏走 row_payloads 直出，detail_modal 才在；翻页走 REST 会丢这个字段。
        for page_key, url in PAGES:
            rows = self.bootstrap_of(page_key, url)['table']['rows']
            if not rows:
                continue
            flags = [
                action.get('detail_modal')
                for row in rows
                for action in row.get('actions', [])
            ]
            self.assertIn(True, flags, page_key + ' 首屏行没有可弹窗的详情动作')

    def test_every_page_offers_an_export_link(self):
        # 工具栏只有拿到 exportUrl 才渲染「导出筛选结果」，缺了按钮会整块消失。
        for page_key, url in PAGES:
            table = self.bootstrap_of(page_key, url)['table']
            self.assertIn('/tables/', table.get('exportUrl', ''), page_key)
