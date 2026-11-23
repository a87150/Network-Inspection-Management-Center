"""json_script 的共享编码器。

json_script 默认 ensure_ascii=True，中文会写成 \\uXXXX：整页 bootstrap 数据翻倍，
测试里按中文原文断言也读不到。这里只关掉 ASCII 转义，尖括号仍由 json_script 自己处理，
不引入 XSS 面。
"""

from django.core.serializers.json import DjangoJSONEncoder
from django.utils.html import json_script


class LiteralUnicodeJSON(DjangoJSONEncoder):
    def __init__(self, *args, **kwargs):
        kwargs["ensure_ascii"] = False
        super().__init__(*args, **kwargs)


def localized_json_script(payload, element_id):
    """输出中文保持原样的 json_script 片段。"""
    return json_script(payload, element_id, encoder=LiteralUnicodeJSON)
