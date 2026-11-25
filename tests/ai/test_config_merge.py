"""AI 配置合并与摘要生成的回归测试。

这三条都对应 docs/functional-review-2.32.md 的第 1、2、3 条：
摘要把返回元组当字符串、局部保存清空其余字段、切换提供方不生效。
"""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from ai_assistant.config import ai_config, save_settings
from ai_assistant.models import AiProvider, AiSetting, Conversation, Message

User = get_user_model()

CONFIGURED = {
    "BASE_URL": "https://env.invalid/v1",
    "API_KEY": "env-key",
    "CHAT_MODEL": "env-chat",
    "EMBED_MODEL": "env-embed",
    "EMBED_DIMS": 1536,
    "TIMEOUT": 5,
    "MAX_HISTORY": 10,
    "SUMMARY_TRIGGER": 20,
    "RETRIEVAL_TOP_K": 5,
    "RETRIEVAL_MAX_DISTANCE": 0.55,
    "KEYWORD_MAX_DISTANCE": 0.75,
    "MAX_QUESTION_LEN": 2000,
    "MAX_ANSWER_LEN": 4000,
}


@override_settings(AI_CONFIG=CONFIGURED)
class SummarizeTests(TestCase):
    """第 1 条：client.chat 返回 (text, usage)，摘要不能把元组当字符串。"""

    def setUp(self):
        self.user = User.objects.create_user("sum-user", password="x")
        self.conversation = Conversation.objects.create(user=self.user)
        # SUMMARY_TRIGGER=20，造 21 条让它必须压缩。
        for index in range(21):
            Message.objects.create(
                conversation=self.conversation,
                role="user" if index % 2 == 0 else "assistant",
                content="第 %d 条" % index,
            )

    def test_summary_stores_model_text_not_the_usage_tuple(self):
        from unittest.mock import patch

        from ai_assistant.views import _maybe_summarize

        with patch(
            "ai_assistant.views.call_model",
            return_value=("压好的摘要", {"prompt_tokens": 5, "completion_tokens": 2, "latency_ms": 9}),
        ):
            _maybe_summarize(self.conversation)

        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.summary, "压好的摘要")
        self.assertEqual(self.conversation.summarized_count, 21 - 10)

    def test_unusable_summary_does_not_break_the_answer(self):
        """上游给了空正文时，拼接会抛 TypeError，压缩要静默跳过而不是带崩提问。"""
        from unittest.mock import patch

        from ai_assistant.views import _maybe_summarize

        with patch("ai_assistant.views.call_model", return_value=(None, {})):
            _maybe_summarize(self.conversation)

        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.summary, "")

    def test_missing_model_config_skips_summary(self):
        """没配模型时压缩本来就不该发生。"""
        from unittest.mock import patch

        from ai_assistant.views import _maybe_summarize
        from ai_assistant.client import AiNotConfigured

        with patch("ai_assistant.views.call_model", side_effect=AiNotConfigured):
            _maybe_summarize(self.conversation)

        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.summary, "")


class SaveSettingsPatchTests(TestCase):
    """第 2 条：只提交一部分字段时，其余字段必须保持原样。"""

    def setUp(self):
        AiProvider.objects.all().delete()
        AiSetting.objects.all().delete()

    def _full_save(self):
        save_settings({
            "name": "A",
            "base_url": "https://a.example/v1",
            "chat_model": "model-a",
            "embed_model": "embed-a",
            "models_text": "model-a\nmodel-b",
            "rag_backend": "hybrid",
            "retrieval_max_distance": "0.55",
            "keyword_max_distance": "1",
            "max_history": 10,
            "summary_trigger": 20,
            "reasoning_effort": "high",
        })

    def test_patch_save_keeps_untouched_fields(self):
        self._full_save()
        save_settings({"chat_model": "model-b"})

        row = AiSetting.load()
        self.assertEqual(row.base_url, "https://a.example/v1")
        self.assertEqual(row.embed_model, "embed-a")
        self.assertEqual(row.models_text, "model-a\nmodel-b")
        self.assertEqual(row.rag_backend, "hybrid")
        self.assertEqual(row.max_history, 10)
        self.assertEqual(row.summary_trigger, 20)
        self.assertEqual(row.reasoning_effort, "high")
        self.assertEqual(row.chat_model, "model-b")

    def test_clear_api_key_keeps_other_fields(self):
        self._full_save()
        save_settings({"clear_api_key": True})

        row = AiSetting.load()
        self.assertEqual(row.api_key_cipher, "")
        self.assertEqual(row.base_url, "https://a.example/v1")
        self.assertEqual(row.models_text, "model-a\nmodel-b")

    def test_explicit_empty_string_still_clears(self):
        """显式传空串是「清掉这项」，不能被当成没提交。"""
        self._full_save()
        save_settings({"base_url": ""})

        row = AiSetting.load()
        self.assertEqual(row.base_url, "")
        self.assertEqual(row.chat_model, "model-a")


