# 任务：把 PC 资产管理页重写为单文件 Vue 页面

## 一句话目标

把现在的「Django 模板渲染 + Vue 局部增强」混合结构，改成**一个 Vue 单页组件驱动的完整页面**：外观、交互、功能与现在**完全一致**，一处都不许改。新模板文件名就叫 `pc`，即 `pc/templates/pc/pc.html`。

## 硬约束（违反任何一条都算没做完）

1. **外观零变化**。不接受「顺手优化一下」。方块尺寸、字号、颜色、间距、按钮顺序、表格列、空态文案，全部照现在复制。
2. **功能零变化**。现在能做的每件事，改完必须还能做，且行为一模一样。
3. **不许新增依赖，不许引入构建步骤**。项目是 vendored Vue 3 ESM，直接 `import` 浏览器版，没有 npm、没有 bundler、没有 SFC 编译器。组件只能是 `.mjs` 里导出带 `template` 字符串的对象。
4. **不许动后端语义**。可以把上下文换个方式序列化，但查询逻辑、统计口径、字段格式化一律沿用现有函数。
5. **做完要能跑测试**。至少 `python manage.py test tests.frontend tests.system tests.inspections --noinput` 全绿。

## 必须先读的文件（按这个顺序）

后端：
- `assets/views.py` —— `_asset_list_context()` 是整个页面的数据源，第 189-264 行是 PC 分支
- `inspections/records.py` —— `computer_workspace_payloads()`（第 634 行）、`computer_logs_payload()`（第 560 行）、`computer_analysis_context()`（第 221 行）
- `inspections/analysis_summary.py` —— `latest_analysis_statistics()`（第 70 行）算统计
- `index/common/table_payload.py` —— bootstrap JSON 的形状在这里
- `index/common/table_registry.py` —— `computers` / `computer_logs` 的列定义
- `index/common/table_query.py` —— `apply_table_filters` 的 `prefix` 参数怎么工作

模板（要照抄的视觉基准）：
- `assets/templates/devices/list.html` —— 页面骨架、`page-heading`
- `pc/templates/pc/tabs.html` —— **三个大方块**，逐行照抄
- `index/templates/common/workspace_actions.html` —— 头部按钮
- `index/templates/common/table_workspace.html` —— 筛选栏、更多筛选、自定义表格、结果条
- `inspections/templates/inspections/taskbar.html` —— 巡检任务栏
- `inspections/templates/inspections/latest_analysis_statistics.html` —— 最新任务统计 + 问题类型分布
- `pc/templates/pc/log_pane.html` —— 日志面板

前端（现有实现，要整合进来）：
- `static/app/vue/boot.mjs` —— 挂载协议，`[data-vue-page]` + `[data-vue-bootstrap]`
- `static/app/vue/api.mjs` —— `api.get`，注意 `buildUrl` 会自动丢掉空值参数
- `static/app/vue/pages/asset_workspace.mjs` —— 资产表当前实现，262 行，逻辑基本可复用
- `static/app/vue/pages/resource_table.mjs` —— 日志表现在用的表格组件
- `static/app/vue/pages/resource_detail.mjs` —— 详情弹窗组件，props 是 `eyebrow/title/description/actions/sections/notice/disclosure/csrf`
- `static/app/js/common/table_workspace.js` —— 列显示开关、每页条数、筛选记忆的现有逻辑

## 页面结构（三块，自上而下）

### 1. `page-heading`

```
资产管理                      （.page-heading__eyebrow）
PC                           （.page-heading__title）
PC 资料由终端采集器通过 API 上报日志后自动建立，无需导入设备清单。  （.page-heading__description）
```

右侧按钮栏（顺序固定，全部来自 `workspace_action_context` + `task_modal_context`）：

| 按钮 | 类 | 行为 |
|---|---|---|
| 问题等级设置 | `btn-outline-primary` | 打开 `#issueSeverityModal`（`data-modal-load`） |
| 分析配置 | `btn-outline-primary` | 打开 `#profileConfigModal` |
| 告警配置 | `btn-outline-primary` | 打开 `#alertPolicyModal` |
| 下载 Windows 采集包 | `btn-primary` | 直接下载 |
| 下载 macOS 采集脚本 | `btn-primary` | 直接下载 |
| 手动执行分析 | `btn-primary` | 打开 `#runTaskModal` |

标题文案来自 `data_source_note`，值为 `PC 资料由终端采集器通过 API 上报日志后自动建立，无需导入设备清单。`

