# 功能性问题审查 · 2.32

审查日期：2026-11-25
覆盖版本：`c906134`（2.32）
方式：按模块分工读代码 + 探针实测。**未改动任何代码**，本文档只记录问题与建议。

## 怎么用这份文档

每条都给了 `文件:行号`，行号以 `c906134` 为准。标记说明：

- **实测** —— 我写了探针脚本跑出来复现过，证据在下面「实测记录」一节
- **核对** —— 逐行读过源码确认，但没写探针
- **待确认** —— 看起来是问题，但要特定环境（真实 AD、SMTP 服务器）才能证实

统一处理时建议按「严重」→「中等」→「观察」的顺序，同一模块的条目一起改，避免互相踩。

## 修复进度

| 批次 | 条目 | 状态 |
| --- | --- | --- |
| 一 | 1（摘要元组）、2（局部保存清空）、3（切换不生效） | 已修 |
| 二 | A1（设备删不掉）、A9（凭证明文）、5（会话过期）、8（缓存不生效） | 已修 |
| 三 | 6（知识库删除）、7（长文档重复）、12（表格换行）、13（错误字段）、14（向量降级） | 已修 |
| 四 | 15（只读白名单）、17（获取成功恒 0）、18（排序方向）、20（重复按钮）、27（权限标志）、R8（未处理恒 0） | 已修 |
| 五 | 4（巡检方块口径）、A7（勾选列）、A8（筛选控件）、26（静默失败） | 已修 |
| 六 | 16（登录限流）、23（统计口径）、A2（部分成功）、A3（端口数）、A4（SNMP 总超时） | 已修 |
| 七 | R1（记录页任务）、R2（任务栏点击）、R3（失败静默）、R5（配额超时） | 已修 |
| — | 19、24 | **复查后撤回**，见「已排除」 |
| — | 9、10、22 | **需要产品口径**，见各条 |
| — | 21、R9 | 待实测确认 |
| — | 11、25、28、A5、A6、R4、R6、R7 | 未做，见下 |

### 还没做的九条

这九条都动到了结构或性能，不是改一行能收的，单独列出来避免误以为已经处理：

- **11 保存租约短于邮件发送耗时**：要改租约取值或让每次只领 1 行投递，牵涉投递语义。
- **25 同步全表重写 group_names**：要改成只更新变化的行并分批，得先有 dirty 追踪。
- **28 拓扑页三处绘制缺口**：orphan 兜底、链路截断提示、拖动重渲染，涉及前端绘制层。
- **A5 配置 ZIP 导出 N+1 + 全量解密进内存**：要改流式输出并加台数上限。
- **A6 CSV 以 IP 为主键时不加行锁**：要改并发判定和 `IntegrityError` 翻译。
- **R4 租约过期后同一设备可能被两个会话同时采集**：要给 target 加独立重试上限和互斥。
- **R6 进度聚合 O(N²)**：要把进度改成原子自增或终态一次性聚合。
- **R7 入队逐条校验 + 逐条 save**：要改 `bulk_create` 并分批提交。
- **9 域同步收窄范围批量停用** 与 **10 维护窗口抑制不生效**：两条都要先定产品口径（见对应条目）。

这九条我留着没动，是因为它们各自的收益要在大数据量或特定故障下才体现，而现在改等于在没有压测的情况下动并发和事务边界 —— 风险比收益大。

---

## 严重：会出错数、丢配置、功能静默失效

### 1. AI 摘要一启用就 500 【实测】【已修】

- 位置：`ai_assistant/views.py:176`（对照 `ai_assistant/client.py:85`）
- 问题：`client.chat()` 返回的是 `(text, usage)` 二元组，`_maybe_summarize` 直接把它当字符串存进 `summary`，第 186 行 `conversation.summary + "\n" + summary` 抛 `TypeError`。这里的 `except` 只捕 `AiNotConfigured` / `AiUpstreamError`，`TypeError` 直接冒泡。
- 影响：消息总数超过 `SUMMARY_TRIGGER`（默认 20，约第 11 轮问答）后，每次提问都在两条消息**已经入库之后**返回 500。前端 `ai_chat.mjs:205` 弹回草稿，用户重发 → 同一条提问重复落库；上下文压缩永远不生效，长对话无限膨胀。
- 建议：`summary, _usage = call_model([...])`；再把 186–188 行包进 `try/except (TypeError, DatabaseError)` —— 压缩失败不能连累提问。
- 测试缺口：`split_chunks` 有测试，`_maybe_summarize` 这条路径零覆盖。

### 2. 保存配置会清空其他字段 【实测】【已修】

- 位置：`ai_assistant/config.py:103-121`
- 问题：`save_settings` 是「全量覆盖」语义，payload 里没出现的键一律写成空串 / `None`。
- 影响：三条真实触发路径。
  - `ai_chat.mjs:449` 聊天输入区切模型只提交 `{chat_model, reasoning_effort}`
  - `ai_chat.mjs:385` 「清除已存 Key」只提交 `{clear_api_key: true}`
  - `ai_chat.mjs:259` 保存按钮压根没提交 `max_history` / `summary_trigger` / `reasoning_effort`
  前两条会把 `base_url` / `models_text` / `embed_model` / `rag_backend` / 两个阈值 / `max_history` / `summary_trigger` 全部抹平。`models_text` 清空 → 模型下拉塌成一项；`embed_model` 清空 → 向量路静默失效（库里已有的向量维度对不上）。
- 建议：改成逐键判断 `if "base_url" in payload: ...`；同时把 `ai_chat.mjs:259` 缺的三个字段补上。

### 3. 切换提供方实际不生效 【实测】【已修】

- 位置：`ai_assistant/config.py:41-58` + `ai_assistant/views.py:396`
- 问题：`ai_config()` 先用激活的 `AiProvider` 覆盖，随后被 `AiSetting` 行无条件再盖一遍；而 `provider_activate` 只写 `AiProvider`，不碰 `AiSetting`。
- 影响：UI 显示已切换、接口返回 `{"ok": true}`，但实际请求仍打旧端点、用旧密钥、旧模型。
- 建议：二选一 —— `AiSetting` 只补 `AiProvider` 为空的字段；或 `provider_activate` 成功后清空 `AiSetting` 的 `base_url` / `chat_model` / `embed_model` / `api_key_cipher`。

### 4. 巡检方块把「记录条数」当「设备台数」 【核对】

- 位置：`assets/overview.py:135-143`
- 问题：`infrastructure_queryset(kind, page)` 查的是 `RECORD_PAGES` 里的记录表（`Network_Device_Inspection` / `Server_Inspection` / `Monitor_Inspection`，见 `inspections/records.py:43-47`），每条巡检记录一行；`Count('pk')` 数的是记录数，第 149-151 行却按「台」输出。
- 影响：同一台设备巡检 3 次算 3 台。12 台交换机各跑 3 次 → 该方块显示「正常 32 台 · 异常 4 台」，而同页上方的设备总数是 12。数字随重跑次数线性虚高，与首页卡片直接冲突。
- 建议：按设备取每台最新一条记录再计数，复用 `net.dashboard.assets` 里 `latest_status` 的口径；两个字段拆成 `records` / `devices`，单位分别用「条」「台」。

