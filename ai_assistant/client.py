"""OpenAI 兼容的最小客户端。

只用两个端点：/embeddings 和 /chat/completions。
用 urllib 不引 openai 包：一个 POST 封装够了，多一个依赖换一行代码不值得。
"""
import json
import urllib.error
import urllib.request

from .config import ai_config


class AiNotConfigured(RuntimeError):
    """AI_BASE_URL 或 AI_API_KEY 没填。调用方据此返回友好提示，不 500。"""


class AiUpstreamError(RuntimeError):
    """上游返回了非 2xx，或响应体不合预期。"""


def _post(path, payload):
    cfg = ai_config()
    if not cfg["BASE_URL"] or not cfg["API_KEY"]:
        raise AiNotConfigured("AI 服务未配置")
    request = urllib.request.Request(
        cfg["BASE_URL"].rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg["API_KEY"],
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=cfg["TIMEOUT"]) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        raise AiUpstreamError("上游返回 %s：%s" % (error.code, detail)) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise AiUpstreamError("连不上 AI 服务：%s" % error) from error
    try:
        return json.loads(body)
    except ValueError as error:
        raise AiUpstreamError("上游返回的不是 JSON") from error


def embed(texts):
    """把一段或多段文本转成向量，返回 [[float, ...], ...]。"""
    if not texts:
        return []
    data = _post("/embeddings", {
        "model": ai_config()["EMBED_MODEL"],
        "input": list(texts),
    })
    try:
        # 按 index 排序，上游不保证顺序。
        items = sorted(data["data"], key=lambda item: item.get("index", 0))
        return [item["embedding"] for item in items]
    except (KeyError, TypeError) as error:
        raise AiUpstreamError("embedding 响应结构不认识") from error


def chat(messages):
    """发一组消息，返回回答文本。"""
    data = _post("/chat/completions", {
        "model": ai_config()["CHAT_MODEL"],
        "messages": messages,
        "temperature": 0.2,
    })
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as error:
        raise AiUpstreamError("chat 响应结构不认识") from error
