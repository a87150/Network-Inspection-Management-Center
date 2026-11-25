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
    from .models import AiProvider, AiSetting

    config = dict(settings.AI_CONFIG)
    # 端点/密钥/模型以「当前激活的那组」为准：AiSetting 里同名项可能是切换前
    # 留下的旧值，让它再盖一遍会让「切换提供方」看着成功、实际没换。
    from_provider = set()
    provider = AiProvider.active()
    if provider is not None:
        if provider.base_url:
            config["BASE_URL"] = provider.base_url
            from_provider.add("BASE_URL")
        if provider.chat_model:
            config["CHAT_MODEL"] = provider.chat_model
            from_provider.add("CHAT_MODEL")
        if provider.embed_model:
            config["EMBED_MODEL"] = provider.embed_model
            from_provider.add("EMBED_MODEL")
        if provider.api_key_cipher:
            try:
                config["API_KEY"] = _decrypt(provider.api_key_cipher)
            except Exception:
                config["API_KEY"] = ""
            from_provider.add("API_KEY")
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
        if value and key not in from_provider:
            config[key] = value
    if row.api_key_cipher and "API_KEY" not in from_provider:
        try:
            config["API_KEY"] = _decrypt(row.api_key_cipher)
        except Exception:
            # 密钥轮换后旧密文解不开：当作没配，别让整页崩掉。
            config["API_KEY"] = ""
    if row.retrieval_max_distance is not None:
        config["RETRIEVAL_MAX_DISTANCE"] = row.retrieval_max_distance
    if row.keyword_max_distance is not None:
        config["KEYWORD_MAX_DISTANCE"] = row.keyword_max_distance
    if row.max_history:
        config["MAX_HISTORY"] = row.max_history
    if row.summary_trigger:
        config["SUMMARY_TRIGGER"] = row.summary_trigger
    if row.reasoning_effort:
        config["REASONING_EFFORT"] = row.reasoning_effort
    if row.models_text:
        config["MODELS"] = [
            part.strip()
            for line in row.models_text.splitlines()
            for part in line.replace("，", ",").split(",")
            if part.strip()
        ]
    return config


def save_settings(payload):
    """把页面提交的值落库。空字符串表示清掉覆盖，回落环境变量。"""
    from .models import AiProvider, AiSetting

    # 端点/密钥/模型落到 AiProvider（当前激活那条），其余落 AiSetting。
    provider = AiProvider.active()
    if provider is None:
        provider = AiProvider(name="默认", is_active=True)
    if payload.get("name"):
        provider.name = str(payload["name"]).strip()[:64] or "默认"
    if "base_url" in payload:
        provider.base_url = (payload.get("base_url") or "").strip()
    if "chat_model" in payload:
        provider.chat_model = (payload.get("chat_model") or "").strip()
    if "embed_model" in payload:
        provider.embed_model = (payload.get("embed_model") or "").strip()
    api_key = (payload.get("api_key") or "").strip()
    if payload.get("clear_api_key"):
        provider.api_key_cipher = ""
    elif api_key:
        provider.api_key_cipher = _encrypt(api_key)
    provider.save()

    # 只改 payload 里出现过的键。提交部分字段（比如输入区切模型只发
    # chat_model/reasoning_effort）时，没提交的项必须保持原值，不能被写成空。
    row = AiSetting.load() or AiSetting()
    if "base_url" in payload:
        row.base_url = (payload.get("base_url") or "").strip()
    if "chat_model" in payload:
        row.chat_model = (payload.get("chat_model") or "").strip()
    if "embed_model" in payload:
        row.embed_model = (payload.get("embed_model") or "").strip()
    if "rag_backend" in payload:
        backend = (payload.get("rag_backend") or "").strip()
        row.rag_backend = backend if backend in {"hybrid", "vector", "keyword"} else ""
    api_key = (payload.get("api_key") or "").strip()
    if api_key:
        row.api_key_cipher = _encrypt(api_key)
    elif payload.get("clear_api_key"):
        row.api_key_cipher = ""
    if "retrieval_max_distance" in payload:
        row.retrieval_max_distance = _float_or_none(payload.get("retrieval_max_distance"))
    if "keyword_max_distance" in payload:
        row.keyword_max_distance = _float_or_none(payload.get("keyword_max_distance"))
    if "max_history" in payload:
        row.max_history = _int_or_none(payload.get("max_history"), 2, 50)
    if "summary_trigger" in payload:
        row.summary_trigger = _int_or_none(payload.get("summary_trigger"), 4, 200)
    if "reasoning_effort" in payload:
        effort = (payload.get("reasoning_effort") or "").strip()
        row.reasoning_effort = effort if effort in {"low", "medium", "high"} else ""
    if "models_text" in payload:
        row.models_text = "\n".join(
            line.strip() for line in str(payload.get("models_text") or "").splitlines() if line.strip()
        )
    row.save()
    return row


def sync_setting_from_provider():
    """把当前生效那组的端点/密钥/模型镜像到 AiSetting。

    AiSetting 同时是设置页的显示来源。切换或删除提供方后不镜像，页面上会显示
    上一组的地址、实际请求用的却是新的；删光所有组时也就清不掉旧值。
    """
    from .models import AiProvider, AiSetting

    row = AiSetting.load()
    if row is None:
        return
    provider = AiProvider.active()
    row.base_url = provider.base_url if provider else ""
    row.chat_model = provider.chat_model if provider else ""
    row.embed_model = provider.embed_model if provider else ""
    row.api_key_cipher = provider.api_key_cipher if provider else ""
    row.save(update_fields=[
        "base_url", "chat_model", "embed_model", "api_key_cipher", "updated_at",
    ])


def _int_or_none(value, low, high):
    """界面上是数字输入框，留空或越界都当没填，回落环境变量。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


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
        "max_history": config["MAX_HISTORY"],
        "summary_trigger": config["SUMMARY_TRIGGER"],
        "reasoning_effort": config.get("REASONING_EFFORT", ""),
        "models": list(config.get("MODELS") or [config["CHAT_MODEL"]]),
        "models_text": "\n".join(config.get("MODELS") or []),
        "has_api_key": bool(config["API_KEY"]),
        "configured": bool(config["BASE_URL"] and config["API_KEY"]),
    }
