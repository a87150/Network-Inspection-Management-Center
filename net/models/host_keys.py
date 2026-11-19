"""SSH 主机密钥指纹：记录谁在什么时候信任了哪台设备。"""
from django.db import models


class SSHHostKey(models.Model):
    """一台设备一条。指纹变了就是变了，不覆盖，靠人工确认后重录。

    之前存在 runtime/host_keys.json 里，升级成表是为了能查"谁什么时候信任的"，
    以及和别的设备记录一起备份。
    """

    class Source(models.TextChoices):
        TOFU = 'tofu', '首次连接自动记录'
        MANUAL = 'manual', '人工录入'

    host = models.CharField('主机', max_length=255)
    port = models.PositiveIntegerField('端口', default=22)
    key_type = models.CharField('密钥类型', max_length=64, blank=True, default='')
    fingerprint = models.CharField('指纹', max_length=128)
    source = models.CharField(
        '来源', max_length=16, choices=Source.choices, default=Source.TOFU,
    )
    trusted_by = models.ForeignKey(
        'auth.User', verbose_name='信任人', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+',
    )
    first_seen_at = models.DateTimeField('首次记录', auto_now_add=True)
    verified_at = models.DateTimeField('最近校验', null=True, blank=True)

    class Meta:
        verbose_name = 'SSH 主机密钥'
        verbose_name_plural = 'SSH 主机密钥'
        constraints = [
            models.UniqueConstraint(fields=('host', 'port'), name='unique_ssh_host_key'),
        ]
        ordering = ('host', 'port')

    def __str__(self):
        return f'{self.host}:{self.port} {self.fingerprint}'
