"""详情弹窗内部的交互契约：不跳页、不改地址栏、不叠第二层弹窗。"""
from pathlib import Path
from types import SimpleNamespace

from django.contrib.staticfiles import finders
from django.test import SimpleTestCase
from django.urls import reverse
from django.utils import timezone

from inspections.detail_payload import (
    analysis_detail_payload, inspection_record_detail_payload,
)


def _source(relative_path):
    return Path(finders.find(relative_path)).read_text(encoding='utf-8')


class DetailActionKindTests(SimpleTestCase):
    """payload 里的动作要能区分"站内详情"和"关掉弹窗回列表"。"""

    def test_inspection_record_returns_to_the_list_by_closing_the_modal(self):
        payload = inspection_record_detail_payload(
            inspection=SimpleNamespace(
                created_at=timezone.now(), details={}, is_reachable=True,
                status='success', duration_ms=12, summary='',
            ),
            record_kind='networks',
            item_name='交换机',
            asset_name='SW-1',
            detail_fields=[],
            inspection_errors=[],
            back_url='/inspections/',
        )

        self.assertEqual(payload['actions'], [
            {'kind': 'close', 'label': '返回巡检记录', 'url': '/inspections/', 'variant': ''},
        ])

    def test_analysis_detail_opens_the_log_in_the_same_modal(self):
        log_file_id = 42
        payload = analysis_detail_payload(
            analysis=SimpleNamespace(
                computer=SimpleNamespace(computer_name='PC-1', user_name='tester'),
                details={}, analysis_items=[], log_file_id=log_file_id,
                graded_findings=[], summary='', created_at=timezone.now(),
                source_collected_at=None, get_status_display=lambda: '成功',
            ),
            detail_fields=[],
            back_url='/inspections/analyses/',
        )

        self.assertEqual(payload['actions'], [
            {
                'kind': 'detail',
                'label': '查看日志详情',
                'url': reverse('computer_log_detail', args=[log_file_id]),
                'variant': 'primary',
            },
            {
                'kind': 'close',
                'label': '返回日志分析记录',
                'url': '/inspections/analyses/',
                'variant': '',
            },
        ])

    def test_actions_survive_the_shared_payload_filter(self):
        # detail_payload() 会丢掉 kind == 'link' 的跳转动作，kind 必须显式区分。
        payload = inspection_record_detail_payload(
            inspection=SimpleNamespace(
                created_at=timezone.now(), details={}, is_reachable=False,
                status='failed', duration_ms=0, summary='连接超时',
            ),
            record_kind='servers', item_name='服务器', asset_name='SRV-1',
            detail_fields=[], inspection_errors=[], back_url='/inspections/',
        )
        self.assertTrue(payload['actions'])
        self.assertNotIn('link', [action['kind'] for action in payload['actions']])


class DetailModalSourceContractTests(SimpleTestCase):
    def test_detail_page_never_writes_the_address_bar(self):
        source = _source('app/vue/pages/resource_detail.mjs')

        self.assertNotIn('window.location.hash', source)
        self.assertNotIn('#detail=', source)
        # page_url 只当接口锚点用。
        self.assertIn('pagination.page_url', source)
        self.assertIn('data-detail-url', source)

    def test_detail_page_actions_use_the_modal_channels(self):
        source = _source('app/vue/pages/resource_detail.mjs')

        self.assertIn("action.kind === 'detail'", source)
        self.assertIn('data-detail-modal', source)
        self.assertIn("action.kind === 'close'", source)
        self.assertIn('data-detail-close', source)
        self.assertIn('closeAction', source)

    def test_detail_modal_resolves_vue_boot_from_its_own_url(self):
        source = _source('app/js/common/detail_modal.js')

        # 写死 /static 的绝对路径在子路径部署下 404。
        self.assertNotIn("import('/static/app/vue/boot.mjs')", source)
        self.assertIn("new URL('../../vue/boot.mjs', script.src)", source)
        self.assertIn('document.currentScript', source)

    def test_detail_modal_marks_its_loaded_url_and_skips_close_links(self):
        source = _source('app/js/common/detail_modal.js')

        self.assertIn('box.dataset.detailUrl = path', source)
        self.assertIn("link.hasAttribute('data-detail-close')", source)
        # 没有详情弹窗容器（独立详情页）时不拦截 data-detail-modal 链接。
        self.assertIn("!document.getElementById(MODAL_ID)) return", source)
