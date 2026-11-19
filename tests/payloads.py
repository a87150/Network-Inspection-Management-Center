"""Read the JSON a Vue page hydrates its island with."""
import json
import re


def bootstrap(response, script_id):
    match = re.search(
        rf'id="{script_id}"[^>]*>(.*?)</script>', response.content.decode(), re.S,
    )
    return json.loads(match.group(1)) if match else {}


def rows(response, script_id):
    return bootstrap(response, script_id).get("rows") or []


def payload_text(response, script_id):
    """The hydrated JSON as one searchable string, for detail-page assertions."""
    return json.dumps(bootstrap(response, script_id), ensure_ascii=False)

def asset_table(response):
    """资产列表的列定义与首屏行。"""
    return bootstrap(response, "asset-workspace-bootstrap")


def asset_table_text(response):
    """同上，但中日韩字符保持原样，方便直接搜中文与 URL。"""
    return payload_text(response, "asset-workspace-bootstrap")

def workspace_detail(response):
    """工作区首屏预置的那条详情；深链直接落在这里。"""
    return bootstrap(response, "asset-workspace-bootstrap").get("initialDetail") or {}


def workspace_detail_text(response):
    return json.dumps(workspace_detail(response), ensure_ascii=False)


