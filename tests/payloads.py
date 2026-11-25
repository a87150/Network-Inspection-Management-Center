"""Read the JSON a Vue page hydrates its island with."""
import json
import re


def bootstrap(response, script_id):
    match = re.search(
        rf'id="{script_id}"[^>]*>(.*?)</script>', response.content.decode(), re.S,
    )
    return json.loads(match.group(1)) if match else {}


def unhashed(html):
    """去掉 ManifestStaticFilesStorage 加的指纹，只留文件名。

    style.4f2a1b3c9d8e.css -> style.css
    断言关心加载了哪个文件，不是指纹本身。
    """
    return re.sub(r"\.[0-9a-f]{12}(\.[a-z0-9]+)", r"\1", html)


def rows(response, script_id):
    return bootstrap(response, script_id).get("rows") or []


def payload_text(response, script_id):
    """The hydrated JSON as one searchable string, for detail-page assertions."""
    return json.dumps(bootstrap(response, script_id), ensure_ascii=False)

# 列表页逐个迁到「一份 bootstrap JSON」后，挂载点的 id 跟着页面走；
# 详情深链仍是旧页面，所以 asset- 排在最前面。
WORKSPACE_IDS = (
    "asset-workspace-bootstrap",
    "pc-workspace-bootstrap",
    "network-workspace-bootstrap",
    "server-workspace-bootstrap",
    "weakcurrent-workspace-bootstrap",
    "people-workspace-bootstrap",
)


def workspace_payload(response):
    """页面上那份工作区 JSON，不管它现在挂在哪个 id 上。"""
    for script_id in WORKSPACE_IDS:
        payload = bootstrap(response, script_id)
        if payload:
            return payload
    return {}


def workspace_text(response):
    """整份工作区 JSON 的可搜索文本，不管挂在哪个 id 上。"""
    return json.dumps(workspace_payload(response), ensure_ascii=False)


def asset_table(response):
    """资产列表的列定义与首屏行。

    旧页面把 columns/rows 放在顶层，新页面收进 table 块；两种形状都认。
    """
    payload = workspace_payload(response)
    return payload.get("table") or payload


def asset_table_text(response):
    """同上，但中日韩字符保持原样，方便直接搜中文与 URL。"""
    return json.dumps(asset_table(response), ensure_ascii=False)

def workspace_detail(response):
    """工作区首屏预置的那条详情；深链直接落在这里。"""
    return workspace_payload(response).get("initialDetail") or {}


def workspace_detail_text(response):
    return json.dumps(workspace_detail(response), ensure_ascii=False)


def vue_component(relative):
    """页面改成 Vue 渲染后，结构与 class 断言只能落在组件源码上。"""
    from pathlib import Path

    from django.conf import settings

    return (Path(settings.BASE_DIR) / 'static/app/vue' / relative).read_text(encoding='utf-8')


