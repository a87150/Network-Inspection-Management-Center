"""告警策略路由：策略里的「模板 × 渠道」配对。

这张表同样要手写 DDL：Django 的 CreateModel 走 data_types 老路径，UUIDField 生成
char(32)；而 net_alertpolicy.id / net_alertchannel.id 在既有库里是 MariaDB 原生
uuid。外键两侧类型或排序规则不一致都会 errno 150，所以按库里实际类型生成、
并且不写死 CHARSET/COLLATE。
"""
import uuid

from django.db import migrations, models
import django.db.models.deletion


def _column_type(schema_editor, table, column):
    """读被引用列的真实类型。"""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() "
            "AND TABLE_NAME = %s AND COLUMN_NAME = %s", [table, column])
        row = cursor.fetchone()
    return row[0] if row else 'char(32)'


def add_delivery_template(apps, schema_editor):
    """把 AlertDelivery.template 加上。上次中断时这一列可能已经在，
    直接 ADD COLUMN 会撞 1060，所以先查再说。"""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() "
            "AND TABLE_NAME = %s AND COLUMN_NAME = %s",
            ["net_alertdelivery", "template_id"])
        if cursor.fetchone()[0]:
            return
    template_type = _column_type(schema_editor, "net_alertnotificationtemplate", "id")
    schema_editor.execute(
        "ALTER TABLE net_alertdelivery "
        f"ADD COLUMN template_id {template_type} NULL, "
        "ADD CONSTRAINT net_alertdelivery_template_fk "
        "FOREIGN KEY (template_id) "
        "REFERENCES net_alertnotificationtemplate (id)"
    )

def drop_delivery_template(apps, schema_editor):
    schema_editor.execute(
        "ALTER TABLE net_alertdelivery DROP FOREIGN KEY net_alertdelivery_template_fk"
    )
    schema_editor.execute("ALTER TABLE net_alertdelivery DROP COLUMN template_id")

def create_route_table(apps, schema_editor):
    policy_type = _column_type(schema_editor, 'net_alertpolicy', 'id')
    channel_type = _column_type(schema_editor, 'net_alertchannel', 'id')
    template_type = _column_type(schema_editor, 'net_alertnotificationtemplate', 'id')
    schema_editor.execute(
        "CREATE TABLE `net_alertpolicyroute` ("
        " `id` char(32) NOT NULL PRIMARY KEY,"
        " `trigger` varchar(16) NOT NULL,"
        " `created_at` datetime(6) NOT NULL,"
        f" `policy_id` {policy_type} NOT NULL,"
        f" `channel_id` {channel_type} NOT NULL,"
        f" `template_id` {template_type} NOT NULL,"
        " UNIQUE KEY `net_alert_policy_route_uniq`"
        "   (`policy_id`, `channel_id`, `trigger`),"
        " CONSTRAINT `net_alertpolicyroute_policy_fk` FOREIGN KEY (`policy_id`)"
        "   REFERENCES `net_alertpolicy` (`id`) ON DELETE CASCADE,"
        " CONSTRAINT `net_alertpolicyroute_channel_fk` FOREIGN KEY (`channel_id`)"
        "   REFERENCES `net_alertchannel` (`id`) ON DELETE CASCADE,"
        " CONSTRAINT `net_alertpolicyroute_template_fk` FOREIGN KEY (`template_id`)"
        "   REFERENCES `net_alertnotificationtemplate` (`id`),"
        " CONSTRAINT `net_alert_policy_route_trigger_ck`"
        "   CHECK (`trigger` in ('summary','device'))"
        ") ENGINE=InnoDB"
    )


def drop_route_table(apps, schema_editor):
    schema_editor.execute('DROP TABLE IF EXISTS `net_alertpolicyroute`')


class Migration(migrations.Migration):

    dependencies = [
        ('net', '0077_alert_channel_template'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name='AlertPolicyRoute',
                    fields=[
                        ('id', models.UUIDField(default=uuid.uuid4, editable=False,
                                                primary_key=True, serialize=False)),
                        ('trigger', models.CharField(
                            choices=[('summary', '任务汇总'), ('device', '单设备告警')],
                            max_length=16)),
                        ('created_at', models.DateTimeField(auto_now_add=True)),
                        ('channel', models.ForeignKey(
                            on_delete=django.db.models.deletion.CASCADE,
                            related_name='routes', to='net.alertchannel')),
                        ('policy', models.ForeignKey(
                            on_delete=django.db.models.deletion.CASCADE,
                            related_name='routes', to='net.alertpolicy')),
                        ('template', models.ForeignKey(
                            on_delete=django.db.models.deletion.PROTECT,
                            related_name='routes', to='net.alertnotificationtemplate')),
                    ],
                    options={
                        'constraints': [
                            models.UniqueConstraint(
                                fields=('policy', 'channel', 'trigger'),
                                name='net_alert_policy_route_uniq'),
                            models.CheckConstraint(
                                condition=models.Q(trigger__in=('summary', 'device')),
                                name='net_alert_policy_route_trigger_ck'),
                        ],
                    },
                ),
            ],
            database_operations=[
                migrations.RunPython(create_route_table, drop_route_table),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name='alertdelivery',
                    name='template',
                    field=models.ForeignKey(blank=True, null=True,
                                            on_delete=django.db.models.deletion.PROTECT,
                                            related_name='deliveries',
                                            to='net.alertnotificationtemplate'),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_delivery_template, drop_delivery_template),
            ],
        ),
        migrations.DeleteModel(name='AlertChannelTemplate'),
    ]
