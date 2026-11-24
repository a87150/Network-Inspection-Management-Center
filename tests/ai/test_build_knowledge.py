"""build_knowledge 的分批、失败隔离和增量判定。"""
import io
from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from ai_assistant.client import AiUpstreamError
from ai_assistant.management.commands.build_knowledge import _embed_batch, _sync
from ai_assistant.models import KnowledgeDoc

VECTOR = [0.1] * 1536


def _doc(name, content="c"):
    return {"title": name, "content": content, "category": "测试"}


class SyncTests(TestCase):
    def test_unchanged_embedded_doc_is_skipped(self):
        KnowledgeDoc.objects.create(
            title="T", content="x", category="测试", embedded_at=timezone.now())
        pending, skipped = _sync([_doc("T", "x")], False, io.StringIO())
        self.assertEqual((len(pending), skipped), (0, 1))

    def test_changed_content_is_pending_again(self):
        KnowledgeDoc.objects.create(
            title="T", content="old", category="测试", embedded_at=timezone.now())
        pending, skipped = _sync([_doc("T", "new")], False, io.StringIO())
        self.assertEqual((len(pending), skipped), (1, 0))
        # 内容变了必须把 embedded_at 清掉，否则增量永远认为它已经嵌入过。
        self.assertIsNone(KnowledgeDoc.objects.get(title="T").embedded_at)

    def test_stale_title_is_removed(self):
        KnowledgeDoc.objects.create(title="旧条目", content="x", category="测试")
        _sync([_doc("新条目")], False, io.StringIO())
        self.assertFalse(KnowledgeDoc.objects.filter(title="旧条目").exists())

    def test_rebuild_clears_before_inserting(self):
        KnowledgeDoc.objects.create(title="旧条目", content="x", category="测试")
        pending, _ = _sync([_doc("新条目")], True, io.StringIO())
        self.assertEqual(len(pending), 1)
        self.assertEqual(list(KnowledgeDoc.objects.values_list("title", flat=True)), ["新条目"])


class EmbedBatchTests(TestCase):
    def test_batch_failure_falls_back_to_single_docs(self):
        docs = [SimpleNamespace(title=name, content="c") for name in ("A", "B", "C")]

        def fake(texts):
            if len(texts) > 1:
                raise AiUpstreamError("整批失败")
            if "B" in texts[0]:
                raise AiUpstreamError("单条失败")
            return [[0.1]]

        failed = []
        with patch("ai_assistant.management.commands.build_knowledge.embed", side_effect=fake):
            results = _embed_batch(docs, failed)
        # 一条坏数据不能拖累同批其他条目。
        self.assertEqual([doc.title for doc, _ in results], ["A", "C"])
        self.assertEqual([title for title, _ in failed], ["B"])

    def test_hand_batches_requests_by_32(self):
        with self.settings(AI_CONFIG={**settings.AI_CONFIG,
                                      "BASE_URL": "http://local.test/v1",
                                      "API_KEY": "test-key"}):
            with patch("ai_assistant.management.commands.build_knowledge._store",
                       return_value=True), \
                 patch("ai_assistant.management.commands.build_knowledge.embed",
                       side_effect=lambda texts: [VECTOR for _ in texts]) as embed:
                call_command("build_knowledge")

        sizes = [len(call.args[0]) for call in embed.call_args_list]
        self.assertTrue(sizes)
        self.assertTrue(all(size <= 32 for size in sizes), sizes)
        self.assertEqual(sum(sizes), KnowledgeDoc.objects.count())