### 5. 会话过期后所有 AJAX 静默返回 null 【核对】

- 位置：`static/app/vue/api.mjs:54-60`
- 问题：HTML 视图在会话过期时 `redirect_to_login` 返回 302 → `/login/` → 200 `text/html`。`fetch` 默认跟随重定向，`readPayload` 因 Content-Type 不是 JSON 返回 `null`，`response.ok` 为真，`apiRequest` 把 `null` 当成功载荷返回。
- 影响：`NET_SESSION_COOKIE_AGE=36000`（10 小时）且没开 `SESSION_SAVE_EVERY_REQUEST`，到点必失效。此时 `ip_management.mjs:71` 点台账、`configuration_diff.mjs:44` 重取、`resource_table.mjs:110` 翻页全部拿到 `null`，接着 `payload.results` 抛 `TypeError`，页面显示 `Cannot read properties of null` 而不是「请重新登录」。
- 建议：`apiRequest` 在 `readPayload` 之前加 `if (response.redirected || response.status === 401) throw new ApiError('登录已失效，请重新登录', 401)`；`readPayload` 返回 `null` 且 Content-Type 非 JSON 时按错误处理，别当成功。

### 6. 知识库条目删不掉 【实测】

- 位置：`ai_assistant/views.py:654-659`、`static/app/vue/pages/ai_chat.mjs`
- 问题：两个问题叠在一起。① 后端读 `request.POST.get("id")`，而前端 `api.mjs:50-52` 统一发 JSON body，`request.POST` 恒为空；② 前端从来没调用过这个接口 —— 全项目搜 `knowledge/delete` 只命中后端。
- 影响：加错的知识条目删不掉。哪天把按钮接上，`filter(pk="")` 会抛 `ValidationError: "＂不是一个有效的UUID"`，直接 500。
- 建议：改成 `json.loads(request.body).get("id")`（和 `provider_delete` 一致），再在知识库列表每行加删除按钮。

### 7. 长文档入库会重复一整段 【实测】

- 位置：`ai_assistant/views.py:42-43`
- 问题：`chunks.append(buffer)` 之后没有 `buffer = ""`，旧内容还留在 buffer 里，进入超长段落分支（第 48 行起）后又被拼进去、再 append 一次。
- 影响：知识库里出现重复条目，检索时同一段内容占两个结果位、挤掉真正相关的条目。现有测试 `test_long_content_is_split` 只断言 `len(chunk) <= 100`，重复文本照样通过。
- 建议：43 行后立刻 `buffer = ""`；补一条「所有 chunk 拼接后不含重复子串」的断言。

### 8. 页面缓存对真实浏览器完全不生效 【核对】

- 位置：`net/settings.py:159` vs `:163`、`net/infrastructure/page_cache.py:157`
- 问题：`PageCacheMiddleware` 排在 `GZipMiddleware` 之前，`process_response` 反向执行 → GZip 先给响应加 `Vary: Accept-Encoding`；而第 157 行的允许集合只有 `''` / `cookie` / `accept-language`，于是带 `Accept-Encoding: gzip` 的浏览器响应永远判不合格。
- 影响：`NET_PAGE_CACHE_ENABLED=true` 后缓存一次都不写，功能是死的，且没有任何日志或报错 —— 只有手写不带 gzip 的客户端才会命中。另外缓存键 `_identity`（第 86-99 行）不含 `Accept-Encoding`，只改 Vary 不改键还会串内容。
- 建议：把 `'accept-encoding'` 加进 157 行允许集合，并把 `Accept-Encoding` 纳入 `_identity()`；或把 GZip 移到 PageCache 之前，让缓存存未压缩内容。

### 9. 域同步收窄范围会把范围外账号批量停用 【核对】

- 位置：`net/domain/sync.py:349`
- 问题：把「本次快照里没出现」直接写成 `is_active=False`，等同于「AD 里账号被停用」。而快照范围由管理员可随时改的 `user_filter` / `computer_filter` / `base_dn` 决定。
- 影响：把 `user_filter` 收窄（比如只同步某部门）或用错筛选器同步一次，范围外的账号全被标成停用。UI 把这个字段当「是否启用」展示和计数（`index/common/table_registry.py:208`、`net/domain/statistics.py:22`），于是停用数、未登录统计全部与 AD 事实相反。第 349 行的 `if seen_accounts` 只保护「一条都没返回」，**部分返回照停不误**；`_check_search_result`（`sync.py:157`）只看结果码不看条数。
- 建议：把「不在同步范围」与「AD 停用」分列存储（`in_scope` / `disabled_reason`，统计只认 UAC 位）；或在停用前比对任务 `parameters_snapshot` 里的筛选器，变更时不执行停用并告警。

### 10. 维护窗口抑制完全不生效 【核对】

- 位置：`net/alerts/service.py:353`（配合 342、356-363）
- 问题：领取投递时写死 `event__event_type='summary'`，而 summary 事件的 `target_type` 恒为 `'task'`、`target_id` 是任务主键（`task_summaries.py:107`，DB 约束 `net/models/alerts.py:493` 强制）；`maintenance_targets()` 只会返回 `('network_device'|'server'|'monitor', 资产UUID)`。`exclude(Q(event__target_type=…, event__target_id=…))` 永远匹配不到任何一行。
- 影响：维护窗口内的告警照常外发，与维护页文案（`maintenance_list.mjs:133`、`assets/maintenance.py:185`、`MaintenanceWindow` docstring）宣称的「不外发」相反。`tests/alerts/test_maintenance_window.py` 只测了 `maintenance_targets()` 的集合，没测投递抑制，所以一直是绿的。
- 建议：先定产品口径 —— 若要按设备抑制，必须让 abnormal/recovery 事件也生成 `AlertDelivery`（目前全仓只有 `task_summaries.py:115` 建投递行），条件改成 `Q(event__target_run__target_type=…, event__target_run__target_id=…)`；若只保留 summary 投递，则删掉 `service.py:356-363` 这段死代码，并改掉三处「不外发」文案。

---

## 中等：行为与提示不一致、部分场景失效

### 11. 保存租约短于邮件发送耗时，会重复通知 【核对】

- 位置：`net/alerts/service.py:351`（租约常量在 20 行，领取在 377 行）
- 问题：`DELIVERY_LEASE_SECONDS=30`，而 `net/alerts/channels/email.py:43-56` 依次做 connect / starttls / login / send_message，每步 `SMTP_TIMEOUT=10`（`base.py:11`），最坏约 50 秒。领取事务在 `send_alert` 之前就已提交，发送期间只有时间戳保护。
- 影响：超过 30 秒后另一个 worker 会把同一行当「租约过期的 SENDING」重新领取再发一遍，收件人收到重复通知；首个 worker 的 `_finish_delivery` 被 `lease_token` 栅栏丢弃、结果记错。同批被预领的后续行也会集体过期，重复面更大。
- 建议：租约按通道取 `max(30, 适配器最坏耗时 × 2)`（email 至少 `SMTP_TIMEOUT * 5`）；或 `_claim_deliveries` 每次只领 1 行；并给 `AlertDelivery` 加发送前幂等检查。