### 2. 三个大方块（tab 切换器）

结构照抄 `pc/templates/pc/tabs.html`，三个 `col-12 col-md-4`，每个是：

```html
<a class="card surface-card metric-card h-100 w-100 text-start text-body border-0 text-decoration-none"
   role="tab" aria-selected="true|false">
  <div class="card-body d-flex flex-column flex-grow-1" style="width:100%">
    <div class="metric-card__status-row mb-3" style="display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;width:100%">
      <h2 class="h5 mb-0">标题</h2>
      <span class="metric-card__ready"><span class="status-dot status-dot--ok"></span>角标</span>
    </div>
    <div class="metric">数字<span class="metric__unit">台</span></div>
    <div class="metric-card__detail mt-2">…</div>
    <div class="metric-card__detail mt-1">…</div>
    <div class="metric-card__entry mt-auto pt-3" style="text-align:right;width:100%"><span class="metric-card__current">当前 · </span>查看 xxx</div>
    <div class="metric-card__latest" style="text-align:right;width:100%">最新… 时间</div>
  </div>
</a>
```

三张卡的字段：

**PC 资产**（角标「台账」）
- 大数字：`overview.total`，单位「台」
- 第一行：`活跃 <span class="text-success">N</span> 台 · 停用 <span class="text-danger">N</span> 台`（停用为 0 时不加 `text-danger`）
- 第二行：`活跃率 N%`（`overview.active_rate`）
- 入口：`当前 · 查看 PC 资产`
- 底部：`最新上报 YYYY-MM-DD HH:MM`，无值显示 `暂无`

**日志**（角标「采集」）
- 大数字：`pc_logs_computers`，单位「台」
- 第一行：`采集 <span class="text-success">N</span> 台 · 未采集数据人员 <span class="text-danger">N</span> 个`
- 第二行：`异常率 N%`，值是 `widthratio(pc_errors_total, pc_logs_computers, 100)`，分母为 0 时显示 0
- 入口：`当前 · 查看日志`
- 底部：`最新采集 YYYY-MM-DD HH:MM`

**分析记录**（角标「快照」）
- 大数字：`pc_analyses_computers`，单位「台」
- 第一行：`任务 <span class="text-success">N</span> 个 · 完成 <span class="text-success">N</span> 个`（`task_metrics.task_count` / `task_metrics.completed_count`）
- 第二行：`正常 <span class="text-success">N</span> 台 · 异常 <span class="text-danger">N</span> 台`
- 第三行：`整体异常率 N%`（`task_metrics.abnormal_rate`，一位小数）
- 入口：`当前 · 查看分析记录`
- 底部：`最新分析 YYYY-MM-DD HH:MM`（`task_metrics.latest_task_at`）

**选中态**（这段行为已经在 `static/app/css/operations.css` 第 1565-1573 行，别重写 CSS，只要正确设 `aria-selected`）：
- 选中：正常显示，`.metric-card__current` 可见
- 未选中：`opacity: .58`，`.metric-card__current` 隐藏
- 悬停未选中：`opacity: .82`

### 3. 三个面板

#### 面板 A：PC 资产

结构：

```
.table-toolbar
  └ form.table-query-form
      筛选栏（.table-filter-bar）
        ├ 状态 select（无 status_options 时不渲染）
        ├ 默认筛选项：PC 名称 / IP 地址 / 操作系统（三个文本框）
        └ .table-filter-actions：筛选 | 重置查询 | 导出筛选结果
      details.table-more-filters（更多筛选）
        └ 其余 filterable 字段：当前用户、最后上报时间、MAC 地址、系统版本、系统构建号、系统安装时间、制造商、型号、序列号、系统架构、CPU 型号、CPU 物理核心数、CPU 逻辑处理器数、内存总量、磁盘总量
      details.table-config（自定义表格）
        ├ 显示列：18 个复选框，默认勾选 default_visible 的 5 个
        ├ 显示筛选项：所有 filterable 字段的复选框
        └ 恢复默认表格
      .table-result-bar：共 N 条，当前显示第 a–b 条 | 每页条数 20/50/100/200
```

列定义（18 列，来自 `table_registry` 的 `computers`）：

