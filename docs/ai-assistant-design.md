# 天枢 AI 助手模块设计方案

> 版本：v1.0 | 项目：Network-Inspection-Management-Center
> 定位：在现有 Django + Vue 平台上新增 AI 对话式运维入口，只读查询起步，逐步演进为对话驱动的自动化。
> 保存：整段复制本文件内容，保存为 docs/ai-assistant-design.md

---

## 1. 背景与目标

现状：天枢已有手动/定时巡检、规则分析、历史查询、PC 日志接收、设备模板继承，后端 Django+DRF，前端 Vue。

问题：运维取数需逐页点击组合筛选，跨模块汇总成本高；简单巡检触发也要多步操作。

目标：
- 自然语言取数："上周哪些交换机有异常"直接得结构化答案
- 对话式触发："巡检核心交换机"生成任务并执行
- 知识问答：基于设备手册、历史故障案例给处置建议
- 不侵入：不改现有巡检执行链路，AI 是入口层而非执行层
- 可降级：LLM 不可用时原有功能完全不受影响

非目标（首期）：设备配置变更、替代定时 Worker、多租户隔离。

---

## 2. 总体架构

    ┌──────────────────────────────────────────────┐
    │ 前端 Vue AI 页面 (/ai)                        │
    │ 对话流 · 工具步骤折叠 · 结构化卡片 · 快捷指令   │
    └──────────────────┬───────────────────────────┘
                       │ SSE (text/event-stream)
    ┌──────────────────▼───────────────────────────┐
    │ Agent 编排层 (Django app: ai_assistant)       │
    │ 会话→意图→工具选择→参数填充→执行→汇总          │
    │ ReAct 循环 · 多轮上下文 · 审计日志             │
    └───────┬───────────────────────┬──────────────┘
            │                       │
    ┌───────▼────────┐      ┌───────▼───────────────┐
    │ 工具层 Tools    │      │ 知识层 RAG             │
    │ 对现有 API 薄封装│      │ 设备手册/故障案例       │
    │ 只读/轻量触发   │      │ pgvector top-k 检索    │
    └───────┬────────┘      └───────────────────────┘
            │ 调用现有 ViewSet / Service
    ┌───────▼───────────────────────────────────────┐
    │ 现有业务层：设备/巡检/规则/历史/PC日志           │
    │ 权限、审计、数据一致性仍由 Django 原有机制保证   │
    └───────────────────────────────────────────────┘

设计原则：
1. AI 不绕过现有 API，工具即现有 REST 封装，复用权限校验
2. 读写分离：只读自动执行，写操作必须用户确认卡片
3. 编排层无状态，会话状态存库，Agent 可水平扩展
4. 流式优先，所有输出走 SSE，前端逐步渲染

---

## 3. 目录结构

    Network-Inspection-Management-Center/
    ├── backend/
    │   ├── ai_assistant/
    │   │   ├── apps.py / models.py / serializers.py / views.py / urls.py
    │   │   ├── agent/
    │   │   │   ├── orchestrator.py   # ReAct 主循环
    │   │   │   ├── llm_client.py     # LLM 适配
    │   │   │   ├── prompts.py        # System prompt
    │   │   │   └── memory.py         # 上下文裁剪
    │   │   ├── tools/
    │   │   │   ├── base.py           # Tool 基类 + 注册装饰器
    │   │   │   ├── read_tools.py     # 只读工具
    │   │   │   ├── action_tools.py   # 轻量触发
    │   │   │   └── schemas.py        # 参数 JSON Schema
    │   │   ├── rag/
    │   │   │   ├── embedder.py / indexer.py / retriever.py
    │   │   ├── services/
    │   │   │   ├── audit.py / sse.py
    │   │   └── migrations/
    │   └── config/settings.py
    ├── frontend/src/
    │   ├── views/AIAssistant/
    │   │   ├── index.vue
    │   │   ├── components/ ChatStream.vue / MessageItem.vue / ToolCallStep.vue
    │   │   │   ResultCard.vue / TaskConfirmCard.vue / QuickPrompts.vue
    │   │   └── composables/useSSE.ts
    │   └── api/ai.js
    └── docs/ai-assistant-design.md