### 12. 表格导入吞掉正文换行 【实测】

- 位置：`ai_assistant/views.py:626,635`
- 问题：先 `text.splitlines()` 再交给 `csv.reader(lines, dialect)`，行尾换行已被剥掉，解析器拼接跨行引号字段时插不回分隔符。
- 影响：多步骤的排查记录导入后粘成一整行，段落结构静默丢失；预览里看不出来。
- 建议：`csv.reader(io.StringIO(text), dialect)` 直接吃原始文本流，首行判定在 `rows[0]` 上做。

### 13. AI 接口的错误原因前端看不到 【核对】

- 位置：`static/app/vue/api.mjs:57` 对照 `ai_assistant/views.py` 的 8 处 `{"error": ...}`
- 问题：前端只读 `payload.message`，AI 模块统一返回 `payload.error`。
- 影响：「标题已存在，换个标题再试」「给这组配置起个名字」「还没配 AI 服务」这些提示全部退化成「请求失败（400）」。`ai_chat.mjs:519` 自己读了 `payload.error` 才正常，两套写法并存。
- 建议：`api.mjs` 改成 `payload.message || payload.error`，或后端统一字段名。

### 14. 向量检索故障被当成本问题拒答 【核对】

- 位置：`ai_assistant/retrieval.py:159`
- 问题：`except Exception: return []` 把 `AiNotConfigured`、上游超时、`VEC_DISTANCE_COSINE` 维度不匹配、SQL 报错全吞成空列表。
- 影响：hybrid 模式下向量路整条挂掉，用户只拿到关键词结果（via 标签全变「字面命中」），没有任何提示；关键词也没命中时 `retrieve()` 返回 `[]`，`views.py:250` 以「这个问题不在我的工作范围内」拒答 —— 用户以为是越权，实际是服务坏了。
- 建议：`AiNotConfigured` 单独上抛，其余异常记 `logger.warning` 再降级，并把 `degraded` 标记带回给前端。

### 15. 只读账号在两张页面上点了没反应 【核对】

- 位置：`index/common/access.py:16-32`
- 问题：`READER_VIEWS` 漏了两个 GET 视图。
  - `dashboard_tasks`（`index/urls.py:74` 的 `tasks.json`）—— 首页任务栏翻页 403，`dashboard_index.mjs:42` 只在 `response.ok` 时替换数据，按钮点了毫无反应
  - `operations_ip_lookup` —— 拓扑页的「IP 查询」403，而它的同级 `operations_overview` / `_data` / `_node` 都在白名单里，明显是漏了；`operations-overview/app.js:193` 把状态码当提示文字，页面上只出现一个 "403"
- 建议：两个都加进 `READER_VIEWS`（都是纯 GET）。另外首页域名卡片的「手动同步域控」表单（`index/dashboard/views.py:157-160`）对只读账号无条件渲染，点下去必然 403，建议按 `can_administer` 隐藏。

### 16. 登录限流的两处设计缺陷 【核对】

- 位置：`index/common/login_throttle.py:65` 和 `:61`
- 问题一（安全）：`clear()` 把 `('user', username)` 和 `('ip', address)` 两把计数器一起清零，而成功登录只能证明这个**账号**没问题。攻击者只要有一个有效账号，猜几次就成功登录一次，把自己出口 IP 的 `fail-ip` 抹平，`NET_LOGIN_IP_MAX_FAILURES=20` 这道撞库防线形同不存在。
- 问题二（可用性）：第 61 行 `count >= limits[kind]`，「0 = 关闭」的语义只对 `NET_LOGIN_MAX_FAILURES` 成立（第 46 行早退），对 IP 上限不成立 —— `limits['ip']=0` 时 `count >= 0` 恒真。运维照抄「设 0 关掉」的写法后，任何账号第一次输错口令就锁死整个出口 IP 900 秒，共用 NAT 的办公室全员登不进来。
- 建议：`clear()` 只清 `'user'` 分支，IP 计数交给 `NET_LOGIN_WINDOW_SECONDS` 自然过期；`record_failure` 循环开头加 `if not limits[kind]: continue`，或在 `settings.py:398` 注释里把 0 的语义写死（两处保持一致）。

### 17. 任务栏的「获取成功」永远是 0 【核对】

- 位置：`net/inspections/task_summary.py:178`
- 问题：`fetch_success` 只在 `counts` 里初始化为 0，而 `_outcome_expression()`（第 8-21 行）的分支只有 `ignored` / `pending` / `cancelled` / `abnormal` / `normal`，`_summary_counts` 的 GROUP BY 不可能产出这个桶。
- 影响：`task_bar.mjs:78` 的 `v-if="row.fetch_success"` 永远不渲染，后端每个任务都返回一个恒为 0 的死字段。
- 建议：要么按 `result_snapshot` 的抓取成功标记补独立计数（**不要**并进 normal/abnormal，会和它们重叠、污染第 195 行的 `sum(counts.values())`），要么连模板一起删掉。

### 18. 告警列表切换排序方向相反 【核对】

- 位置：`static/app/vue/pages/alert_list.mjs:59-65`
- 问题：`sortBy()` 先把 `this.sortKey = column.key` 再调 `nextOrder(column)`，使 `nextOrder` 里的 `this.sortKey === column.key` 恒真。
- 影响：切换到新列时不是「从升序开始」，而是沿用上一列的方向取反。按发生时间升序时点「严重级别」，实际请求 `order=desc`，而 `sortLabel()` 同时宣称「按严重级别升序排列」，提示与行为相反。
- 建议：先算 `order` 再赋 `sortKey` —— `const order = this.nextOrder(column); this.sortKey = column.key; this.sortOrder = order;`。

### 20. 卡片按钮可能重复出现 【核对】

- 位置：`index/dashboard/views.py:97-98` 与 `:102-103`
- 问题：`detail_url` 判断写了两遍，第二个分支没有 `elif` 保护。第一个判 `detail_url and detail_label`，第二个只判 `detail_url`。
- 影响：目前所有卡片都没设 `detail_url`，所以还没暴露；一旦有人给某张卡加上，底部会出现两个文字和链接完全相同的按钮。
- 建议：删掉第 102-103 行重复分支。

---

## 观察：待确认或影响面小

### 21. 新建 AD 用户可能是停用状态 【待确认】