| key | 标签 | kind | 可排序 | 可筛选 | 默认筛选 | 默认可见 |
|---|---|---|---|---|---|---|
| computer_name | PC 名称 | text | ✓ | ✓ | ✓ | ✓ |
| ip_addresses | IP 地址 | text | ✓ | ✓ | ✓ | ✓ |
| os | 操作系统 | text | ✓ | ✓ | ✓ | ✓ |
| user_name | 当前用户 | text | ✓ | ✓ | | ✓ |
| last_report_at | 最后上报时间 | datetime | ✓ | ✓ | | ✓ |
| mac_addresses | MAC 地址 | text | ✓ | ✓ | | |
| os_version | 系统版本 | text | ✓ | ✓ | | |
| os_build | 系统构建号 | text | ✓ | ✓ | | |
| system_installed_at | 系统安装时间 | text | ✓ | ✓ | | |
| manufacturer | 制造商 | text | ✓ | ✓ | | |
| model | 型号 | text | ✓ | ✓ | | |
| serial_number | 序列号 | text | ✓ | ✓ | | |
| architecture | 系统架构 | text | ✓ | ✓ | | |
| cpu_model | CPU 型号 | text | ✓ | ✓ | | |
| cpu_physical_core_count | CPU 物理核心数 | number | ✓ | ✓ | | |
| cpu_logical_processor_count | CPU 逻辑处理器数 | number | ✓ | ✓ | | |
| memory_total_gb | 内存总量 | number | ✓ | ✓ | | |
| disk_total_gb | 磁盘总量 | number | ✓ | ✓ | | |

表格：
- `.table.data-table.table-hover.align-middle.mb-0`
- 表头可排序列用 `<a class="table-sort-link" href="#">`，带 `:data-sort-key`，点击循环 asc/desc
- 表体每行 `:style="cursor:pointer"`，**点行任意非控件区域都打开详情**（`event.target.closest('a, button, input, form')` 时跳过）
- 操作列固定最后一个，按钮 `查看详情`（`btn btn-sm btn-outline-dark`）
- 空态：`暂无 PC 数据` / `请运行 PowerShell PC 信息采集脚本并上报。`

#### 面板 B：日志

结构：`.table-toolbar` + `.card.surface-card.table-scroll-shell` + 表格。

列定义（6 列，`computer_logs`）：

| key | 标签 | kind | 默认筛选 | 默认可见 |
|---|---|---|---|---|
| computer_name | PC 名称 | text | ✓ | ✓ |
| person_name | 人员名称 | text | ✓ | ✓ |
| platform | 平台 | choice | | ✓ |
| collected_at | 采集时间 | datetime | | ✓ |
| content_hash | 内容哈希 | text | | ✓ |
| error_summary | 异常摘要 | text | | ✓ |

- 查询参数前缀是 `logs_`：`logs_page`、`logs_page_size`、`logs_filter_xxx`、`logs_sort`、`logs_order`
- 操作列只有一个 `查看详情`，点了弹窗显示这条日志的原始内容

#### 面板 C：分析记录

自上而下两块：

**巡检任务栏**（照抄 `taskbar.html`）

- `.card.surface-card.inspection-taskbar.execution-workspace`
- 头部：`page-heading__eyebrow` 写「执行中心」，`h2` 写「巡检任务栏」，右侧 `.execution-workspace__summary`：`当前任务 <strong>N</strong>`
- 表格 12 列：类型 | 配置 | 来源 | 创建时间 | 完成时间 | 目标 | 正常结果 | 异常 | 待处理 | 已取消 | 状态 | 操作
- 「异常」不为 0 时数字加 `text-danger fw-semibold`
- 状态徽章：success→`text-bg-success`、failed→`text-bg-danger`、partial→`text-bg-warning`、其它→`text-bg-secondary`
- 行可点击（`role="link"` `tabindex="0"` `data-task-id`），点了把该任务的统计加载到下面那块，不跳页
- 操作列按钮：`查看详情`，`data-detail-modal` 指向 `/tasks/<uuid>/`，弹窗打开
- 空态：`暂无巡检任务` / `从资产或日志页面发起巡检、扫描或分析后，任务进度会显示在这里。`
- 分页：每页 7 条

**最新任务统计**（照抄 `latest_analysis_statistics.html`）

- 头部：`page-heading__eyebrow` 写「最新结果」，`h2` 写「最新任务统计」，右侧显示任务创建时间 + 状态徽章
- 六个小方块（`col-6 col-xl-2`，`.card.surface-card`，内含 `.metric-label` + `.h3.mb-0`）：
  - 分析总数（默认色）
  - 正常（`text-success`）
  - 提示（`text-info`）
  - 警告（`text-warning`）
  - 严重（`text-danger`）
  - 执行失败目标（`text-danger`）