---

## 4. 数据模型

文件：backend/ai_assistant/models.py

```python
from uuid import uuid4
from django.conf import settings
from django.db import models
from pgvector.django import VectorField

class AIConversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid4)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=128, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["user", "-updated_at"])]

class AIMessage(models.Model):
    ROLE_CHOICES = [("user", "user"), ("assistant", "assistant"), ("tool", "tool")]
    conversation = models.ForeignKey(AIConversation, related_name="messages", on_delete=models.CASCADE)
    role = models.CharField(max_length=16, choices=ROLE_CHOICES)
    content = models.TextField(blank=True)
    payload = models.JSONField(default=dict, blank=True)
    token_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["conversation", "created_at"])]

class AIToolCallLog(models.Model):
    STATUS = [("success", "success"), ("error", "error"), ("pending_confirm", "pending_confirm")]
    conversation = models.ForeignKey(AIConversation, on_delete=models.CASCADE)
    message = models.ForeignKey(AIMessage, null=True, on_delete=models.SET_NULL)
    tool_name = models.CharField(max_length=64)
    arguments = models.JSONField(default=dict)
    result_summary = models.TextField(blank=True)
    status = models.CharField(max_length=16, choices=STATUS)
    error = models.TextField(blank=True)
    duration_ms = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["tool_name", "-created_at"])]

class AIKnowledgeDoc(models.Model):
    CATEGORY = [("device_manual","设备手册"),("fault_case","历史故障案例"),
                ("template_doc","模板说明"),("other","其他")]
    category = models.CharField(max_length=32, choices=CATEGORY)
    title = models.CharField(max_length=256)
    content = models.TextField()
    metadata = models.JSONField(default=dict)
    embedding = VectorField(dimensions=1536, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["category"])]
```

依赖与配置：

    # requirements.txt 追加
    pgvector>=0.2
    openai>=1.0
    tiktoken>=0.5

```python
# settings.py
INSTALLED_APPS += ["ai_assistant", "pgvector.django"]

AI_CONFIG = {
    "LLM_PROVIDER": "openai",
    "LLM_BASE_URL": os.getenv("LLM_BASE_URL", ""),
    "LLM_API_KEY": os.getenv("LLM_API_KEY", ""),
    "LLM_MODEL": os.getenv("LLM_MODEL", "gpt-4o-mini"),
    "MAX_TOOL_STEPS": 6,
    "MAX_CONTEXT_TOKENS": 6000,
    "ENABLE_RAG": True,
    "RAG_BACKEND": "vector",   # vector | keyword
    "SSE_HEARTBEAT_SECONDS": 15,
}
```

---

## 5. 工具层设计

### 5.1 基类与注册

文件：tools/base.py

```python
from dataclasses import dataclass
from typing import Any, Callable
from enum import Enum

class ToolRisk(str, Enum):
    READ = "read"            # 自动执行
    ACTION = "action"        # 自动执行但需告知
    SENSITIVE = "sensitive"  # 必须用户确认

@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    risk: ToolRisk
    handler: Callable[..., Any]

TOOL_REGISTRY: dict[str, Tool] = {}

def register_tool(name, description, parameters, risk=ToolRisk.READ):
    def decorator(fn):
        TOOL_REGISTRY[name] = Tool(name, description, parameters, risk, fn)
        return fn
    return decorator

def get_openai_tools():
    return [{"type":"function","function":{"name":t.name,"description":t.description,
             "parameters":t.parameters}} for t in TOOL_REGISTRY.values()]
```

### 5.2 只读工具

文件：tools/read_tools.py（handler 内部调用项目已有 Service/ViewSet，路径按实际调整）