- 位置：`net/domain/client.py:152`
- 问题：`create_user` 的 `connection.add` 只提交 `cn` / `sAMAccountName` / `displayName`，没设 `userAccountControl`，随后只写 `unicodePwd` 就返回成功。
- 需验证：在测试域新增一个用户后同步，读回 `userAccountControl` 是否为 512；若为 514 / 546 即确认「新建账号默认停用」。
- 建议（确认后）：`add` 后紧接已有的 `self._modify_uac(connection, target_dn, 'enable', None)`，并把最终 UAC 写进 `DomainActionResult.details` 供审计。

### 22. 复职人员离职日期不会清空 【需产品口径】

- 位置：`net/people/directory/sync.py:295-298, 363`，配合 `_validate_record_shape`（`:327-337`）
- 现象：人员消失被停用（记离职日期）后重新出现，`is_active` 置回 True 但离职日期仍是旧值；明细会同时显示「在职 + 离职日期」。
- **为什么不能直接改**：我试着改成「无条件写日期」，`test_directory_sync_updates_dates_only_when_the_provider_supplies_them` 立刻失败。根因是 `_validate_record_shape` 第 332-337 行规定「日期键存在就必须是合法 ISO 日期」，空串会抛 `PeopleSyncApplyError`。也就是说「没值就不带这个键」是记录格式的硬契约，preview 和 apply 的指纹都建在它上面。
- 结论：要修必须同时改三处 —— 记录格式契约、`_record_date` 的空值语义、以及每个 adapter 对「没提供」和「明确清空」的区分能力。`DirectoryPerson.hire_date` 默认就是 `''`，目前**无法区分这两种情况**。
- 建议先定口径：是让 adapter 显式声明「这个日期我管」，还是接受「远端不提供就保留旧值」。定了再动，别只改一边。

### 23. 公开统计页与登录页口径不一致 【核对】

- 位置：`index/common/public_views.py:60`
- 问题：未登录版 `/people/statistics/` 的部门统计按原始 `department` 列分组，没做登录版那套 `None` / 空白 strip 合并与「未分配部门」归并。`department` 为 `NULL` 与 `''` 会拆成两行。
- 建议：`public_views._summary` 直接调 `assets.overview.department_totals()`。顺带一提，`assets/views.py:446-463` 是 `assets/overview.py:58-75` 的逐行复制，已经出现第三份口径，建议合并成一份。

### 25. 同步性能：全表重写 group_names 【核对】

- 位置：`net/domain/memberships.py:27`
- 问题：`refresh_group_names` 把全部账号/计算机 pk 拼成一个 IN 列表查 `DomainMembership`，再逐行 `bulk_update`，且在 `apply_domain_snapshot` 的同一个事务里。
- 影响：账号上千后每次同步都全表重写，事务时长与锁范围随对象数线性增长，列表页读被阻塞、worker 租约更易过期。这是「超过 1000 条」规模下最先撞到的瓶颈。
- 建议：只更新实际变化的行（先比对收集 dirty 列表），IN 列表按 500 分批。

### 26. 两处静默失败没有出口 【核对】

- 位置：`net/alerts/task_summaries.py:122`、`people/integrations.py:296`
- 问题一：任务总结生成失败只把异常类名写进 `TaskRun.alert_summary_error`，既不打日志也不上页面（对照 `service.py:499` 专门补了 warning + exc_info）。该字段全仓没有任何模板/payload 读取，只有测试引用。持续抛异常的任务永久不发通知，重试全静默。
- 问题二：`SyncPreview.from_dict(...)` 失败时 `except PeopleSyncError: pass`，`preview` 保持 `None`。任务状态是 success，弹窗既不显示差异明细也不显示「导入数据」按钮，用户以为「本次没有变化」。
- 建议：前者补 `logging.warning(..., exc_info=True)` 并把字段接到任务详情诊断块；后者写入 `people_operation_error` 并在模板加错误分支。

### 27. 死链路与写死的权限标志 【核对】

- `alerts/views.py:229`：维护面板 bootstrap 里 `can_administer` 写死 `True`，而该页对普通读者开放（`access.py:22`）。非管理员看到「删除」按钮，点了被 `IsAdminOrReadOnly` 拒绝，只弹一句「只有管理员可以执行这个操作」。建议改成 `is_admin(request.user)`。
- `people/payloads.py:113`：后端算好 `sync_label` 塞进 bootstrap，`people_workspace.mjs:17` 也声明了 prop，但整份模板从不使用。切到部门视图后没有任何同步入口。建议渲染出来或两处一起删。

### 28. 拓扑页若干绘制缺口 【核对】

- `topology/presentation.py:411-413`：`attach_endpoints` 里 parent 两次取不到就 `continue`，`parent_id` 保持 `None`；前端 `topology.js:198` 只画 `parentId` 非空的终端，`asset_truncation` 也不统计。IP 为空的 PC、以及 IP 不落在任何主干设备管理 IP 所在 /24 内的终端全部静默消失，顶部「另有 N 个设备未绘制」对不上。
- `topology/operations.py:69`：`current_topology_payload(include_stale=True, limit=1000)`，`read_model.py:28-30` 的 `links[:limit]` 静默截断，且 `required_network_ids` 只从这批链路取。链路破千时，被截掉链路的设备既不被保留也拿不到邻居关系，`site_components` 会判成孤立小场地，画出一排单机列。
- 建议：前者给无父节点的 endpoint 兜底挂到本场地 tier 最小的主干节点并标 `attachment_source='orphan'`（前端虚线区分），或单独计数并显示；后者把 limit 提到 5000，或在 payload 里回传 `links_truncated` 供前端提示。
- `static/app/js/operations-overview/app.js:264`：`movePan` 每个 `pointermove` 都整体替换 `this.viewport`，而 `<g :transform>` 绑的就是它，整棵 SVG 跟着重渲染；且 `pointermove` 同时绑在 SVG 和 window 上，一次拖动跑两遍。320 个节点时拖动明显掉帧。建议直接写 `<g>.setAttribute('transform')`，只在 `pointerup` 时同步回 `viewport`；删掉模板里的重复监听。

---

## 补：资产与采集（深度审查）

这一节来自单独一轮深读，按同样格式记录。编号与前文独立。

### A1. 有拓扑数据的设备在 admin 里删不掉 【核对】

- 位置：`net/admin/assets.py:152`
- 问题：`DeleteSelectedMixin` 只覆写了 `delete_queryset`，但 Django 内置的 `delete_selected` 在 `protected` 非空时**不会调用它**（`.venv/.../django/contrib/admin/actions.py`：`if request.POST.get("post") and not protected:` 才走 `delete_queryset`）。`delete_model` / `delete_view` 也没覆写。
- 影响：`NetworkTopologyInterface.device`、`TopologyDiscoveryBatch.device`、`NetworkTopologyObservation.local_device` 三个都是 `PROTECT`（`net/models/topology.py:49/86/161`），所以只要设备被拓扑发现过，单条删除和批量删除都返回「Cannot delete」。mixin 里那套「先删观测 → 链路 → 接口 → 批次」的顺序永远不执行，是死代码。删除后 `DeviceConfigurationBackup`（`net/models/configuration_backups.py:12`，裸 UUID）与 `MaintenanceWindow`（`net/models/alerts.py:785`）还会变成不可达孤儿。
- 建议：同时覆写 `get_deleted_objects`，把拓扑对象从 `protected` 摘出来计入 `deletable`；或在 `delete_model` / `delete_queryset` 共用的清理函数里统一处理，并在同一事务里清理或标记 `device_id` 对应的配置备份。

