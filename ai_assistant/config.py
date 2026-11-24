"""AI 配置：settings 打底，页面保存的值覆盖。

页面上「配置 API」写进 AiSetting，没写的项回落到 settings.AI_CONFIG
（也就是环境变量）。api_key 出入库都经 Fernet，库里不放明文。
"""
from django.conf import settings

from net.infrastructure.credentials import _fernet


def _encrypt(value):
    if not value:
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt(value):
    if not value:
        return ""
    return _fernet().decrypt(value.encode("ascii")).decode("utf-8")


def ai_config():
    """合并后的配置。每次读库，配置改完立刻生效，不用重启。"""
    from .models import AiSetting

    config = dict(settings.AI_CONFIG)
    row = AiSetting.load()
    if row is None:
        return config
    overrides = {
        "BASE_URL": row.base_url,
        "CHAT_MODEL": row.chat_model,
        "EMBED_MODEL": row.embed_model,
        "RAG_BACKEND": row.rag_backend,
    }
    for key, value in overrides.items():
        if value:
            config[key] = value
    if row.api_key_cipher:
        try:
            config["API_KEY"] = _decrypt(row.api_key_cipher)
        except Exception:
            # 密钥轮换后旧密文解不开：当作没配，别让整页崩掉。
            config["API_KEY"] = ""
    if row.retrieval_max_distance is not None:
        config["RETRIEVAL_MAX_DISTANCE"] = row.retrieval_max_distance
    if row.keyword_max_distance is not None:
        config["KEYWORD_MAX_DISTANCE"] = row.keyword_max_distance
    return config


def save_settings(payload):
    """把页面提交的值落库。空字符串表示清掉覆盖，回落环境变量。"""
    from .models import AiSetting

    row = AiSetting.load() or AiSetting()
    row.base_url = (payload.get("base_url") or "").strip()
    row.chat_model = (payload.get("chat_model") or "").strip()
    row.embed_model = (payload.get("embed_model") or "").strip()
    backend = (payload.get("rag_backend") or "").strip()
    row.rag_backend = backend if backend in {"hybrid", "vector", "keyword"} else ""
    api_key = (payload.get("api_key") or "").strip()
    if api_key:
        row.api_key_cipher = _encrypt(api_key)
    elif payload.get("clear_api_key"):
        row.api_key_cipher = ""
    row.retrieval_max_distance = _float_or_none(payload.get("retrieval_max_distance"))
    row.keyword_max_distance = _float_or_none(payload.get("keyword_max_distance"))
    row.save()
    return row


def _float_or_none(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def masked_summary():
    """给前端看的配置摘要，api_key 只回「有没有」，不回明文。"""
    config = ai_config()
    return {
        "base_url": config["BASE_URL"],
        "chat_model": config["CHAT_MODEL"],
        "embed_model": config["EMBED_MODEL"],
        "rag_backend": config.get("RAG_BACKEND", "hybrid"),
        "retrieval_max_distance": config["RETRIEVAL_MAX_DISTANCE"],
        "keyword_max_distance": config.get("KEYWORD_MAX_DISTANCE", 0.75),
        "has_api_key": bool(config["API_KEY"]),
        "configured": bool(config["BASE_URL"] and config["API_KEY"]),
    }
