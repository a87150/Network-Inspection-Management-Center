"""告警投递：限流识别与单行失败隔离。

对应 docs/functional-review-2.32.md 补记的两条（钉钉限流、毒株阻塞）。
"""

from django.test import TestCase

from net.alerts.base import AlertMessage, looks_rate_limited
from net.alerts.dingtalk import send_dingtalk
from net.alerts.feishu import send_feishu


class RateLimitHintTests(TestCase):
    def test_limiting_wording_is_recognised(self):
        for payload in (
            {'errcode': 130101, 'errmsg': 'send too fast, exceed 20 times per minute'},
            {'code': 9499, 'msg': 'too many request'},
            {'errcode': 1, 'errmsg': '请求过于频繁，请稍后再试'},
        ):
            with self.subTest(payload=payload):
                self.assertTrue(looks_rate_limited(payload))

    def test_ordinary_failure_is_not_treated_as_limiting(self):
        for payload in ({'errcode': 400, 'errmsg': 'invalid token'}, {}, None, 'text'):
            with self.subTest(payload=payload):
                self.assertFalse(looks_rate_limited(payload))


def _message():
    return AlertMessage(title='巡检完成', text='正文', facts={}, detail_url='')


class _Response:
    def __init__(self, payload, status_code=200):
        self.status_code = status_code
        self.text = ''
        self._payload = payload

    def json(self):
        return self._payload


class _Channel:
    is_enabled = True

    def __init__(self, **settings):
        self.settings = settings


class AdapterRetryTests(TestCase):
    def test_dingtalk_200_with_limiting_body_is_retryable(self):
        payload = {'errcode': 130101, 'errmsg': 'send too fast, exceed 20 times per minute'}
        result = send_dingtalk(
            _Channel(webhook_url='https://oapi.dingtalk.com/robot/send?access_token=x'),
            _message(), http_post=lambda *a, **k: _Response(payload),
        )
        self.assertFalse(result.success)
        self.assertTrue(result.retryable, '限流被当成永久失败会让告警在一次都不重试的情况下丢掉')

    def test_dingtalk_200_with_a_real_error_stays_permanent(self):
        payload = {'errcode': 300001, 'errmsg': 'invalid token'}
        result = send_dingtalk(
            _Channel(webhook_url='https://oapi.dingtalk.com/robot/send?access_token=x'),
            _message(), http_post=lambda *a, **k: _Response(payload),
        )
        self.assertFalse(result.success)
        self.assertFalse(result.retryable)

    def test_feishu_200_with_limiting_body_is_retryable(self):
        payload = {'code': 9499, 'msg': 'too many request'}
        result = send_feishu(
            _Channel(webhook_url='https://open.feishu.cn/open-apis/bot/v2/hook/x'),
            _message(), http_post=lambda *a, **k: _Response(payload),
        )
        self.assertFalse(result.success)
        self.assertTrue(result.retryable)
