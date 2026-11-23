import csv
import json
from collections.abc import Mapping
from datetime import date, datetime
from urllib.parse import quote

from django.http import StreamingHttpResponse
from django.utils import timezone


FORMULA_PREFIXES = ('=', '+', '-', '@', '\t', '\r', '\n')


def _raw_value(record, source):
    if isinstance(record, Mapping):
        return record.get(source)
    value = record
    for part in source.split('__'):
        value = value.get(part) if isinstance(value, Mapping) else getattr(value, part, None)
        if value is None:
            break
    return value


def _display_value(record, field):
    value = _raw_value(record, field.export_source or field.source)
    if value is None:
        return ''
    if field.kind == 'boolean':
        return '是' if value else '否'
    if field.kind == 'choice':
        if field.comparison == 'boolean':
            value = 'normal' if value else 'abnormal'
        labels = {str(key): label for key, label in field.choices}
        return labels.get(str(value), value)
    if isinstance(value, datetime):
        if timezone.is_aware(value):
            value = timezone.localtime(value)
        return value.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(value, date):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return value


def _spreadsheet_safe(value):
    if not isinstance(value, str) or not value:
        return value
    candidate = value.lstrip()
    if value.startswith(FORMULA_PREFIXES) or candidate.startswith(FORMULA_PREFIXES):
        return f"'{value}"
    return value


class _CsvBuffer:
    def write(self, value):
        return value


def export_filtered_csv(request, definition, queryset, filename):
    from index.common.table_query import apply_table_filters

    records, _state = apply_table_filters(
        request, queryset, definition, include_legacy_status=False,
    )

    # 导出的列跟着页面勾选的「显示列」走；一列都没勾就退回全部列，
    # 导出按钮上会写明这是全量导出。
    requested = [key for key in request.GET.get('columns', '').split(',') if key]
    if requested:
        known = {field.key: field for field in definition.fields}
        fields = [known[key] for key in requested if key in known] or list(definition.fields)
    else:
        fields = list(definition.fields)

    def rows():
        yield '﻿'
        writer = csv.writer(_CsvBuffer(), lineterminator='\r\n')
        yield writer.writerow([field.label for field in fields])
        iterator = records.iterator(chunk_size=1000) if hasattr(records, 'iterator') else iter(records)
        for record in iterator:
            yield writer.writerow([
                _spreadsheet_safe(_display_value(record, field))
                for field in fields
            ])

    response = StreamingHttpResponse(rows(), content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(filename)}"
    return response