```python
from .base import register_tool, ToolRisk

@register_tool(
    name="query_device_status",
    description="查询指定设备（IP/主机名/设备ID）当前状态、最近巡检时间、异常标识。",
    parameters={"type":"object","properties":{
        "keyword":{"type":"string","description":"IP/主机名/设备ID，模糊匹配"},
        "limit":{"type":"integer","default":10,"maximum":50}},
        "required":["keyword"]},
    risk=ToolRisk.READ,
)
def query_device_status(user, keyword, limit=10):
    from devices.models import Device
    qs = Device.objects.filter(name__icontains=keyword) | Device.objects.filter(ip__icontains=keyword)
    if not user.is_superuser:
        qs = qs.filter(owner=user)
    return [{"id":d.id,"name":d.name,"ip":d.ip,"status":d.status,
             "last_inspection_at":d.last_inspection_at} for d in qs.distinct()[:limit]]

@register_tool(
    name="list_anomalies",
    description="按时间范围和严重级别汇总巡检异常。",
    parameters={"type":"object","properties":{
        "start_time":{"type":"string","description":"ISO8601"},
        "end_time":{"type":"string"},
        "severity":{"type":"string","enum":["critical","warning","info","all"],"default":"all"},
        "limit":{"type":"integer","default":20,"maximum":100}},
        "required":["start_time","end_time"]},
    risk=ToolRisk.READ,
)
def list_anomalies(user, start_time, end_time, severity="all", limit=20):
    from inspection.models import InspectionResult
    qs = InspectionResult.objects.filter(
        created_at__gte=start_time, created_at__lte=end_time, is_anomaly=True
    ).select_related("device")
    if severity != "all":
        qs = qs.filter(severity=severity)
    return [{"device":r.device.name,"ip":r.device.ip,"rule":r.rule_name,
             "severity":r.severity,"summary":r.summary,"time":r.created_at}
            for r in qs.order_by("-created_at")[:limit]]

@register_tool(
    name="query_inspection_history",
    description="查询某设备或某任务的历史巡检记录。",
    parameters={"type":"object","properties":{
        "device_keyword":{"type":"string"},"task_id":{"type":"integer"},
        "days":{"type":"integer","default":7,"maximum":90},
        "limit":{"type":"integer","default":20}}},
    risk=ToolRisk.READ,
)
def query_inspection_history(user, device_keyword=None, task_id=None, days=7, limit=20):
    ...  # 复用现有查询逻辑

@register_tool(
    name="search_pc_logs",
    description="在 PC 日志中按主机名、关键字、时间范围检索。",
    parameters={"type":"object","properties":{
        "hostname":{"type":"string"},"keyword":{"type":"string"},
        "days":{"type":"integer","default":1,"maximum":30},
        "limit":{"type":"integer","default":50,"maximum":200}},
        "required":["keyword"]},
    risk=ToolRisk.READ,
)
def search_pc_logs(user, keyword, hostname=None, days=1, limit=50):
    ...

@register_tool(
    name="query_rule_results",
    description="查询某次巡检任务触发的规则分析结果详情。",
    parameters={"type":"object","properties":{"task_id":{"type":"integer"}},
                "required":["task_id"]},
    risk=ToolRisk.READ,
)
def query_rule_results(user, task_id):
    ...
```

### 5.3 轻量触发工具

文件：tools/action_tools.py

```python
@register_tool(
    name="trigger_inspection",
    description="对指定设备触发一次即时巡检。执行前需在对话中展示任务预览并得到确认。",
    parameters={"type":"object","properties":{
        "device_ids":{"type":"array","items":{"type":"integer"},"minItems":1},
        "template_id":{"type":"integer"}},
        "required":["device_ids"]},
    risk=ToolRisk.ACTION,
)
def trigger_inspection(user, device_ids, template_id=None):
    from inspection.services import create_and_dispatch_task
    task = create_and_dispatch_task(user=user, device_ids=device_ids, template_id=template_id)
    return {"task_id":task.id,"status":task.status,"device_count":len(device_ids)}
```

### 5.4 风险策略

| 风险等级 | 执行策略 | 前端表现 |
|---|---|---|
| READ | 直接执行 | 折叠步骤，显示参数与摘要 |
| ACTION | 直接执行，结果卡片展示 | "已触发任务 #123" |
| SENSITIVE | 拦截，生成确认卡片 | 确认/取消按钮 |

MVP 阶段不实现 SENSITIVE，预留接口即可。

---

## 6. Agent 编排层

