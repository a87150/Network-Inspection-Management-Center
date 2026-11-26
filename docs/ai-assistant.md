# AI 助手页

页面在 `/ai/`，前端是 `static/app/vue/pages/ai_chat.mjs` 单页（无打包步骤），
接口挂在 `api/ai/`。本文写的是**已实现的行为**；当初的施工方案在
[ai-assistant-design.md](ai-assistant-design.md)，两者不冲突时以本文为准。

## 一次提问发生了什么

1. **预检**（`views.precheck`）。空消息直接拒；超过 `MAX_QUESTION_LEN`（2000 字）
   返回「问题过长」；命中注入模式（忽略之前的指令、system prompt、越狱、输出提示词……）
   返回固定文案。这一层只挡最直白的改写。
2. **检索**（`retrieval.retrieve`）。向量 + 关键词两路，RRF 融合出 top-k。
3. **空结果分流**。落空时先看知识库是不是真的空：空 → 提示去跑 `build_knowledge`；
   非空 → 「不在我的工作范围内」。**两种情况都不调模型**，因为把无关问题交给模型它会硬答。
4. **组装**。`SYSTEM` + `[摘要]` + 最近 `MAX_HISTORY` 条 + 【参考资料】+ 用户问题。
5. **调模型**（`client.chat`）。同步 HTTP，不流式。
6. **兜底**（`views.postcheck`）。空回答换成固定文案；超过 `MAX_ANSWER_LEN` 截断并注明。
   不做内容审查——容易误伤运维术语。
7. **落库**。一轮存两条：用户那条 token 记 0，本轮用量全归到回答上，避免重复计数。
8. **按需压缩**（`views._maybe_summarize`）。总消息数超过 `SUMMARY_TRIGGER` 才触发。

## 数据表

`ai_assistant/models.py`，迁移 `0001`–`0007`。

| 表 | 用途 | 关键字段 |
|---|---|---|
| `Conversation` | 一个人一条，`OneToOne` 保证 | `summary`、`summarized_count` |
| `Message` | 会话消息，只增不删 | `role`、`blocked`、`sources`、`prompt_tokens`、`completion_tokens`、`latency_ms` |
| `KnowledgeDoc` | 知识库条目 | `title`、`content`、`category`、`embedded_at` |
| `AiSetting` | 单例，页面上的「配置 API」 | `base_url`、`api_key_cipher`、模型名、阈值、`reasoning_effort` |
| `AiProvider` | 可切换的多套服务 | `name`、端点+密钥、模型名、`is_active` |

知识库的 `embedding` 是 **MariaDB 原生 `VECTOR(1536)` 列**，由迁移里的 `RunSQL` 建成，
ORM 不映射——写自定义 `VectorField` 要处理读写转换、表单 widget、迁移序列化，为一张表不值得。
读写全在 `retrieval.py` 的裸 SQL 里。

`blocked` 为真表示这条是拒答，前端换一层弱底色区分。`sources` 只存标题和 `via`，
不存整段正文——**不显示距离**，向量距离和关键词得分量纲不同，混着显示只会误导。

## 配置分三层

优先级从高到低：

1. **页面上的 `AiSetting`**。空字符串表示「没在这里覆盖」，回落到下一层。
   `api_key` 走项目现成的 Fernet（`net.infrastructure.credentials`），不落明文。
2. **`AiProvider`**。当前 `is_active` 的那套，端点+密钥一组、模型名一层，换模型不用重填地址。
3. **`settings.AI_CONFIG`**，最终来自环境变量。

`net/settings.py:89` 起的默认值：

| 项 | 默认 | 说明 |
|---|---|---|
| `CHAT_MODEL` | `gpt-4o-mini` | |
| `EMBED_MODEL` | `text-embedding-3-small` | |
| `EMBED_DIMS` | 1536 | 改这个要重建列和全部向量 |
| `TIMEOUT` | 60 秒 | |
| `MAX_HISTORY` | 10 | 每次带多少条原文 |
| `SUMMARY_TRIGGER` | 20 | 超过多少条开始压缩 |
| `RAG_BACKEND` | `hybrid` | `hybrid` / `vector` / `keyword` |
| `RETRIEVAL_TOP_K` | 5 | |
| `RETRIEVAL_MAX_DISTANCE` | 0.55 | 向量路的距离上限 |

`reasoning_effort` 空串表示**不传这个参数**——有的模型收到就返回 400，不能一律带上。

## 检索：两路 + RRF

```
vector   调 embedding，VEC_DISTANCE_COSINE 排序，超过 MAX_DISTANCE 的丢掉
keyword  分词后在标题和正文里算命中，不调模型
```

融合用 **RRF（`RRF_K = 60`）**：每路只贡献 `1/(60+rank)`，不掺原始距离。
两路都排第一的条目得分约 0.033，足以排到最前；而一个只在正文擦边的条目拿不到这个分。
不用加权分数，是因为向量距离和关键词得分根本没有可比的量纲。

