from html.parser import HTMLParser

from django.test import TestCase
from django.urls import reverse
from tests.auth import login_admin


class NavigationMenuParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current_menu = None
        self.menu_depth = 0
        self.menus = {}
        self._capture = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'li' and attributes.get('data-nav-menu'):
            self.current_menu = attributes['data-nav-menu']
            self.menu_depth = 1
            self.menus[self.current_menu] = {
                'toggle': None,
                'toggle_attributes': {},
                'links': [],
            }
            return
        if self.current_menu and tag == 'li':
            self.menu_depth += 1
        if not self.current_menu:
            return
        if tag == 'button':
            self._capture = ('toggle', attributes, [])
        elif tag == 'a':
            self._capture = ('link', attributes, [])

    def handle_data(self, data):
        if self._capture:
            self._capture[2].append(data)

    def handle_endtag(self, tag):
        if self._capture and (
            (tag == 'button' and self._capture[0] == 'toggle')
            or (tag == 'a' and self._capture[0] == 'link')
        ):
            kind, attributes, parts = self._capture
            label = ''.join(parts).strip()
            menu = self.menus[self.current_menu]
            if kind == 'toggle':
                menu['toggle'] = label
                menu['toggle_attributes'] = attributes
            else:
                menu['links'].append((label, attributes.get('href')))
            self._capture = None
        if self.current_menu and tag == 'li':
            self.menu_depth -= 1
            if self.menu_depth == 0:
                self.current_menu = None


class NavigationMenuTests(TestCase):
    def setUp(self):
        login_admin(self.client)

    def _nav_html(self):
        body = self.client.get(reverse('index')).content.decode()
        start = body.index('<ul class="navbar-nav me-auto">')
        return body[start:body.index('</ul>', start)]

    def test_primary_navigation_is_a_flat_list_of_pages(self):
        """导航是一级菜单：每项直接对应一个页面，没有下拉分组。"""
        nav = self._nav_html()
        expected = [
            ('人员·部门', reverse('asset_list', args=['people'])),
            ('域控管理', reverse('domain_controller_settings') + '?object=accounts'),
            ('PC', reverse('asset_list', args=['computers'])),
            ('网络设备', reverse('asset_list', args=['networks'])),
            ('服务器', reverse('asset_list', args=['servers'])),
            ('弱电设备', reverse('asset_list', args=['weakcurrent'])),
            ('任务·异常', reverse('task_list')),
            ('告警·维护', reverse('alert_list')),
            ('网络拓扑', reverse('operations_overview')),
            ('IP 管理', reverse('ip_management')),
        ]
        positions = []
        for label, href in expected:
            marker = f'href="{href}">{label}</a>'
            self.assertIn(marker, nav, f'主导航缺少 {label}')
            positions.append(nav.index(marker))
        self.assertEqual(positions, sorted(positions), '主导航顺序与约定不一致')

    def test_primary_navigation_has_no_dropdowns(self):
        nav = self._nav_html()

        self.assertNotIn('dropdown', nav)
        self.assertNotIn('data-bs-toggle', nav)

    def test_page_headings_match_the_navigation_labels(self):
        """各自主页面的标题和导航名一致。"""
        cases = [
            ('asset_list', ['people'], '人员·部门'),
            ('asset_list', ['computers'], 'PC'),
            ('asset_list', ['networks'], '网络设备'),
            ('asset_list', ['servers'], '服务器'),
            ('asset_list', ['weakcurrent'], '弱电设备'),
            ('task_list', [], '任务·异常'),
            ('alert_list', [], '告警·维护'),
        ]
        for name, args, label in cases:
            with self.subTest(page=label):
                body = self.client.get(reverse(name, args=args)).content.decode()
                self.assertIn(f'<h1 class="page-heading__title">{label}</h1>', body)
