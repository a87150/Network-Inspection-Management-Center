"""工作区页面的公共装配。

五个工作区页面（PC / 网络设备 / 服务器 / 弱电设备 / 人员部门）共用同一种
bootstrap JSON 形状，前端才能用同一套组件渲染。这里只做拼接，不算业务：
列定义、行序列化、统计口径全部来自 table_payload / table_registry / 各页自己的 payload 函数。
"""
from django.urls import reverse
from django.utils import timezone

DATE_FORMAT = '%Y-%m-%d %H:%M:%S'


def stamp(value):
    if not value:
        return ''
    if timezone.is_aware(value):
        value = timezone.localtime(value)
    return value.strftime(DATE_FORMAT)


def bootstrap(*, page, blocks, table, urls, csrf='', **extra):
    """页面首屏数据。字段缺就传空，不要各页各长一样。"""
    payload = {
        'page': page,
        'blocks': blocks,
        'table': table,
        'urls': urls,
        'csrf': csrf,
    }
    payload.update(extra)
    return payload


def block(*, key, title, metric=0, unit='', lines=(), entry='查看', latest='',
          latest_label='最新', badge=''):
    """顶部方块。lines 里每一项是 [{'text': ..., 'tone': 'success'}, ...]。"""
    return {
        'key': key,
        'title': title,
        'badge': badge,
        'metric': metric,
        'unit': unit,
        'lines': [{'parts': list(line)} for line in lines],
        'entry': entry,
        'latest': stamp(latest) if latest else '',
        'latest_label': latest_label,
    }


def task_rows(page_obj):
    """巡检任务栏的行。summarize_task() 的输出里带着 TaskRun 实例，这里摊平成纯 dict。"""
    rows = []
    for summary in page_obj.object_list:
        task = summary['task']
        rows.append({
            'id': str(task.pk),
            'type_label': summary['type_label'],
            'profile_label': summary['profile_label'],
            'source_label': summary['source_label'],
            'status': task.status,
            'status_label': summary['status_label'],
            'created_at': stamp(task.created_at),
            'finished_at': stamp(task.finished_at),
            'total': summary['total'],
            'normal': summary['normal'],
            'abnormal': summary['abnormal'],
            'pending': summary['pending'],
            'cancelled': summary['cancelled'],
            'fetch_success': summary['fetch_success'],
            'integrity_warning': summary['integrity_warning'],
            'detail_url': reverse('task_detail', args=[task.pk]),
        })
    return rows


def task_block(page_obj, *, section_title, empty_title):
    return {
        'rows': task_rows(page_obj),
        'count': page_obj.paginator.count,
        'page': page_obj.number,
        'pages': page_obj.paginator.num_pages,
        'section_title': section_title,
        'empty_title': empty_title,
    }