@override_settings(AI_CONFIG=CONFIGURED)
class ProviderSwitchTests(TestCase):
    """第 3 条：切换提供方后，ai_config() 必须真的换成新那组。"""

    def setUp(self):
        AiProvider.objects.all().delete()
        AiSetting.objects.all().delete()
        self.admin = User.objects.create_user(
            "switch-admin", password="x", is_staff=True, is_superuser=True,
        )
        self.client = Client(SERVER_NAME="127.0.0.1")
        self.client.force_login(self.admin)

    def test_activating_another_provider_changes_resolved_config(self):
        save_settings({
            "name": "A", "base_url": "https://a.example/v1",
            "chat_model": "model-a", "embed_model": "embed-a",
        })
        second = AiProvider(name="B", base_url="https://b.example/v1",
                            chat_model="model-b", embed_model="embed-b")
        second.save()

        response = self.client.post(
            "/api/ai/providers/activate/",
            data=json.dumps({"id": second.id.hex}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        config = ai_config()
        self.assertEqual(config["BASE_URL"], "https://b.example/v1")
        self.assertEqual(config["CHAT_MODEL"], "model-b")
        self.assertEqual(config["EMBED_MODEL"], "embed-b")

    def test_switching_to_partial_provider_does_not_leak_old_endpoint(self):
        """新那组只填了模型名时，地址要回落环境变量，不能沿用上一组的。"""
        save_settings({
            "name": "A", "base_url": "https://a.example/v1", "chat_model": "model-a",
        })
        second = AiProvider(name="B", base_url="", chat_model="model-b")
        second.save()

        self.client.post(
            "/api/ai/providers/activate/",
            data=json.dumps({"id": second.id.hex}),
            content_type="application/json",
        )

        config = ai_config()
        self.assertEqual(config["CHAT_MODEL"], "model-b")
        self.assertEqual(config["BASE_URL"], "https://env.invalid/v1")
        self.assertEqual(AiSetting.load().base_url, "")

    def test_deleting_the_last_provider_clears_the_mirror(self):
        """组全删光后不能再拿着上一组的地址发请求。"""
        save_settings({
            "name": "A", "base_url": "https://a.example/v1", "chat_model": "model-a",
        })
        only = AiProvider.objects.get()

        self.client.post(
            "/api/ai/providers/delete/",
            data=json.dumps({"id": only.id.hex}),
            content_type="application/json",
        )

        config = ai_config()
        self.assertEqual(config["BASE_URL"], "https://env.invalid/v1")
        self.assertEqual(config["CHAT_MODEL"], "env-chat")

    def test_setting_row_still_supplies_thresholds(self):
        """提供方只管端点/密钥/模型，阈值仍由 AiSetting 提供，别一起盖掉。"""
        save_settings({
            "name": "A", "base_url": "https://a.example/v1",
            "chat_model": "model-a", "retrieval_max_distance": "0.42",
        })

        config = ai_config()
        self.assertEqual(config["BASE_URL"], "https://a.example/v1")
        self.assertAlmostEqual(config["RETRIEVAL_MAX_DISTANCE"], 0.42)


@override_settings(AI_CONFIG=CONFIGURED)
class SettingsEndpointPatchTests(TestCase):
    """走 HTTP 的那一层：输入区切模型不该把整份配置冲掉。"""

    def setUp(self):
        AiProvider.objects.all().delete()
        AiSetting.objects.all().delete()
        self.admin = User.objects.create_user(
            "settings-admin", password="x", is_staff=True, is_superuser=True,
        )
        self.client = Client(SERVER_NAME="127.0.0.1")
        self.client.force_login(self.admin)

    def _post(self, body):
        return self.client.post(
            "/api/ai/settings/save/",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_model_switch_from_composer_keeps_the_rest(self):
        self._post({
            "name": "A", "base_url": "https://a.example/v1",
            "chat_model": "model-a", "embed_model": "embed-a",
            "models_text": "model-a\nmodel-b", "rag_backend": "hybrid",
            "retrieval_max_distance": "0.5", "keyword_max_distance": "1",
            "max_history": 12, "summary_trigger": 30, "reasoning_effort": "high",
        })

        # 这就是 persistModelChoice 发的东西。
        response = self._post({"chat_model": "model-b", "reasoning_effort": ""})
        self.assertEqual(response.status_code, 200)

        row = AiSetting.load()
        self.assertEqual(row.chat_model, "model-b")
        self.assertEqual(row.base_url, "https://a.example/v1")
        self.assertEqual(row.embed_model, "embed-a")
        self.assertEqual(row.models_text, "model-a\nmodel-b")
        self.assertEqual(row.rag_backend, "hybrid")
        self.assertEqual(row.max_history, 12)
        self.assertEqual(row.summary_trigger, 30)
        self.assertEqual(row.reasoning_effort, "")

    def test_modal_save_persists_all_three_context_fields(self):
        """弹窗保存按钮现在会带上这三个，存不进去就是回归。"""
        response = self._post({
            "name": "A", "base_url": "https://a.example/v1",
            "chat_model": "model-a", "models_text": "model-a",
            "max_history": 8, "summary_trigger": 25, "reasoning_effort": "medium",
        })
        self.assertEqual(response.status_code, 200)

        row = AiSetting.load()
        self.assertEqual(row.max_history, 8)
        self.assertEqual(row.summary_trigger, 25)
        self.assertEqual(row.reasoning_effort, "medium")