### 6.1 主循环

文件：agent/orchestrator.py

```python
import json, time
from django.conf import settings
from ai_assistant.tools.base import TOOL_REGISTRY, get_openai_tools, ToolRisk
from ai_assistant.services.audit import log_tool_call
from .llm_client import chat_completion
from .prompts import build_system_prompt
from .memory import build_context

def run_agent(conversation, user_message, user):
    cfg = settings.AI_CONFIG
    system_prompt = build_system_prompt(user)

    rag_context = ""
    if cfg["ENABLE_RAG"]:
        from ai_assistant.rag.retriever import retrieve
        docs = retrieve(user_message, top_k=4)
        if docs:
            rag_context = "\n\n[参考知识]\n" + "\n---\n".join(
                f"[{d.title}]\n{d.content[:800]}" for d in docs)

    messages = build_context(conversation, user_message, system_prompt + rag_context)
    yield {"type": "message_start"}

    for _ in range(cfg["MAX_TOOL_STEPS"]):
        resp = chat_completion(messages, tools=get_openai_tools(), stream=True)
        collected_text, tool_calls = "", []
        for chunk in resp:
            if chunk.delta_text:
                collected_text += chunk.delta_text
                yield {"type":"token","content":chunk.delta_text}
            if chunk.tool_call:
                tool_calls.append(chunk.tool_call)

        if not tool_calls:
            messages.append({"role":"assistant","content":collected_text})
            yield {"type":"message_end","content":collected_text}
            return

        for tc in tool_calls:
            tool = TOOL_REGISTRY.get(tc.name)
            if not tool:
                yield {"type":"error","message":f"未知工具: {tc.name}"}; continue

            yield {"type":"tool_call","tool":tc.name,
                   "arguments":tc.arguments,"risk":tool.risk.value}

            t0 = time.time()
            try:
                if tool.risk == ToolRisk.SENSITIVE:
                    yield {"type":"card","card_type":"confirm",
                           "payload":{"tool":tc.name,"arguments":tc.arguments}}
                    return
                result = tool.handler(user=user, **(tc.arguments or {}))
                status, err = "success", ""
            except Exception as e:
                result, status, err = None, "error", str(e)

            duration = int((time.time()-t0)*1000)
            log_tool_call(conversation, tc.name, tc.arguments, result, status, err, duration)

            card = _maybe_card(tc.name, result)
            if card:
                yield {"type":"card","card_type":card["type"],"payload":card["payload"]}

            yield {"type":"tool_result","tool":tc.name,"status":status,
                   "summary":_summarize(result if status=="success" else err),
                   "duration_ms":duration}

            messages.append({"role":"tool","tool_call_id":tc.id,
                "content":json.dumps(result, ensure_ascii=False, default=str)[:4000]})

    yield {"type":"error","message":"达到最大工具调用步数，已终止"}

def _summarize(data):
    s = json.dumps(data, ensure_ascii=False, default=str)
    return s if len(s) <= 300 else s[:300] + "..."

def _maybe_card(tool_name, result):
    if tool_name == "trigger_inspection" and result:
        return {"type":"task","payload":result}
    if tool_name == "list_anomalies" and result:
        return {"type":"anomaly_list","payload":result[:10]}
    return None
```

### 6.2 System Prompt

文件：agent/prompts.py

```python
SYSTEM_TEMPLATE = """你是「天枢网络管理巡检平台」的智能运维助手。

## 能力边界
- 只能通过提供的工具获取信息，禁止编造设备、任务、告警数据。
- 工具返回为空时如实告知"未查询到数据"，不要臆测。
- 涉及设备配置变更、删除、重启等操作，你无法执行，请引导用户使用平台对应页面。

## 回答规范
1. 先给结论，再给依据，例如"共 3 台设备异常：A、B、C"。
2. 列出设备时附上 IP，便于定位。
3. 时间以用户本地时区理解，工具参数使用 ISO8601。
4. 意图模糊时先追问关键信息。
5. 用户身份：{username}（{role}），仅返回该用户有权限的数据。

## 工具使用策略
- 信息查询优先调用工具，不要凭记忆回答。
- 触发巡检类操作，先复述将要执行的内容，得到确认后再调用。
- 一次回答工具调用不超过 3 次；不足时先回答已知信息再询问。
"""

def build_system_prompt(user):
    return SYSTEM_TEMPLATE.format(
        username=user.username,
        role="管理员" if user.is_superuser else "普通用户")
```

