"""把每行结果的三态判定固化成生成列，并加索引。

列只由数据库维护，Django 侧不声明该字段：生成列不接受 INSERT，
声明成普通字段会让写入报 1906。查询用 RawSQL 直接引用列名。

页面上的 normal/abnormal 计数原来在 SQL 里对 result_snapshot 逐行做 JSON 解引用，
356 行就要扫 200ms，任务越多越慢。这里交给数据库一次算好、存下来、建索引，
查询直接走列。
"""
from django.db import migrations


def _ddl_state():
    """和 _outcome_expression 保持同一套优先级。"""
    return """
        CASE
            WHEN JSON_UNQUOTE(JSON_EXTRACT(result_snapshot, '$.ignored')) IN ('true', '1') THEN 'ignored'
            WHEN status IN ('queued', 'running') THEN 'pending'
            WHEN status = 'cancelled' THEN 'cancelled'
            WHEN status IN ('failed', 'partial') THEN 'abnormal'
            WHEN status = 'success' THEN CASE
                WHEN JSON_UNQUOTE(JSON_EXTRACT(result_snapshot, '$.health_status')) = 'normal' THEN 'normal'
                WHEN JSON_UNQUOTE(JSON_EXTRACT(result_snapshot, '$.health_status')) = 'abnormal' THEN 'abnormal'
                WHEN JSON_UNQUOTE(JSON_EXTRACT(result_snapshot, '$.status')) = 'success' THEN 'normal'
                ELSE 'abnormal'
            END
            ELSE 'pending'
        END
    """


class Migration(migrations.Migration):

    dependencies = [
        ('net', '0072_ssh_host_keys'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql='ALTER TABLE net_tasktargetrun ADD COLUMN outcome_key VARCHAR(16) '
                        f'AS ({_ddl_state()}) STORED',
                    reverse_sql='ALTER TABLE net_tasktargetrun DROP COLUMN outcome_key',
                ),
                migrations.RunSQL(
                    sql='CREATE INDEX net_tasktargetrun_outcome_key_idx '
                        'ON net_tasktargetrun (outcome_key)',
                    reverse_sql='DROP INDEX net_tasktargetrun_outcome_key_idx ON net_tasktargetrun',
                ),
            ],
        ),
    ]