标题强匹配另给 `TITLE_BOOST = 0.05`，条件是查询词在标题里的覆盖率 ≥
`TITLE_COVERAGE = 0.6`。这个量级能顶起真正的标题命中，又不足以让擦边条目挤掉双路命中。

**一路失败不连累另一路**：向量路抛任何异常都退化成空列表，关键词照跑
（`_safe_vector_search`）。但 `AiNotConfigured` 单独往上抛——那不是故障，
是整条检索被关掉了，吞成空列表会让用户看到误导性的「不在我的工作范围内」。

### 什么时候用哪条路

| 场景 | 走哪条 |
|---|---|
| 正常配置 | hybrid（默认） |
| 没配 `AI_BASE_URL` / 没有 embedding 模型 | 自动退化关键词 |
| 向量服务超时、维度不符 | 本轮退化关键词，下轮重试 |
| 想完全不调模型、只要字面匹配 | 把 `RAG_BACKEND` 设成 `keyword` |

### 阈值怎么调

页面上有 `retrieve_test` 接口：输入一句话，直接看命中哪些条目、距离多少。
调 `RETRIEVAL_MAX_DISTANCE` 时对着它看——调太松会把无关条目塞进参考资料，
调太紧会让本来能答的问题变成「不在范围内」。

## 知识库

分类写死在六个里：设备手册、故障案例、模板说明、告警规则、巡检规范、其他。
自由输入会让「故障」「故障案例」「fault_case」各自成类，将来按分类做元数据过滤就失效了。

入库：

```bash
python manage.py build_knowledge          # 种子抽取 + 分块 + 向量化
python manage.py calibrate_retrieval       # 标定距离阈值
```

**分块**（`views.split_chunks`）：单条超过 500 字就按段落切开。整篇塞成一个向量，
语义会被平均掉，检索时既不像这段也不像那段。切点优先取空行，其次单行，最后按长度硬切——
宁可切断一句话，也不能让一条记录超过 embedding 的输入上限。

维护接口：列表 / 新增 / 表格导入 / 删除。导入走 `_parse_table`，按表格行解析。

## 拒答分五种，文案各不相同

| 触发 | 返回 |
|---|---|
| 空消息 | `OFF_TOPIC_REPLY` |
| 超长（> 2000 字） | `TOO_LONG_REPLY` |
| 命中注入模式 | `INJECTION_REPLY` |
| 知识库为空且没命中 | `EMPTY_KNOWLEDGE`，提示去跑 `build_knowledge` |
| 知识库非空但没命中 | `OFF_TOPIC_REPLY` |
| 没配 AI 服务 | `UNCONFIGURED`，提示填 `AI_BASE_URL` |

区分「库是空的」和「只是没命中」很重要：前者是部署没做完，后者是问题超纲，
混成一句话会让人一直去改配置。

## 上下文压缩

总消息数超过 `SUMMARY_TRIGGER`（默认 20）时，把 `summarized_count` 到
`总数 - MAX_HISTORY` 这段老消息交给模型压成三句话以内的摘要，要求保留设备名、
用户的问题、已经排查过的动作。摘要作为额外一条 system 消息塞进下一轮的上下文。

压缩是**旁路**：模型调用失败、写库失败都只跳过这一轮，不影响已经存好的回答。
压缩失败最多让上下文更长一点，不该让用户看到一个 500。

## 已知边界

- **单用户单会话**。一人一条，没有会话列表和归档，只给「清空」出口。要多轮并列得先加表。
- **同步请求，不流式**。长回答要等完整返回。
- **不做工具编排**。问「某台设备现在什么状态」答不了——那是查库不是查知识。
  真要加的话位置在 `chat()` 里：一次判断调用输出 `{"need_tool": true, "keyword": ...}`，
  命中就查设备表拼进参考资料再调一次模型，两次调用一个 if，不建工具注册表。
- **检索只按语义和字面**，没有按分类/时间的元数据过滤，也没有重排模型。
- **答案里的数字不校验**。模型可能把「85%」写成「90%」，要精确值去查记录页。

## 接口清单

`ai_assistant/urls.py`，挂在 `index/urls.py:35` 的 `api/ai/`：

| 路径 | 方法 | 用途 |
|---|---|---|
| `chat/` | POST | 提问 |
| `history/` | GET | 取会话历史 |
| `reset/` | POST | 清空会话 |
| `providers/` | GET | 列出服务配置 |
| `providers/save/` | POST | 新增或修改 |
| `providers/activate/` | POST | 切换当前服务 |
| `providers/delete/` | POST | 删除 |
| `retrieve_test/` | GET | 检索自检 |
| `settings/` | GET | 读配置 |
| `settings/save/` | POST | 存配置 |
| `knowledge/` | GET | 知识库列表 |
| `knowledge/add/` | POST | 新增条目 |
| `knowledge/import/` | POST | 表格导入 |
| `knowledge/delete/` | POST | 删除条目 |

## 测试

`tests/ai/` 四个文件：`test_assistant`（主流程、拒答、压缩、reset）、
`test_build_knowledge`（分块与入库）、`test_config_merge`（三层配置优先级）、
`test_knowledge_retrieval`（两路检索与融合）。
