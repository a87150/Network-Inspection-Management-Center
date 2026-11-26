"""把单例的任务汇总模板拆成可多条的通知模板，并加渠道绑定层。


原来是「全库只能有一行模板」（key 是主键且被 CheckConstraint 锁死等于
'task_summary'），渠道和模板之间没有任何关联。现在：
  - 模板可以有多条，按 trigger 区分「任务汇总」和「单设备告警」；
  - 新增 AlertChannelTemplate 绑定表，一个渠道可以绑多套模板，
    (channel, trigger) 唯一，所以每种 trigger 在一条渠道上只有一种发法。

旧的那一行转成「默认任务汇总」并设为 summary 的默认模板，数据不丢。
"""
import uuid

from django.db import migrations, models


def retire_backlog_device_deliveries(apps, schema_editor):
    Delivery = apps.get_model('net', 'AlertDelivery')
    Delivery.objects.filter(
        event__event_type__in=('abnormal', 'recovery'),
        status__in=('pending', 'retry', 'sending'),
    ).update(status='skipped')


def forwards(apps, schema_editor):
    Old = apps.get_model('net', 'OldAlertNotificationTemplate')
    Template = apps.get_model('net', 'AlertNotificationTemplate')
    legacy = Old.objects.filter(key='task_summary').first()
    if legacy is None:
        Template.objects.create(
            name='默认任务汇总', trigger='summary', mode='compact',
            is_default=True, default_slot='summary',
        )
        return
    Template.objects.create(
        id=uuid.uuid4(),
        name='默认任务汇总',
        trigger='summary',
        mode=legacy.mode if legacy.mode in {'compact', 'detailed'} else 'compact',
        title_template=legacy.title_template or '',
        body_template=legacy.body_template or '',
        is_default=True,
        default_slot='summary',
    )


def backwards(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('net', '0075_access_report_config'),
    ]

    operations = [
        migrations.RenameModel(
            old_name='AlertNotificationTemplate',
            new_name='OldAlertNotificationTemplate',
        ),
        migrations.CreateModel(
            name='AlertNotificationTemplate',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=64, unique=True)),
                ('trigger', models.CharField(
                    choices=[('summary', '任务汇总'), ('device', '单设备告警')],
                    default='summary', max_length=16)),
                ('mode', models.CharField(
                    choices=[('compact', '简洁'), ('detailed', '详细')],
                    default='compact', max_length=16)),
                ('title_template', models.CharField(blank=True, max_length=255)),
                ('body_template', models.TextField(blank=True)),
                ('is_default', models.BooleanField(default=False)),
                ('default_slot', models.CharField(
                    blank=True, editable=False, max_length=16, null=True, unique=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'constraints': [
                    models.CheckConstraint(
                        condition=models.Q(('trigger__in', ('summary', 'device'))),
                        name='net_alert_template_trigger_ck'),
                    models.CheckConstraint(
                        condition=models.Q(('mode__in', ('compact', 'detailed'))),
                        name='net_alert_template_mode_ck'),
                ],
            },
        ),
        migrations.RunPython(forwards, backwards),
        migrations.DeleteModel(name='OldAlertNotificationTemplate'),
        # 单设备告警（abnormal / recovery）在这次之前从不投递，历史事件的投递行
        # 是残留。放开领取条件后它们会被一次性全部发出去，所以先把存量停掉；
        # 只有升级之后新产生的行才会真正发送。
        migrations.RunPython(retire_backlog_device_deliveries, migrations.RunPython.noop),
    ]

