"""AI 知识库与检索的回归测试。

对应 docs/functional-review-2.32.md 的 6、7、12、14。
"""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from ai_assistant.models import KnowledgeDoc

User = get_user_model()

CONFIGURED = {
    "BASE_URL": "https://ai.invalid/v1", "API_KEY": "k", "CHAT_MODEL": "m",
    "EMBED_MODEL": "e", "EMBED_DIMS": 1536, "TIMEOUT": 5,
    "MAX_HISTORY": 10, "SUMMARY_TRIGGER": 20, "RETRIEVAL_TOP_K": 5,
    "RETRIEVAL_MAX_DISTANCE": 0.55, "KEYWORD_MAX_DISTANCE": 0.75,
    "MAX_QUESTION_LEN": 2000, "MAX_ANSWER_LEN": 4000,
}


class SplitChunksTests(TestCase):
    """7：超长段落切完要清空缓冲，否则同一段会入库两次。"""

    def test_a_paragraph_is_not_emitted_twice(self):
        from ai_assistant.views import split_chunks

        # 一段正常长度的段落，后面紧跟一段超长的（触发按行切的分支）。
        text = "第一段" * 4 + "\n\n" + ("超长段落的一行内容\n" * 40)
        chunks = split_chunks(text, limit=100)

        self.assertGreater(len(chunks), 1)
        first = "第一段" * 4
        hits = sum(chunk.count(first) for chunk in chunks)
        self.assertEqual(hits, 1, "同一段内容出现了 %d 次：%r" % (hits, chunks))


class ParseTableTests(TestCase):
    """12：表格导入要保留字段内的换行。"""

    def test_newline_inside_a_quoted_field_survives(self):
        from ai_assistant.views import _parse_table

        text = '标题,正文,分类\n"排查","第一步：登录取日志\n第二步：看端口","网络"\n'
        rows = _parse_table(text)

        self.assertEqual(len(rows), 1)
        self.assertIn("\n", rows[0]["content"])
        self.assertIn("第一步", rows[0]["content"])
        self.assertIn("第二步", rows[0]["content"])


@override_settings(AI_CONFIG=CONFIGURED)
class KnowledgeDeleteTests(TestCase):
    """6：删除接口要读 JSON body，非法 id 不能变成 500。"""

    def setUp(self):
        self.admin = User.objects.create_user(
            "kb-admin", password="x", is_staff=True, is_superuser=True,
        )
        self.client = Client(SERVER_NAME="127.0.0.1")
        self.client.force_login(self.admin)

    def _post(self, body):
        return self.client.post(
            "/api/ai/knowledge/delete/",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_json_body_deletes_the_row(self):
        doc = KnowledgeDoc.objects.create(title="要删的", content="内容")

        response = self._post({"id": doc.id.hex})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(KnowledgeDoc.objects.filter(pk=doc.pk).exists())

    def test_empty_id_is_a_404_not_a_crash(self):
        response = self._post({"id": ""})

        self.assertEqual(response.status_code, 404)
        self.assertIn("error", json.loads(response.content))

    def test_unknown_id_is_a_404(self):
        response = self._post({"id": "00000000000000000000000000000000"})

        self.assertEqual(response.status_code, 404)


class VectorFallbackTests(TestCase):
    """14：没配 AI 服务要上抛，其他故障才降级。"""

    def test_missing_configuration_propagates(self):
        from unittest.mock import patch

        from ai_assistant.client import AiNotConfigured
        from ai_assistant.retrieval import _safe_vector_search

        with patch("ai_assistant.retrieval.search", side_effect=AiNotConfigured):
            with self.assertRaises(AiNotConfigured):
                _safe_vector_search("问题", 5, 1.0)

    def test_other_failures_degrade_to_empty(self):
        from unittest.mock import patch

        from ai_assistant.retrieval import _safe_vector_search

        with patch("ai_assistant.retrieval.search", side_effect=RuntimeError("boom")):
            self.assertEqual(_safe_vector_search("问题", 5, 1.0), [])