### A2. 接口表 / VLAN 表的「部分成功」标记被丢弃 【核对】

- 位置：`net/infrastructure/ssh_collectors.py:360`（只跳过 failed/missing）、`:392-395`（把 dict 原样包进 interfaces/vlans）、`:338`（completed 判定只看顶层 status）
- 问题：`execute_template_commands` 产出的 `{'status': 'partial'}` / `{'_empty_table': True}` 在这两个分支被包成 `{'interfaces': [{...}]}`，顶层不再有 status，`:338` 就识别不出来。
- 影响：给 `interface_status` / `vlan_status` 配了多条命令或 `empty_pattern` 时，一条命令失败仍判 success，页面上出现一条没有 name/oper_status 的假接口、或一个空 VLAN 表的假 VLAN 行，巡检结论把不完整当正常。`NETWORK_FUNCTION_ITEMS` 分支（`:365-374`）已经正确处理了，这两项漏了。
- 建议：`:360` 的过滤条件并入 `partial` 与 `_empty_table`，两个分支输出 `{'interfaces': []}` / `{'vlans': []}` 或带 status 的包裹，让 `:338` 能识别。

### A3. 端口总数 / VLAN 数量永远填不上 【核对】

- 位置：`net/devices/inventory.py:18`
- 问题：allowlist 里有 `port_count` / `vlan_count`，但采集结果里没有这两个键 —— SNMP 只产出 `{'interfaces': [...]}`（`snmp.py:380`）和 `{'vlans': [...]}`（`snmp.py:391`），全仓库没有把 `len()` 回填到资产行的代码。
- 影响：`index/common/table_registry.py:160-161` 那两列对自动采集的设备恒为空，只有 CSV 导入或 seed 数据才有值。`tests/devices/pc/test_inventory.py:331` 直接喂了这两个键，把断链掩盖了。
- 建议：在 `refresh_asset_inventory` 的 `Network_Device` 分支从 `interface_status['interfaces']`、`vlan_status['vlans']` 算长度写入；或从 allowlist 去掉这两个字段。

### A4. 生产路径的 SNMP 采集没有总超时 【核对】

- 位置：`net/devices/network/collector.py:173`
- 问题：`collect_network_snmp(device, timeout, selected_items=...)` 没传 `total_timeout`（只有 weakcurrent 的 SNMP 分支在 `net/devices/security/collector.py:132` 传了），只有每 PDU 的 `timeout=12s × retries=1` 生效，而接口采集要顺序 walk 15 张表（`snmp.py:768-770`）。
- 影响：对「回包但慢/丢包」的设备，单台能跑好几分钟，占死 4 线程的 worker 池（`net/inspections/worker.py:81`），其余目标排队，任务在 UI 上长时间「进行中」。巡检 profile 的 `timeout_seconds`（`executor.py:169-175`）在这条路径上不构成整体约束。
- 建议：调用处传 `total_timeout=max(5, timeout)`，与 security 分支保持一致。

### A5. 全表配置 ZIP 导出：N+1 且全量解密进内存 【核对】

- 位置：`net/data_exchange/configuration.py:72`
- 问题：`for asset in assets` 里逐个 `_latest_configuration`，每台设备 2 次查询并整份解密写入 `BytesIO`；`assets/configuration.py:78` 走 `apply_table_filters` 全表、不限制台数。
- 影响：500 台设备时一次导出约 1000 次查询，并把全部解密后的配置（单份上限 `MAX_CONFIG_BYTES`）同时留在内存和 ZIP 缓冲里，容易把 Web 进程打爆。`assets/backups.py:97-98` 逐行解引用 `backup.task_target` 属同类 N+1。
- 建议：`list_configuration_backups` 加 `select_related('task_target')`；ZIP 导出改流式输出并对 assets 加 `take(N)` 上限，超限提示分批。

### A6. CSV 以 IP 为主键时不做行锁 【核对】

- 位置：`net/data_exchange/inventory_csv.py:406`
- 问题：非 IP 主键走 `select_for_update().filter(key__in=...)`（`:399`），IP 分支却用 `model.objects.all().iterator(chunk_size=500)` 全表扫描，既不加锁也不走索引。
- 影响：两个并发导入含同一新 IP 时都判「新建」，第二个在 `save` 时触发唯一约束，被 `:569` 统一翻译成「数据库写入失败，请检查数据后重试」—— 用户看不出是重复 IP。设备表大时每次导入都要全表反序列化一遍。
- 建议：IP 分支也用 `select_for_update()` 精确匹配已存在的归一化 IP，并把 `IntegrityError` 单独翻译成「IP 已存在」。

### A7. 只读账号在网络/服务器/弱电页没有「导出所选」 【核对】

- 位置：`index/common/device_payload.py:177`
- 问题：`selectAttr` 只在 admin 时写入；而 `assets/views.py:275` 是无条件写入的，那里的注释还明确写着「每张表都能勾选……导出所选是通用能力」。
- 影响：同一套 Vue 表格组件（`asset_workspace.mjs:22/55`）没有 `selectAttr` 就不渲染勾选列，只读账号在这三个工作区无法反选/导出所选，和 PC、人员页的行为不一致。
- 建议：去掉 `if admin` 判断，与 `assets/views.py` 对齐（勾选后提交任务另有 `task_allow_target_selection` 控制）。

### A8. PC 日志页的筛选控件不跟随地址栏 【核对】

- 位置：`pc/payloads.py:129`
- 问题：`shownFilters` 只算 `bool(f.default_filter)`，漏了 `or f.key in state['filters']`；`assets/payloads.py:149` 与 `index/common/device_payload.py:76` 都带了这一项。
- 影响：带 `filter_*` 参数进入 PC 日志 tab 时，筛选实际生效但控件显示未勾选，用户以为没应用而重复操作。
- 建议：补成 `bool(f.default_filter) or f.key in state['filters']`。

### A9. 以 `gAAAA` 开头的明文口令不会被加密 【核对】

- 位置：`net/infrastructure/credentials.py:48`（`looks_encrypted` 在 `:42`）
- 问题：`encrypt` 命中 `looks_encrypted` 就原样返回，而 `looks_encrypted` 只按 Fernet 前缀 `gAAAA` 判定。注释写着「Used only by the data migration」，但实际是在 `encrypt` 里无条件调用的。
- 影响：任何以 `gAAAA` 开头的 SSH / SNMP / API 口令会以**明文**存库，之后 `from_db_value` 走到 `decrypt` 抛 `ValueError('stored credential could not be decrypted')`，该设备的详情、巡检、编辑全部报错，用户自己修不了，只能改库。
- 建议：只在明确的迁移/回写场景跳过加密；或让 `encrypt` 先校验这个值能否被当前 key 解密，解不开就当明文加密。