- 问题类型分布卡片：
  - `h3.h6`「问题类型分布」
  - 说明文字：`等级按已生成分析记录的最高问题等级统计。执行失败目标单独计数，不与等级数量相加。类型数量为受影响记录数，同一记录可包含多种类型，占比合计可能超过 100%。人员匹配产生的"未匹配日志"占位行不计入分析总数。`
  - 每个类型一行（`col-12 col-md-6`）：
    - `<button class="btn btn-link text-start text-decoration-none w-100 p-0 d-flex justify-content-between gap-2 mb-1">` 左边类型名，右边 `N 条 · X.X% ›`
    - 下面一条 `.progress`，内层 `.progress-bar` 宽度等于百分比
    - 点击打开 `#analysisProblemsModal`，请求 `/computers/analyses/tasks/<task_id>/problems/?category=<类型>`
  - 无数据时：`最新任务尚无分析结果。可进入任务详情查看待处理、运行中或执行失败的目标。`
- 无任务时：`暂无日志分析任务，执行分析后将在这里展示最新任务统计。`

## 数据契约

### 首屏 bootstrap（`json_script`）

一个 JSON，包含三块面板的全部首屏数据。建议形状：

```json
{
  "tabs": {
    "assets":  {"total": 914, "active": 913, "inactive": 0, "active_rate": 99.9, "latest": "2026-11-19T12:12:00Z"},
    "logs":    {"computers": 83, "missing_people": 786, "error_rate": 152, "latest": "2026-11-20T20:33:00Z"},
    "analyses":{"computers": 82, "task_count": 35, "completed_count": 28210, "normal_count": 0, "abnormal_count": 28210, "abnormal_rate": 100.0, "latest": "2026-11-20T20:35:00Z"}
  },
  "assets": { "columns": [...], "rows": [...], "count": 914, "page": 1, "pages": 46, "page_size": 20, "start_index": 1, "end_index": 20 },
  "logs":   { "columns": [...], "rows": [...], "count": 165, "page": 1, "pages": 9,  "page_size": 20, "start_index": 1, "end_index": 20 },
  "analyses": {
    "task": {"id": "...", "created_at": "...", "status": "success", "status_label": "成功", "status_class": "text-bg-success"},
    "stats": {"total": 160, "levels": {"normal": 20, "info": 34, "warning": 62, "critical": 44}, "execution_failed": 0,
              "categories": [{"label": "硬件", "count": 35, "percentage": 21.9}]},
    "tasks": {"rows": [...], "count": 35, "page": 1, "pages": 5}
  },
  "urls": {"asset_rows": "/api/v1/asset-rows/computers/", "log_rows": "/api/v1/computer-logs/",
           "detail_base": "/assets/computers/", "problem_base": "/computers/analyses/tasks/"},
  "csrf": "..."
}
```

行对象形状（`table_payload` 现成产物，直接用）：

```json
{
  "id": "833e3634-...",
  "cells": {"computer_name": {"text": "H024243"}, "os": {"text": "...", "badge": {"label": "...", "tone": "success", "class": "text-bg-success"}}},
  "actions": [{"kind": "link|form|modal", "label": "查看详情", "url": "...", "variant": "primary", "danger": false, "detail_modal": true, "modal_target": "..."}]
}
```

列对象形状：

```json
{"key": "computer_name", "label": "PC 名称", "kind": "text", "default_visible": true, "sortable": true, "filterable": true, "default_filter": true}
```

### 翻页接口

| 用途 | 路径 | 参数 |
|---|---|---|
| 资产行 | `GET /api/v1/asset-rows/computers/` | `page` `page_size` `sort` `order` `filter_<key>` |
| 日志行 | `GET /api/v1/computer-logs/` | `page` `page_size` `sort` `order` `filter_<key>` |

响应（实测）：

```json
{"count": 914, "page": 1, "pages": 46, "page_size": 20, "start_index": 1, "end_index": 20, "results": [ {...同上} ]}
```

**注意**：API 响应里**没有** `columns`，列定义只在首屏 bootstrap 里。组件要沿用首屏的 columns，不要指望翻页时再拿到。

`page` 超出范围时后端会夹到最后一页（`?page=99` 返回 `page: 46`），前端要以响应里的 `page` 为准。

### 详情接口

`GET /assets/computers/<uuid:pk>/detail.json` 返回：