### 6.3 上下文管理

文件：agent/memory.py

```python
def build_context(conversation, new_user_message, system_prompt, max_tokens=6000):
    history = list(conversation.messages.order_by("-created_at")[:20])[::-1]
    messages = [{"role":"system","content":system_prompt}]
    for m in history:
        if m.role in ("user","assistant"):
            messages.append({"role":m.role,"content":m.content})
    messages.append({"role":"user","content":new_user_message})
    return messages
```

---

## 7. API 与 SSE 接口

### 7.1 路由

文件：urls.py

```python
from django.urls import path
from . import views

urlpatterns = [
    path("conversations/", views.ConversationListCreateView.as_view()),
    path("conversations/<uuid:pk>/", views.ConversationDetailView.as_view()),
    path("conversations/<uuid:pk>/messages/", views.MessageListView.as_view()),
    path("chat/stream/", views.chat_stream_view, name="ai_chat_stream"),
    path("tools/", views.tool_list_view),
]
```

### 7.2 SSE 视图

文件：views.py

```python
import json
from django.http import StreamingHttpResponse
from django.views.decorators.http import require_POST
from .models import AIConversation, AIMessage
from .agent.orchestrator import run_agent

@require_POST
def chat_stream_view(request):
    body = json.loads(request.body)
    conversation_id = body.get("conversation_id")
    user_message = body.get("message", "").strip()
    if not user_message:
        return StreamingHttpResponse(status=400)

    if conversation_id:
        conv = AIConversation.objects.get(id=conversation_id, user=request.user)
    else:
        conv = AIConversation.objects.create(user=request.user, title=user_message[:30])

    AIMessage.objects.create(conversation=conv, role="user", content=user_message)

    def event_stream():
        yield f"data: {json.dumps({'type':'conversation','id':str(conv.id)})}\n\n"
        full_text = ""
        try:
            for event in run_agent(conv, user_message, request.user):
                if event["type"] == "token":
                    full_text += event["content"]
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
        finally:
            AIMessage.objects.create(conversation=conv, role="assistant", content=full_text)

    resp = StreamingHttpResponse(event_stream(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp
```

### 7.3 事件协议

| type | 字段 | 说明 |
|---|---|---|
| conversation | id | 会话标识（首帧） |
| message_start | - | 助手开始回复 |
| token | content | 增量文本 |
| tool_call | tool/arguments/risk | 即将调用工具 |
| tool_result | tool/status/summary/duration_ms | 工具结果 |
| card | card_type/payload | 结构化卡片 |
| message_end | content | 完整文本 |
| error | message | 错误 |

---

## 8. RAG 知识层

### 8.1 入库

文件：rag/indexer.py

```python
from ai_assistant.models import AIKnowledgeDoc
from .embedder import embed_texts

def index_document(category, title, content, metadata=None, chunk_size=500, overlap=50):
    chunks = _split(content, chunk_size, overlap)
    vectors = embed_texts(chunks)
    for chunk, vec in zip(chunks, vectors):
        AIKnowledgeDoc.objects.create(
            category=category, title=title, content=chunk,
            metadata=metadata or {}, embedding=vec)

def _split(text, size, overlap):
    return [text[i:i+size] for i in range(0, len(text), size - overlap)]
```

### 8.2 检索

文件：rag/retriever.py

```python
from pgvector.django import CosineDistance
from ai_assistant.models import AIKnowledgeDoc
from .embedder import embed_query

def retrieve(query, top_k=4, threshold=0.25):
    vec = embed_query(query)
    return list(
        AIKnowledgeDoc.objects.exclude(embedding=None)
        .annotate(distance=CosineDistance("embedding", vec))
        .filter(distance__lte=threshold)
        .order_by("distance")[:top_k])
```