---

## 补：巡检链路（深度审查）

这一节来自单独一轮深读，编号 `R1`–`R9` 与前文独立。

先说结论：**状态机与并发框架本身是稳的**。我另外通读过 `net/inspections/queue.py`，`claim_next_task` / `renew_lease` / `recover_expired_tasks` 三件套齐全；`finish_task`（`:676`）在事务里三重校验（状态 RUNNING、`worker_id` 匹配、租约未过期）；`_recover_expired_locked`（`:423`）分支完整，连「任务没有目标」都会在重试到 `MAX_TASK_ATTEMPTS` 后判失败，不会死循环。

下面 8 条是这套框架之外的问题。

### R1. 记录页选历史任务，表格显示的却是最新那次的记录 【核对】

- 位置：`inspections/records.py:152-155`（配合 `_record_results.html:2-3`、`static/app/js/inspections/task_ui.js:248-259`）
- 问题：点任务栏里的历史任务时，前端把 `?task=<id>&fragment=results` 发回 `record_list`，但 `record_list_context` 只读了 `request.GET['target']`，`_infrastructure_records(kind, target=target)` 没传 `task=`，后端恒定取「最新任务」的记录。
- 影响：标题会变成「当前任务 · 任务创建于〈所选任务时间〉」，表格行却是更新那一次的结果 —— 用户看历史任务，读到的是别人的数据。`table_export_scoped` 同源，导出也一起错。
- 建议：把 `request.GET['task']` 解析成 `TaskRun`（找不到就退化到 latest），传 `task=selected` 给 `_infrastructure_records`，与 `inspections/task_results.py:21` 的用法对齐。

### R2. 任务栏翻页后点击无反应 【核对】

- 位置：`static/app/js/inspections/task_ui.js:276-278,297`、`inspections/templates/inspections/_record_body.html:28-29,43-44`
- 问题：行点击靠 `bindTaskTable` 在 `DOMContentLoaded` 绑一次，用 `dataset.taskTableBound` 防重；而任务栏翻页是 `replaceWith` 换整块新节点后只调 `mountBar`，Vue 根实例也只接了 `onPage` 没接 `onSelect`。
- 影响：翻页或页签片段重载后，行仍然是 `role=link`、手型光标（`task_bar.mjs:71-72`），但点了没反应，结果区不切换。analysis 记录页（`_record_body.html:55-57`）根本没有 `#task-results-region`，行从一开始就是死的。
- 建议：改成 document 级事件委托（判 `closest`），或在 `mountBar` 成功后重新 `bindTaskTable(host)` 并把防重标记落到新节点；同时给 TaskBar 传 `onSelect`。

### R3. 失败持久化自身出错时被静默吞掉 【核对】

- 位置：`net/inspections/worker.py:192-194`
- 问题：`except Exception: return None`，既不打日志也不改状态，target 停在 RUNNING。
- 影响：`_persist_collection` / `_collection_report` 内部出一次错（DB 异常、字段错误），这台设备就永远没有记录、没有 `error_message`。任务要等租约过期 3 次后才会被标成「任务租约过期且已达到最大重试次数」，真实原因完全查不到。同文件 `:161-168` 对非 DB 异常是有「必须记日志」约定的，这里破了例。
- 建议：补 `logger.exception`，并把 target 显式置 `FAILED`、记录原始异常类型，避免被误判成租约问题。

### R4. 租约过期后同一设备可能被两个会话同时采集 【核对】

- 位置：`net/inspections/executor.py:469-472` + `net/inspections/queue.py:452-457`
- 问题：租约过期恢复会把仍 RUNNING 的 target 直接改回 QUEUED 交给新 worker，而旧 worker 的采集线程无法中断，它结果的落库会被 `_persist_collection` 的租约检查回滚丢弃。
- 影响：同一台设备可能被两个采集会话同时连接（SSH/SNMP 打到同一 VTY），旧会话的结果整台丢失；租约抖动（DB 卡顿导致 `renew_lease` 失败）时表现为「随机某些设备没有记录」。
- 建议：`_begin_target` 增加独立的 `MAX_TARGET_ATTEMPTS` 上限；恢复时对重新置为 QUEUED 的 target 记一条「可能重复执行」的 warning；network_device 目标可以复用已存在但只有域控在用的 `execution_scope_key` + `net_target_active_execution_scope_uniq`（`net/models/tasks.py:968-975`）做设备级互斥。

### R5. 等不到并发配额被当成「采集失败」 【核对】

- 位置：`net/inspections/budget.py:63-67` + `net/inspections/worker.py:137-145`
- 问题：等命令行并发配额（默认 300s）超时抛 `BudgetTimeout`，worker 把它当「设备采集失败」落库（`persist_execution_failure`）。
- 影响：并发上限打满时，一批里排在后面的设备被写成 `status=failed`、计进异常率、而且不会自动重试 —— 实际上根本没连过设备。用户看到的是「采集失败」。
- 建议：`BudgetTimeout` 单独落一个「未执行 / 待重试」语义（或保持 QUEUED 并设退避 `available_at`），至少 `error_message` 要区分「未建立连接」；不要把排队等待计入报告故障口径。

### R6. 进度聚合是 O(N²) 【核对】

- 位置：`net/inspections/state.py:36-45`、`net/inspections/queue.py:643-644`
- 问题：每台设备落库都要 `target.full_clean()` + `save()` 再回查一次原始行（`net/models/tasks.py:1084-1088`），随后对「整任务所有 target」做一次 Count 聚合算进度；`_finish_locked` 又把全部 target 再 `full_clean` 一遍。
- 影响：N 台设备的任务在收尾阶段是 O(N²) 行扫描 + 约 5N 次校验查询，数千台时收尾明显变慢，同时拉长持有任务行锁的时间。
- 建议：进度改为在目标进终态时一次性聚合，或对 `completed_targets` 用 `F()` 原子自增、结束时校正一次；`save_target` 只写本行并用轻量校验。

### R7. 入队是逐条校验 + 逐条 save，没有上限 【核对】

- 位置：`net/inspections/queue.py:391-408`
- 问题：对每个 target 逐个 `_validate_target_before_enqueue`（`clean_fields` / `clean` / `validate_unique` / `validate_constraints`，每次多条 SQL）再逐个 `save`，全在一个事务里，没有批量通道，也没有目标数上限。
- 影响：「全部资产」在大网络上变成一次 Web 请求里几千次往返的长事务；请求超时但事务仍然提交，用户看到报错重试时又会撞 `:389-390` 的活动范围去重。
- 建议：`target_runs` 用 `bulk_create`，唯一性交给 `net_task_target_uniq` 约束；对单次入队的目标数或事务批大小设上限（比如每 500 台一批提交）。