```json
{
  "title": "PC详情", "eyebrow": "基础信息", "description": "H024243",
  "actions": [{"kind": "link", "label": "查看日志分析记录", "url": "...", "variant": "primary"},
              {"kind": "link", "label": "手动执行分析", "url": "...", "variant": "primary"},
              {"kind": "link", "label": "返回列表", "url": "/assets/computers/", "variant": ""}],
  "sections": [{"heading": "基础资料", "kind": "fields", "fields": [{"label": "PC 名称", "value": "H024243"}]}],
  "disclosure": null, "csrf": "", "notice": ""
}
```

直接喂给现成的 `resource_detail.mjs` 组件（`v-bind="detail"`）。

### 问题明细接口

`GET /computers/analyses/tasks/<task_id>/problems/?category=<类型>&page=<n>` 返回 HTML 片段，塞进弹窗的 `[data-problem-body]`。分页按钮带 `data-problem-page`。参考 `static/app/js/inspections/analysis_problems.js`。

## 交互规则（用户反复踩过的点，逐条照做）

1. **切换方块只在页内换内容，绝不改 URL**。不要写 `?object=analyses`。
2. **翻页、排序、改每页条数也不许把空参数写进 URL**。只写用户真正设过的值：`page`（大于 1 时才写）、`page_size`（不等于 20 时才写）、`sort`、`order`、非空的 `filter_*`。
3. **打开详情只弹窗，不刷新、不改 URL**。不要写 `selected=` 之类的参数。
4. **详情弹窗先出来再加载数据**。点击瞬间显示弹窗和「正在加载详情…」，数据回来再填内容。不要点了没反应。
5. **弹窗全部居中**：`modal-dialog modal-dialog-centered <尺寸> modal-dialog-scrollable modal-shell`。
6. **分页统一成单行**：`上一页 · 第 [输入框] / N 页 · 下一页`。输入框可手输页码，回车或失焦跳转。**不显示「共 N 条（a–b）」**——那条在工具栏的结果条里已经有了。
7. **翻页时不要整页滚动**。填完内容要么保持滚动位置，要么自然回到列表顶部，不能跳到莫名其妙的地方。
8. **Vue 模板里不许出现带点的事件名**（如 `@hidden.bs.modal`），会被当修饰符解析报错。用 `addEventListener` 在 `mounted` 里绑。
9. **`delimiters: ['[[', ']]']`**，模板插值用双方括号，别和 Django 的 `{{ }}` 打架。
10. **详情正文如果本身是 Vue 渲染的**，塞进弹窗后要重新挂载，并且 `readBootstrap(id, scope)` 传范围，避免和主页面同名 id 撞车。

## 现有 CSS 类名白名单（直接用，不要另造）

`.page-heading` `.page-heading__eyebrow` `.page-heading__title` `.page-heading__description` `.page-heading__actions`
`.metric-card` `.metric-card__status-row` `.metric-card__ready` `.metric-card__detail` `.metric-card__entry` `.metric-card__current` `.metric-card__latest` `.metric` `.metric__unit` `.metric-label`
`.surface-card` `.table-toolbar` `.table-query-form` `.table-filter-bar` `.table-filter-field` `.table-filter-actions` `.table-more-filters` `.table-more-filters__grid` `.table-config` `.table-config__grid` `.table-config__reset` `.table-result-bar` `.table-result-bar__page-size`
`.table-scroll-shell` `.table-scroll-hint` `.data-table` `.table-sort-link` `.table-actions-column` `.table-actions-cell` `.table-row-actions` `.table-selection-column` `.status-badge` `.empty-state`
`.page-pagination` `.page-pagination__actions` `.page-pagination__page` `.page-pagination__input` `.page-pagination__button`
`.modal-shell` `.modal-surface` `.modal-body--scroll` `.modal-footer--sticky`
`.inspection-taskbar` `.execution-workspace` `.detail-skeleton` `.status-dot` `.status-dot--ok`

字号三档变量：`--fs-lg: 22px`（标题/强调数字）、`--fs-md: 16px`（正文/表格）、`--fs-sm: 14px`（辅助说明/时间戳）。

## 后端要动的地方（尽量少）

