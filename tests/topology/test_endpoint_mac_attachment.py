from datetime import UTC, datetime, timedelta

from django.test import SimpleTestCase

from topology.presentation import _mac_parent, _mac_set


class MacSetTests(SimpleTestCase):
    """终端 MAC 字段是自由文本，拆分与归一化必须和 observations 同一套。"""

    def test_space_separated_macs_are_split(self):
        # 原来正则写成 r'[,s;]+'，s 是普通字符而不是 \s，
        # 空格分隔的多 MAC 会整串粘成一个，这个终端永远命中不了 MAC 表。
        self.assertEqual(
            _mac_set('aa:bb:cc:dd:ee:01 aa:bb:cc:dd:ee:02'),
            {'aabbccddee01', 'aabbccddee02'},
        )

    def test_mixed_separators_and_case(self):
        self.assertEqual(
            _mac_set('AA-BB-CC-DD-EE-01, aa:bb:cc:dd:ee:02; aabbccddee03'),
            {'aabbccddee01', 'aabbccddee02', 'aabbccddee03'},
        )

    def test_empty_and_blank_fields(self):
        self.assertEqual(_mac_set(''), set())
        self.assertEqual(_mac_set(None), set())
        self.assertEqual(_mac_set(' , ; '), set())


class MacParentTests(SimpleTestCase):
    """同一个 MAC 会被级联的上游设备一起学到，要选最可能是直连的那台。"""

    def setUp(self):
        self.now = datetime(2026, 11, 28, 12, 0, tzinfo=UTC)

    def _node(self, node_id, site):
        return {'id': node_id, 'site': site, 'tier': 3}

    def test_prefers_same_site(self):
        backbone = {
            'networks:near': self._node('networks:near', '总部'),
            'networks:far': self._node('networks:far', '分部'),
        }
        endpoint = {'site': '总部', '_macs': {'aabbccddee01'}}
        mac_locations = {
            'aabbccddee01': ('far', 'GE0/0/1', self.now),
            'aabbccddee02': ('near', 'GE0/0/2', self.now - timedelta(hours=1)),
        }
        endpoint['_macs'] = {'aabbccddee01', 'aabbccddee02'}
        self.assertEqual(_mac_parent(endpoint, backbone, mac_locations)['id'], 'networks:near')

    def test_prefers_latest_learning_when_site_matches(self):
        backbone = {
            'networks:old': self._node('networks:old', '总部'),
            'networks:new': self._node('networks:new', '总部'),
        }
        endpoint = {'site': '总部', '_macs': {'aabbccddee01'}}
        mac_locations = {
            'aabbccddee01': ('old', 'GE0/0/1', self.now - timedelta(hours=5)),
            'aabbccddee02': ('new', 'GE0/0/2', self.now),
        }
        endpoint['_macs'] = {'aabbccddee01', 'aabbccddee02'}
        self.assertEqual(_mac_parent(endpoint, backbone, mac_locations)['id'], 'networks:new')

    def test_no_hit_returns_none(self):
        backbone = {'networks:a': self._node('networks:a', '总部')}
        endpoint = {'site': '总部', '_macs': {'ffffffffffff'}}
        self.assertIsNone(_mac_parent(endpoint, backbone, {'aabbccddee01': ('a', 'GE0/0/1', self.now)}))

    def test_missing_timestamp_still_matches(self):
        # mac_locations 老返回值是二元组，升级期间两种形状都要能读。
        backbone = {'networks:a': self._node('networks:a', '总部')}
        endpoint = {'site': '总部', '_macs': {'aabbccddee01'}}
        self.assertEqual(
            _mac_parent(endpoint, backbone, {'aabbccddee01': ('a', 'GE0/0/1')})['id'],
            'networks:a',
        )