### R8. 异常中心的「未处理」恒为 0 【核对】

- 位置：`inspections/tasks.py:604`（显示在 `inspections/templates/inspections/task_center.html:41`）
- 问题：`_error_metrics` 返回 `{'total': ..., 'pending': 0}`，直接写死。
- 影响：任务·异常页永远显示「未处理 0」，即使有大量未跟进异常。指标失去意义，还会让运维以为没有待办。
- 建议：按真实语义统计（比如未挂 `AlertEvent` / 未闭环的错误记录），或直接去掉这个数字 —— 别用常量占位。

### R9. `claim_next_task` 的真并发语义待确认 【待确认】

- 位置：`net/inspections/queue.py:486-505`
- 需验证：MariaDB/InnoDB 下两个 worker 进程同时执行 `select_for_update().filter(status=queued,...).order_by(...).first()` 时，后到者是阻塞在旧行锁上、释放后继续扫描到下一行，还是直接返回 `None`。现有唯一的「不重复领取」测试（`tests/inspections/test_queue.py:822`）是串行两次调用，没有真并发，也没有用 `SKIP LOCKED`。
- 若语义不成立：队列里明明还有任务，worker 却领不到，表现为空闲轮询。验证方法是在 MariaDB 上起两个进程同时 claim，或显式加 `skip_locked=True`（MariaDB 10.6+ 支持）。

另外记一笔存量死代码：`task_ui.js:263-267` 构造了 `clean` URL 却从未使用（选中任务不写地址栏）。

---

## 补：深查（四路只读审查）

把原来「还没深究」的四块派出去逐行读完，结论如下。**每条都自己复核过**，
子代理报的误报已经剔掉。

### 已修

- **钉钉/飞书限流被当成永久失败**（`net/alerts/dingtalk.py:57`、`feishu.py:64`）
  两个适配器对 `errcode != 0` / `code != 0` 一律 `retryable=False`。但机器人平台
  把限流放在 **HTTP 200 的响应体**里（文字是「send too fast」），于是在 5 次上限
  内一次都不重试，突发时直接丢告警。改成按响应体里的限流措辞判定（`base.py`
  的 `looks_rate_limited`），**不硬编码错误码** —— 官方文档是 JS 渲染，我拿不到
  权威的 130101 数值，硬写等于猜。
- **一行坏数据让整条投递队列停摆**（`net/alerts/service.py:438`）
  `AlertDelivery.objects...get(pk=...)` 在 try 外面，channel.settings 解密失败或
  事件序列化异常会逃出 for 循环，本批剩余行不处理；claim 按 created_at 排序，
  坏行每轮都在队头。已把 get 和渲染一起移进 try，单行失败只记 warning。
- **服务器「SSH 端口」留空必然保存失败**（`assets/forms.py:88-91`）
  `Server.port` 是 NOT NULL（`default=22` 只在没显式赋值时生效），而表单一律
  放开必填。Django 会把「表单非必填、模型必填」的空值排除出模型校验，None 一路
  落到 INSERT，最后被 IntegrityError 翻译成「请检查 IP 是否已存在」。改成按模型
  列是否允许 NULL 决定必填性，IntegrityError 的提示也按约束名分开。
- **删除维护窗口的 next 是开放重定向**（`assets/maintenance.py`）
  已用 `url_has_allowed_host_and_scheme` 校验。
- **「能力不支持」被当成「采集不完整」降级**（`net/inspections/executor.py:250`）
  `config_info` 的 `status='unsupported'` 会把 success 降成 partial。弱电设备、
  sangfor、未注册厂商**必然**返回 unsupported，于是每天第一次巡检必然 partial。
  已让 unsupported 不参与状态降级；`device_issues` 那条「不支持完整配置备份」的
  finding **保留** —— 那是能力事实，用户该看到，只是不该算成失败。
- **不可达却记 success**（`security/collector.py:109`、`sangfor.py:138`、
  `network/collector.py:124`）空请求时 `reachable=False` 与 `status='success'`
  同时成立。三处都改成空请求返 failed 并给明确消息，network 分支再加
  「success 必须 reachable」的守卫。
- **空 `selected_items` 能建出任务**（`net/inspections/queue.py:311`）
  过去服务器会正常连一次 SSH、循环为空、记 success。入队处直接拒绝。
- **Linux 命令级错误落库时丢失**（`executor.py:272`）
  原因写在 `raw['command_errors']`，但 `_selected_details` 只认
  `collection_errors`。已两个键名合并，exit code 和 stderr 进得了 details。
- **拓扑批次创建在采集 try 之外**（`executor.py:521`）
  `begin_topology_batch` 抛错会冒泡到 worker，把一次没跑的采集记成 FAILED。
  已移进 try；`payload is None` 那条路径也补上 `_append_topology_error`，
  和 except 分支口径一致。
- **维护窗口三块之和 ≠ 总数**（`assets/maintenance.py:window_metrics`）
  停用且未结束的窗口既不算进行中、也不算待生效、也不算已结束。已加 `disabled` 桶。
- **批量建窗口缺事务与校验**（`assets/maintenance.py:create_windows`）
  REST 侧完全不校验 `target_ids` 存在性，可写孤儿窗口；同一资产同一时段可重复
  登记。已把存在性校验 + 区间去重下沉到共用的 `create_windows`，用
  `transaction.atomic` 包住。
- **停用/启用接口非法 pk 打 500**（`assets/views.py:308`）
  `get_object_or_404` 对非 UUID 抛的是 `ValidationError` 不是 `DoesNotExist`。
  已先做 UUID 解析，失败返回 404。
- **配置备份历史/对比/下载三个页没有任何入口**（`assets/payloads.py`）
  视图功能完整但全仓零反链，用户只能手打 URL。已在网络设备与弱电的行操作里加
  「配置备份」。
- **对比页能选「更新的版本」，旧/新标签和 +/- 全反转**（`assets/backups.py:308`）
  候选只排除 current。已收窄为 `versions[position+1:]`；手工构造
  `?against=<更新版本>` 会明确 404，而不是静默按新当旧。
- **ZIP 超 500 台时提示误导**（`assets/configuration.py:46`）
  超限与「没选」原来都回「请选择有效的设备」。已分开，超限会报实际台数。
- **manifest 第五列一词两义**（`net/data_exchange/configuration.py:69`）
  成功行写 scope（running-config），失败行写错误文案。已拆成 `scope` + `notice`。
- **diff 截断从第一行切**（`net/devices/configuration_diff.py:59`）
  差异集中在很靠后时，用户看到「新增 3 行」却在表里找不到。已改成优先保留变更行。

### 复核后撤回的子代理结论

- **「维护页 can_administer 写死」**：`maintenance_list` 上有 `@admin_required`
  （`index/common/access.py:54`，非管理员直接 403），`True` 是对的。
- **「记录表行没有 id，勾选导出空文件」**：实测 `/records/networks/` 上 114 个勾选框
  全部带真实 UUID。