1. 新增视图 `pc_workspace`（或在 `asset_list` 里加分支），渲染 `pc/templates/pc/pc.html`，把上面那份 bootstrap JSON 一次算好塞进去。**复用现有函数**：`_asset_list_context`、`computer_workspace_payloads`、`computer_analysis_context`、`latest_analysis_statistics`、`table_payload`、`table_row_payloads`。
2. `pc/templates/pc/pc.html` 只保留：`{% extends 'common/base.html' %}`、`page-heading`、一个 `<div data-vue-page="pc-workspace" data-vue-bootstrap="pc-workspace-bootstrap">`、`{{ bootstrap|json_script:"pc-workspace-bootstrap" }}`、以及必须保留的弹窗 include（`issue_settings_modal`、`profile_modal`、`run_modal`、`policy_modal`、`import_modal`、`add_modal`、`collection_template_modal`、`maintenance_modal`）。
3. 在 `static/app/vue/boot.mjs` 的 `pages` 里注册 `'pc-workspace': () => import('./pages/pc_workspace.mjs')`。
4. 新建 `static/app/vue/pages/pc_workspace.mjs`，这是主体，估计 700-1000 行。
5. `index/templates/common/base.html` 里静态资源版本号 `?v=` 往上加一位，否则浏览器用旧缓存。

**不要删旧的路由和模板**。旧的 `/computers/analyses/`、`/computers/logs/` 留着做备用，等新结构验证通过再清理。

## 验收清单（自己先跑一遍，别交半成品）

- [ ] 页面打开，三个方块数字和现在一致，默认选中「PC 资产」
- [ ] 点「日志」方块，下面换成日志表，**地址栏不变**
- [ ] 点「分析记录」方块，出现巡检任务栏 + 最新任务统计六格 + 问题类型分布长条，**地址栏不变**
- [ ] 未选中的方块明显变暗，选中的方块有「当前 · 」前缀
- [ ] 资产表：18 列、默认显示 5 列，点「自定义表格」勾选后立刻增减列
- [ ] 资产表：点任意可排序表头，箭头方向变化，数据重排，**地址栏只多一个 `sort=xxx&order=asc`**
- [ ] 资产表：改每页条数，**地址栏只有 `page_size=50` 一个参数**，没有一串 `filter_xxx=`
- [ ] 资产表：翻到第 2 页，**地址栏只有 `page=2`**
- [ ] 资产表：手输页码 7 回车，跳到第 7 页
- [ ] 资产表：点「查看详情」，**弹窗出现，地址栏不变，页面不刷新**，弹窗居中，先看到「正在加载详情…」再看到内容
- [ ] 日志表：同上四项
- [ ] 分析记录：点任务行，下方统计换成该任务的数字
- [ ] 分析记录：点某个问题类型，弹窗列出该类型的明细，可翻页
- [ ] 头顶六个按钮全部可用，点「问题等级设置」弹窗打开而不是跳页
- [ ] 所有弹窗垂直居中
- [ ] `python manage.py test tests.frontend tests.system tests.inspections --noinput` 全绿

## 已知坑（别重犯）

1. 资产表的每页条数如果走 `<form method="get">` 提交，会把表单里十几个空 `filter_*` 一起序列化，地址栏立刻变成一大串。**必须用 JS 改地址，不走表单提交。**
2. `X-Frame-Options: DENY` 让全站 `<iframe>` 不可用。详情一律 `fetch` + 弹窗。
3. `grid + minmax(0,1fr) + auto` 的两列布局，能让方块标题和右侧角标在窄屏也不重叠。
4. `scrollbar-gutter: stable` 已经在全局 CSS 里，弹窗打开时不要再去改 `body` 的内边距。
5. `ComputerAnalysis.analysis_date` 是 `DateField`，格式化只能用 `Y-m-d`，带 `H` 会抛 `TypeError`。`created_at` / `last_report_at` / `collected_at` 是 `DateTimeField`，可以带时分。
6. `apply_table_filters(..., prefix='logs')` 会给日志表的每个参数加前缀，资产表和日志表的参数空间才不会打架。新的单页里如果还走服务端筛选，这个 `prefix` 必须保留。
7. 演示库 `net-test` 里 PC 资产 914 台、日志 165 条、分析 160 条；分析统计挂在任务 `f22929e0-c449-4a3b-b6c5-32afb39e497d` 上，它的 `profile_snapshot.matching_mode` 是 `device`（不是 `people`），所以能看到正常的九类问题分布。别用别的任务测试，那个是按人员匹配的，会显示「人员缺少日志 100%」。

## 做完怎么报

说清楚三件事：改/加了哪些文件、每一项验收清单怎么验证的（命令或截图）、哪些地方**没法本地验证**（Vue 运行时渲染在无头环境里跑不起来，只能靠 Django 测试 + HTTP body 断言 + `node --check`，这一点要如实说，不要含糊过去）。
