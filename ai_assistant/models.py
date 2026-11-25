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
    # 上游返回的 usage。没配模型或上游不给就留 0，页面按 0 跳过。
    prompt_tokens = models.IntegerField(default=0)
    completion_tokens = models.IntegerField(default=0)
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


class AiSetting(models.Model):
    """单例：页面上「配置 API」保存的值，覆盖 settings.AI_CONFIG 里的同名项。

    api_key 走项目现成的 Fernet（net.infrastructure.credentials），不要明文落库。
    空字符串表示「没在页面上覆盖」，回落到 settings / 环境变量。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    base_url = models.CharField(max_length=512, blank=True)
    api_key_cipher = models.TextField(blank=True)
    chat_model = models.CharField(max_length=128, blank=True)
    embed_model = models.CharField(max_length=128, blank=True)
    rag_backend = models.CharField(max_length=16, blank=True)
    retrieval_max_distance = models.FloatField(null=True, blank=True)
    keyword_max_distance = models.FloatField(null=True, blank=True)
    # 上下文压缩：保留多少条最近消息，总共超过多少条才触发摘要。
    max_history = models.IntegerField(null=True, blank=True)
    summary_trigger = models.IntegerField(null=True, blank=True)
    # 思考模式：空串表示不传这个参数（有的模型不支持，传错直接 400）。
    reasoning_effort = models.CharField(max_length=16, blank=True)
    # 可选模型名，一行一个。空表示只有 chat_model 一个。
    models_text = models.TextField(blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "AI 服务配置"

    def __str__(self):
        return "AI 服务配置"

    @classmethod
    def load(cls):
        return cls.objects.order_by("id").first()


class AiProvider(models.Model):
    """一个可切换的模型服务配置。

    端点和密钥是一组，模型名是另一层：换模型不必重填地址和密钥。
    `is_active` 决定当前用哪一组，同时只允许一个为真。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=64)
    base_url = models.CharField(max_length=512, blank=True)
    api_key_cipher = models.TextField(blank=True)
    chat_model = models.CharField(max_length=128, blank=True)
    embed_model = models.CharField(max_length=128, blank=True)
    is_active = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-is_active", "name"]

    def __str__(self):
        return self.name

    @classmethod
    def active(cls):
        return cls.objects.filter(is_active=True).first()
