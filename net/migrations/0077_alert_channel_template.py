"""渠道与模板的绑定表。

这张表必须手写 DDL：Django 的 CreateModel 走 data_types 老路径，UUIDField 会生成
char(32)；而 net_alertchannel.id 在既有库里是 MariaDB 原生 uuid，全新库才是
char(32)。写死任一种都会在其中一边报 errno 150，所以这里按库里实际的列类型生成。

表选项也不写死 CHARSET/COLLATE：MariaDB 12 的库默认是 utf8mb4_uca1400_ai_ci，
写死 utf8mb4_bin 会让外键两侧排序规则不一致，同样是 errno 150。
"""
import uuid

from django.db import migrations, models
import django.db.models.deletion


def _column_type(schema_editor, table, column):
    """读被引用列的真实类型：老库 uuid，全新库 char(32)。"""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() "
            "AND TABLE_NAME = %s AND COLUMN_NAME = %s", [table, column])
        row = cursor.fetchone()
    return row[0] if row else 'char(32)'


def create_binding_table(apps, schema_editor):
    channel_type = _column_type(schema_editor, 'net_alertchannel', 'id')
    template_type = _column_type(schema_editor, 'net_alertnotificationtemplate', 'id')
    schema_editor.execute(
        "CREATE TABLE `net_alertchanneltemplate` ("
        " `id` char(32) NOT NULL PRIMARY KEY,"
        " `trigger` varchar(16) NOT NULL,"
        " `created_at` datetime(6) NOT NULL,"
        f" `channel_id` {channel_type} NOT NULL,"
        f" `template_id` {template_type} NOT NULL,"
        " UNIQUE KEY `net_alert_channel_template_uniq` (`channel_id`, `trigger`),"
        " CONSTRAINT `net_alertchanneltemplate_channel_fk` FOREIGN KEY (`channel_id`)"
        "   REFERENCES `net_alertchannel` (`id`) ON DELETE CASCADE,"
        " CONSTRAINT `net_alertchanneltemplate_template_fk` FOREIGN KEY (`template_id`)"
        "   REFERENCES `net_alertnotificationtemplate` (`id`),"
        " CONSTRAINT `net_alert_channel_template_trigger_ck`"
        "   CHECK (`trigger` in ('summary','device'))"
        ") ENGINE=InnoDB"
    )


def drop_binding_table(apps, schema_editor):
    schema_editor.execute('DROP TABLE IF EXISTS `net_alertchanneltemplate`')


class Migration(migrations.Migration):

    dependencies = [
        ('net', '0076_alert_notification_templates'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name='AlertChannelTemplate',
                    fields=[
                        ('id', models.UUIDField(default=uuid.uuid4, editable=False,
                                                primary_key=True, serialize=False)),
                        ('trigger', models.CharField(
                            choices=[('summary', '任务汇总'), ('device', '单设备告警')],
                            max_length=16)),
                        ('created_at', models.DateTimeField(auto_now_add=True)),
                        ('channel', models.ForeignKey(
                            on_delete=django.db.models.deletion.CASCADE,
                            related_name='template_bindings', to='net.alertchannel')),
                        ('template', models.ForeignKey(
                            on_delete=django.db.models.deletion.PROTECT,
                            related_name='channel_bindings', to='net.alertnotificationtemplate')),
                    ],
                    options={
                        'constraints': [
                            models.UniqueConstraint(fields=('channel', 'trigger'),
                                                    name='net_alert_channel_template_uniq'),
                            models.CheckConstraint(
                                condition=models.Q(trigger__in=('summary', 'device')),
                                name='net_alert_channel_template_trigger_ck'),
                        ],
                    },
                ),
            ],
            database_operations=[
                migrations.RunPython(create_binding_table, drop_binding_table),
            ],
        ),
    ]
