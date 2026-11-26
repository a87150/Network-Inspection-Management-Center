"""Transport adapters and normalized messages for alert delivery."""

from .base import AlertMessage, DeliveryResult, redact_secret
from .dingtalk import send_dingtalk
from .email import send_email
from .feishu import send_feishu
from .messages import build_alert_message


def send_alert(channel, message, *, http_post=None, smtp_factory=None, now=None):
    """Send one normalized alert through one saved channel.

    Callers may inject the HTTP or SMTP boundary.  Production dispatch and
    persistence are deliberately owned by the later delivery service.
    """
    if not getattr(channel, 'is_enabled', False):
        # 停用是人工决定，重试没有意义；但要和「发送失败」分开说，
        # 否则界面上看起来像渠道坏了。
        return DeliveryResult(False, '渠道已停用，未发送。', False)

    channel_type = getattr(channel, 'channel_type', '')
    if channel_type == 'feishu':
        return send_feishu(channel, message, http_post=http_post, now=now)
    if channel_type == 'dingtalk':
        return send_dingtalk(channel, message, http_post=http_post, now=now)
    if channel_type == 'email':
        return send_email(channel, message, smtp_factory=smtp_factory)
    return DeliveryResult(False, 'Unsupported alert channel.', False)


__all__ = [
    'AlertMessage',
    'DeliveryResult',
    'build_alert_message',
    'redact_secret',
    'send_alert',
    'send_dingtalk',
    'send_email',
    'send_feishu',
]
