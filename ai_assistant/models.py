"""AI 助手的会话与知识库。

一个用户一条会话，消息只增不删，靠 summary 压缩维持上下文。
知识库的 embedding 是 MariaDB 原生 VECTOR 列，ORM 不映射（Django 没有 VectorField），
读写走 ai_assistant.retrieval 里的原生 SQL。
"""
import uuid

from django.conf import settings
from django.db import models


class Conversation(models.Model):
    """一个人一条会话，OneToOne 保证。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="ai_conversation",
    )
    summary = models.TextField(blank=True)
    summarized_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return "AI 会话 · %s" % self.user


class Message(models.Model):
    ROLES = [("user", "user"), ("assistant", "assistant")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, related_name="messages", on_delete=models.CASCADE,
    )
    role = models.CharField(max_length=16, choices=ROLES)
    content = models.TextField()
    # 被拦截或拒答的消息，前端换一层弱底色，和正常回答区分开。
    blocked = models.BooleanField(default=False)
    # [{"title": ..., "distance": ...}]，只存标题，不存整段正文。
    sources = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return "%s · %s" % (self.role, self.content[:24])


class KnowledgeDoc(models.Model):
    """知识库条目。

    embedding 列由迁移里的 RunSQL 建成 VECTOR(1536)，这里不声明：
    写自定义 VectorField 要处理读写转换、表单 widget、迁移序列化，为一张表不值得。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=256)
    content = models.TextField()
    category = models.CharField(max_length=64, blank=True)
    embedded_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["category", "title"]

    def __str__(self):
        return self.title