- **「弱电 SNMP 原始证据被白名单滤掉」**：`selected_fields` 用
  `aliases.get(item, (item,))` 兜底，不在 `SECURITY_FIELDS` 里的 `cpu/memory/temperature`
  仍按同名键保留。
- **「失败计数两套口径」**：`failed_targets` 有模型级约束链
  （`models/tasks.py:823-854`：成功+失败必须等于总数、失败任务的全部目标都必须失败），
  取消路径已被 `_cancel_task_once` 覆盖，`inspections/test_queue.py:389` 也断言为 0。
  当前没有暴露面，不建议为「统一」动这套约束。

### 还没做（需要产品口径）

- **维护窗口对现存告警永不生效**（`service.py:353/362`）
  claim 只处理 `event_type='summary'`，而 summary 事件的 `target_type` 被约束
  硬编码成 `'task'`；`MaintenanceWindow.TargetType` 只有 network_device/server/
  monitor —— 两个集合**永不相交**，这段静默逻辑是死分支，每轮还白查一次。
  要么给 summary 事件带上真实资产维度，要么删掉这段。**需要先定：维护窗口到底
  该不该抑制「任务级汇总告警」？**
- **配置备份是裸 UUID 无回收路径**（`net/models/configuration_backups.py:12`）
  删设备后这些密文行永久留着（每设备最多 10 份）。**没做**：清理是破坏性操作，
  清错就永久删掉用户的配置备份且没有回收站。建议加管理命令人工跑，而不是挂在
  删除钩子上。
- **`asset_edit` 没有乐观锁**（`assets/create.py:64`）
  两人同时改同一台设备时后保存者整体覆盖，还会把巡检刚刷新的 `os_version` 改回
  旧值。`collection_profiles.py` 已有 `version` 比对范式可抄，但要动前端。
- **停用/启用是 toggle 不幂等**（`assets/views.py:309`）
  重放该请求会来回翻转状态，而停用会直接把设备踢出巡检。改成显式传目标值要同步
  改前端调用点。
- **人员统计两处各写一份**（`assets/views.py:404-474` 与 `assets/overview.py:12-53`）
  司龄/在职率/部门汇总逻辑重复。当前数值一致，属重复实现风险。

## 已排除：看着像问题，实际不是

避免下次重复排查，这几处我核过确认没问题：

- **权限体系**：`AccessMiddleware` 默认拒绝（`access.py:87-88`），非 admin 的写请求一律 403；19 个裸 `@require_POST` 视图由中间件统一兜底，不是遗漏。DRF 侧全局 `DEFAULT_PERMISSION_CLASSES = IsReader`（`settings.py:141-143`），13 个没显式声明的 ViewSet 继承链最终都落在 `IsAdminOrReadOnly`，且可写的只有 `MaintenanceWindowViewSet` 和 `IpSubnetViewSet` 两个。
- **`/api/` 前缀跳过中间件**：安全，DRF 没有 `AllowAny`，`TableRowsViewSet` 全族只有 GET action。
- **数据库级联**：31 处 `PROTECT`、15 处 `CASCADE`、11 处 `SET_NULL`，分布合理，防误删做得到位。
- **内部链接**：13 个页面共 147 个内部链接，0 坏链、0 JS 异常。
- **导入模块**：大小/行数/列数/单元格上限齐全，空值分支处理正确（`_integer` 遇空值会被跳过，`_date` / `_non_negative_integer` / `_gib` 返回 `None` 以便清空字段）。
- **巡检队列**：`select_for_update` + lease 续期 + 过期回收 + `attempt_count`，并发控制扎实。
- **告警处理主逻辑**：`process_target_findings` 行锁、`observed_at <= last_seen_at` 跳过陈旧数据、`get_or_create` 幂等、事务边界正确。
- **`profile_snapshot`**：`JSONField(default=dict, validators=[validate_json_object])`，不会是 `None`。
- **域分组成员数与成员管理窗口数量不同**：`docs/operations.md:42` 明确保留的 AD `member` 直接成员口径，不是缺陷。
- **`net/domain/memberships.py` 的 DN 匹配**：原先记成 `iendswith` 字符串后缀匹配，实际代码走的是 `dn_key()` 规范化后等值比较（`:43/46/48`）。这条**撤回**。
- **`net/domain/executor.py:195` 的 `if removed:`**：原先记成「元组恒为真」，实际代码是 `removed, _ = ....delete()`，已经解包成 int。实测删 0 行时 `removed=0`、判断为假，逻辑正确。这条**撤回**。

---

## 还没深究的部分

这份清单**不等于「没有别的问题」**。以下没走完：

1. **巡检链路**：已有单独一轮深读，结论见「补：巡检链路」R1–R9；其中 R9（`claim_next_task` 真并发语义）需要在 MariaDB 上实测才能定论。
2. **资产采集**：已有单独一轮深读，结论见上文「补：资产与采集」9 条；但不同厂商的 SNMP OID 差异、SSH 命令模板的实际执行差异没逐个核对。
3. **资产页面层**（`assets/` 的增删改表单、批量操作、配置备份/对比 UI）只做了结构性扫描，没逐条走每个业务分支。
4. **告警通道适配器**只看了邮件通道的耗时，钉钉/飞书/Webhook 的失败语义、重试与限流没逐一核对。
5. **前端组件层**（`static/app/vue/components/`）只看了被引用到的部分，没系统过一遍。
6. **没有做端到端的功能回归**：所有结论来自读代码和探针，没有真的点一遍每个页面的每个交互。上一轮做的是「13 个页面加载无报错」，那只能证明页面能打开，证明不了按钮都对。

要补这些，建议按模块单独开一轮，每个模块配一个可执行的功能清单逐项过。

---

## 实测记录

复现脚本都在 `runtime/probe/` 下，可以直接重跑（需要 `DB_NAME=net-test`）：

| 脚本 | 验证的条目 | 关键输出 |
| --- | --- | --- |
| `probe_patch_settings.py` | 第 2 条 | 完整保存后只提交 `{chat_model, reasoning_effort}`，其余字段全变空串 / `None` |
| `probe_provider_switch.py` | 第 3 条 | 激活 B 后 `AiProvider.active()` 是 B，但 `ai_config()['BASE_URL']` 仍是 A |
| `probe_chunks.py` | 第 7 条 | 切 6 块，第一段出现 2 次 |
| `probe_parse_table.py` | 第 12 条 | 多行字段导入后变成 `第一步：登录取日志第二步：看端口` |
| `probe_kb_delete.py` | 第 6 条 | `filter(pk='')` 抛 `ValidationError: "＂不是一个有效的UUID"` |
| `link_audit.mjs` | 已排除项 | 147 个链接 0 坏链、0 JS 异常 |

第 1 条（摘要元组）靠读代码确认：`client.py:85` 返回二元组，`views.py:186` 做 `str + tuple` 必然 `TypeError`，而那里的 `except` 不捕它。