### 8.3 无 pgvector 降级

若用 SQLite 或不便部署 pgvector，采用关键词检索：
- 文档标题+内容建倒排索引（jieba 分词 + SQLite FTS5）
- 检索接口不变 retrieve(query, top_k)，内部实现切换
- AI_CONFIG["RAG_BACKEND"] = "keyword"

---

## 9. 前端设计

### 9.1 页面布局

    ┌─────────────────────────────────────────────────────┐
    │ 天枢 AI 助手                    [新会话]  [历史会话]  │
    ├──────────────┬──────────────────────────────────────┤
    │ 会话列表      │  用户：上周哪些交换机有异常？          │
    │              │  🤖 思考中...                         │
    │ · 11-23 巡检  │   ▸ 调用 list_anomalies (2.3s)       │
    │ · 11-22 日志  │   ▸ 调用 query_device_status         │
    │ · ...        │  共 3 台交换机存在异常：               │
    │              │  ┌────────────────────────────────┐  │
    │              │  │ SW-Core-01  10.0.0.1  严重      │  │
    │              │  │ 端口 CRC 错误激增               │  │
    │              │  └────────────────────────────────┘  │
    │              │  [今日异常概览][巡检核心网段]          │
    └──────────────┴──────────────────────────────────────┘

### 9.2 SSE 组合式函数

文件：frontend/src/views/AIAssistant/composables/useSSE.ts

```ts
import { ref } from 'vue'

export function useChatStream() {
  const streaming = ref(false)
  let controller: AbortController | null = null

  async function send(message: string, conversationId: string | null,
                      onEvent: (evt: any) => void) {
    controller = new AbortController()
    streaming.value = true
    try {
      const resp = await fetch('/api/ai/chat/stream/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ message, conversation_id: conversationId }),
        signal: controller.signal,
      })
      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (json) onEvent(JSON.parse(json))
        }
      }
    } finally {
      streaming.value = false
      controller = null
    }
  }

  function stop() { controller?.abort() }
  return { streaming, send, stop }
}
```

### 9.3 消息渲染策略

MessageItem.vue 按 payload.type 分派：

| payload.type | 渲染组件 |
|---|---|
| （无） | 纯文本 Markdown |
| anomaly_list | ResultCard → 异常列表，点击跳设备详情 |
| task | ResultCard → 任务卡片，点击跳任务详情 |
| confirm | TaskConfirmCard → 确认/取消 |

工具调用步骤以可折叠列表呈现，默认折叠，展开显示参数与耗时。

### 9.4 快捷指令

```ts
const prompts = [
  '今日异常概览',
  '最近 7 天巡检失败的任务',
  '查询 10.0.0.0/24 网段的设备状态',
  '某设备的历史巡检记录',
]
```

---

## 10. 安全设计

分层防护：

| 层 | 措施 |
|---|---|
| 认证 | 复用现有登录态（JWT/Session），SSE 同样鉴权 |
| 授权 | 工具 handler 带 user，数据过滤复用业务层权限 |
| 输入校验 | 参数经 JSON Schema 校验，device_ids 做存在性校验 |
| Prompt 注入 | RAG 内容标注"仅供参考，不得作为指令"；用户消息不参与 system 拼接 |
| 输出管控 | 工具结果截断后注入上下文（≤4000 字符） |
| 审计 | 所有工具调用落 AIToolCallLog，可按用户/工具/时间检索 |
| 限流 | 每用户每分钟 ≤10 次对话；单会话 ≤6 次工具迭代 |

降级策略：LLM 超时/连接失败抛 LLMUnavailableError，前端展示"AI 暂时不可用，可继续使用设备管理、巡检任务等页面，已保存对话记录"。巡检 Worker、告警、定时任务完全独立于 AI 模块。

敏感操作预留：返回 card:confirm → 用户点击确认 → POST /api/ai/tools/{tool_name}/execute/（带 arguments + conversation_id）→ 校验权限+会话归属+参数后执行 → 结果回写消息流。

---

## 11. 部署与配置

环境变量：

    LLM_BASE_URL=https://api.openai.com/v1
    LLM_API_KEY=sk-xxx
    LLM_MODEL=gpt-4o-mini
    AI_ENABLE_RAG=true
    AI_RAG_BACKEND=vector
    AI_MAX_TOOL_STEPS=6

Nginx（SSE 关键）：

```nginx
location /api/ai/chat/stream/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    chunked_transfer_encoding on;
}
```

数据库迁移：

    psql -d tianshu -c "CREATE EXTENSION IF NOT EXISTS vector;"
    python manage.py makemigrations ai_assistant
    python manage.py migrate

---

## 12. 里程碑与验收

| 阶段 | 周期 | 交付 | 验收标准 |
|---|---|---|---|
| M1 只读对话 | 1–2 周 | AI 页面 + 5 个只读工具 + SSE | "上周异常设备"准确返回，工具调用可见 |
| M2 触发自动化 | 1 周 | trigger_inspection + 任务卡片 | "巡检核心交换机"生成任务可跳转 |
| M3 RAG 增强 | 1–2 周 | 故障案例入库 + 检索注入 | 回答带引用来源，无编造 |
| M4 审批闭环 | 2 周 | 敏感工具确认流 + 审计看板 | 敏感操作二次确认，审计可查 |

M1 验收用例：

| 输入 | 期望 |
|---|---|
| 今天有什么异常 | 调用 list_anomalies，返回今日异常列表卡片 |
| 10.0.0.1 最近怎么样 | 调用 query_device_status + query_inspection_history，给出摘要 |
| 帮我重启核心交换机 | 告知无法执行，引导至设备页面 |
| 上个月日志里有没有 OOM | 调用 search_pc_logs，返回匹配条数与摘要 |
| 无权限用户查别人设备 | 返回"未查询到数据"，不泄露存在性 |

---

## 13. 后续扩展

- 多模型路由：简单查询走小模型，复杂诊断走大模型
- 对话式报表："生成上周巡检周报"编排多查询输出 Markdown
- 异常根因推荐：基于历史案例相似度匹配，主动推送处置建议
- 工具市场：工具注册抽象为可配置项，运维团队自行扩展
- 语音入口：对接语音识别，适配现场运维

---

## 附录 A：工具清单

| 工具名 | 风险 | 功能 |
|---|---|---|
| query_device_status | READ | 设备状态查询 |
| list_anomalies | READ | 异常汇总 |
| query_inspection_history | READ | 巡检历史 |
| query_rule_results | READ | 规则结果 |
| search_pc_logs | READ | 日志检索 |
| trigger_inspection | ACTION | 触发巡检 |
| generate_report（预留） | ACTION | 生成报告 |
| apply_config（预留） | SENSITIVE | 配置变更 |

## 附录 B：SSE 事件示例

    data: {"type":"conversation","id":"a1b2..."}
    data: {"type":"message_start"}
    data: {"type":"tool_call","tool":"list_anomalies","arguments":{"start_time":"2026-11-17T00:00:00","end_time":"2026-11-24T00:00:00","severity":"all"},"risk":"read"}
    data: {"type":"tool_result","tool":"list_anomalies","status":"success","summary":"...","duration_ms":234}
    data: {"type":"card","card_type":"anomaly_list","payload":[...]}
    data: {"type":"token","content":"共 3 台交换机存在异常："}
    data: {"type":"message_end","content":"共 3 台交换机存在异常：..."}

## 附录 C：快速启动清单

    # 1. 后端新增 app
    python manage.py startapp ai_assistant
    # 2. 安装依赖
    pip install pgvector openai tiktoken
    # 3. 数据库启用扩展
    psql -d tianshu -c "CREATE EXTENSION IF NOT EXISTS vector;"
    # 4. 迁移
    python manage.py makemigrations ai_assistant && python manage.py migrate
    # 5. 配置 .env（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
    # 6. 注册 URL: config/urls.py 加 path("api/ai/", include("ai_assistant.urls"))
    # 7. ai_assistant/apps.py ready() 中导入 read_tools、action_tools 确保注册
    # 8. python manage.py runserver

---

*本文档随实现迭代更新，工具清单与模型选择以实际部署为准。*