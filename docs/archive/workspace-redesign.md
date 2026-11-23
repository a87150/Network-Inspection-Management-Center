# 工作区页面统一改造方案

**这份文档给施工用。**读完就能动手，不需要再翻聊天记录。

适用范围：PC、网络设备、服务器、弱电设备、人员部门这五个「列表 + 详情」页面。
域控管理和网络拓扑不在范围内，理由见第九节。

---

## 一、改造目标

现在的页面是「Django 模板渲染骨架 + Vue 局部增强」的混合体：页面骨架、方块卡片、筛选表单、工具栏由 Django 渲染，只有表格本身是 Vue。结果是任何一次交互都可能一半走服务端、一半走前端，参数和状态对不上——地址栏塞满空参数、详情按钮触发整页导航、切换页签把内容丢到页面下方，这些都是这个混合结构的产物。

改造成：**Django 只吐一份 bootstrap JSON，Vue 单组件渲染整页**。外观不变，功能不变，只换实现方式。

---

## 二、已经做好的部分（不要重写）

### 2.1 前端公共层

`static/app/vue/composables/use_table.mjs` —— 表格的共用规则，纯函数，无状态。

| 导出 | 签名 | 用途 |
|---|---|---|
| `tableData` | `(props) => state` | 从 props 和地址栏取初始状态 |
| `syncUrl` | `(changes, {pageSize, prefix}) => void` | 写地址栏，只写有值的参数 |
| `apiParams` | `(filters, extra) => object` | 页面筛选值 → `filter_<key>` 接口参数 |
| `cellOf` | `(row, key) => {text, badge?}` | 取单元格 |
| `badgeClassOf` | `(row, key) => string` | 徽章类名 |
| `actionClassOf` | `(action) => string` | 操作按钮类名 |
| `fetchPage` | `(endpoint, page, {filters, pageParam}) => Promise` | 请求一页 |

`static/app/vue/components/` —— 七个展示组件，全部通过 `node --check`。

| 文件 | props | emits |
|---|---|---|
| `workspace_table.mjs` | endpoint, tableKey, columns, rows, count, page, pages, page_size, start_index, end_index, sort, order, filters, visibleColumns, shownFilters, detailBase, emptyTitle, emptyMessage, label, regionLabel, urlPrefix, exportUrl, csrf, selectAttr, formId, pageSizes | — |
| `table_toolbar.mjs` | columns, filters, visible, shownFilters, count, from, to, pageSize, pageSizes, exportUrl, tableKey, busy | apply, reset, page-size, columns-change, filters-change |
| `data_table.mjs` | columns, rows, visible, sortKey, sortOrder, loading, selectAttr, formId, csrf, activeId, emptyTitle, emptyMessage, label, regionLabel | sort, open-detail, row-click |
| `page_pagination.mjs` | page, pages, loading, label, modelValue | go, update:modelValue |
| `detail_modal.mjs` | base, title, modalId | 暴露 `open(id)` 方法 |
| `metric_card.mjs` | title, badge, metric, unit, lines, entry, latest, latestLabel, selected | select |
| `task_bar.mjs` | rows, count, page, pages, selectedId, sectionTitle, emptyTitle, busy | select, page, detail |

**`workspace_table` 是组合件**：内部装好 toolbar + data_table + pagination + detail_modal，自己做请求、自己改地址栏。页面里写一行：

```html
<workspace-table v-bind="assetsTable"></workspace-table>
```

就得到完整的一套表格交互。分页、排序、筛选、换每页条数、点行看详情全部就绪。

### 2.2 后端公共层

`index/common/workspace.py` —— 只做拼接，不算业务。

| 函数 | 用途 |
|---|---|
| `bootstrap(*, page, blocks, table, urls, csrf='', **extra)` | 组装整页 JSON |
| `block(*, key, title, metric, unit, lines, entry, latest, latest_label, badge)` | 一个顶部方块 |
| `stamp(value)` | DateTimeField → `'2026-11-20 20:35:26'` |
| `task_rows(page_obj)` | 巡检任务分页 → 纯 dict 列表 |
| `task_block(page_obj, *, section_title, empty_title)` | 任务栏整块 |

`block()` 的 `lines` 参数格式：

```python
lines=[
    [{'text': '活跃 '}, {'text': '913', 'tone': 'success'},
     {'text': ' 台 · 停用 '}, {'text': '0', 'tone': ''}, {'text': ' 台'}],
    [{'text': '活跃率 99.9%'}],
]
```

`tone` 为空字符串或省略时用默认色，否则渲染成 `text-<tone>`（success / danger / warning / info）。


### 2.3 现有模块的既有能力（直接用，别重写）

后端：

| 函数 | 位置 | 干什么 |
|---|---|---|
| `_asset_page(kind)` | `assets/views.py:68` | model、表 key、标题 |
| `apply_table_filters(request, qs, definition, prefix=, include_legacy_status=)` | `index/common/table_query.py:394` | 筛选 + 排序 + 分页状态 |
| `table_payload(page_obj, definition, rows, extra=)` | `index/common/table_payload.py:80` | 整页 → `{columns, rows, count, page, pages, page_size, start_index, end_index}` |
| `row_payloads(records, definition, badges=, actions=, row_id=)` | `index/common/table_payload.py:48` | 行 → `{id, cells, actions}` |
| `asset_row_actions(kind, admin)` | `assets/payloads.py` | 操作列按钮 |
| `_asset_detail_context(request, kind, pk)` | `assets/views.py:298` | 详情数据 |
| `device_overview(kind, model)` | `assets/overview.py:77` | `{total, active, active_rate, variants, variant_label}`，**没有 inactive**，自己算 `total - active` |
| `computer_logs_payload(request)` | `inspections/records.py:560` | `pc_logs` 表格、`pc_logs_computers`、`pc_logs_missing_people`、`pc_errors_total`、`pc_logs_latest`、`pc_assets_latest` |
| `_asset_list_context(request, kind)` | `assets/views.py:108` | 整页 context，弹窗 include 依赖它 |
| `project_workspace_context(request, kind)` | `net/inspections/task_summary.py:333` | `task_metrics`、`task_page`、`latest_task`、`task_section_title`、`task_empty_title` |
| `latest_analysis_statistics(task)` | `inspections/analysis_summary.py:70` | `{total, levels:{normal,info,warning,critical}, execution_failed, categories:[{label,count,percentage}]}` |
| `build_project_task_metrics(qs)` | `net/inspections/task_summary.py` | `{task_count, completed_count, normal_count, abnormal_count, abnormal_rate, latest_task_at}` |
| `workspace_action_context(kind)` | `index/common/workspace_actions.py` | 头部按钮开关 |
| `task_modal_context(request, kind)` / `alert_modal_context(request, profile)` | `inspections/tasks.py` / `alerts/views.py` | 分析配置 / 手动执行 / 告警配置弹窗 |

接口（都是现成的，**不要新建**）：

| 用途 | 路径 | 参数 |
|---|---|---|
| 资产行 | `GET /api/v1/asset-rows/<kind>/` | `page` `page_size` `sort` `order` `filter_<key>` |
| 日志行 | `GET /api/v1/computer-logs/` | 同上 |
| 详情 | `GET /assets/<kind>/<uuid:pk>/detail.json` | — |
| 问题明细 | `GET /computers/analyses/tasks/<task_id>/problems/?category=<类型>&page=<n>` | 返回 HTML 片段 |

接口返回里**没有 `columns`**，列定义只在首屏 bootstrap 里，翻页后要沿用首屏那份。

---

## 三、数据契约

每页一份 bootstrap JSON，同一个形状：

```json
{
  "page": {"key": "computers", "title": "PC", "heading": "…"},
  "blocks": [
    {"key": "assets", "title": "PC 资产", "badge": "台账", "metric": 914, "unit": "台",
     "lines": [{"parts": [{"text": "活跃 "}, {"text": "913", "tone": "success"}]}],
     "entry": "查看 PC 资产", "latest": "2026-11-19 12:12:00", "latest_label": "最新上报"}
  ],
  "table": {"columns": [], "rows": [], "count": 0, "page": 1, "pages": 1,
            "page_size": 20, "start_index": 0, "end_index": 0,
            "filters": {}, "sort": "", "order": "asc", "pageSizes": [20,50,100,200,500],
            "visibleColumns": {}, "shownFilters": {}},
  "urls": {"rows": "…", "logs": "…", "detail": "…"},
  "csrf": "",
  "assets": {}, "logs": {}, "analyses": {}
}
```

`blocks` 用数组不用具名字段，页面想放几张卡片就放几张。`lines` 里的文字已经格式化好，前端不做格式化。

表格块（`table` / `assets` / `logs`）的字段直接喂给 `workspace_table` 的 props，一一对应。

行对象沿用现有输出：

```json
{"id": "833e3634-…",
 "cells": {"computer_name": {"text": "H024243"},
           "os": {"text": "…", "badge": {"label": "…", "tone": "success", "class": "text-bg-success"}}},
 "actions": [{"kind": "link", "label": "查看详情", "url": "…", "detail_modal": true}]}
```

**注意**：行经过 REST 接口返回时，`actions` 里的 `detail_modal` 字段会丢（实测 `/api/v1/computer-logs/` 返回的是 `{"kind":"link","label":"查看详情","url":"…"}`）。首屏 bootstrap 走 `row_payloads` 直出，字段是完整的。如果翻页后详情按钮失效，从这里查。

---

## 四、URL 规则（五页统一）

写进 `use_table.syncUrl`，已经实现：

| 参数 | 写 | 不写 |
|---|---|---|
| `page` | 大于 1 | 第 1 页 |
| `page_size` | 不等于默认值 | 默认值 |
| `sort` / `order` | 用户点过表头 | 默认排序 |
| `filter_<key>` | 有值 | 空串 |

**切换方块、打开详情一律不动 URL。**不要写 `?object=analyses`、`?selected=<pk>` 这类参数。

日志表的参数前缀是 `logs_`（`logs_page`、`logs_page_size`、`logs_filter_xxx`），由 `apply_table_filters(..., prefix='logs')` 生成，和资产表的参数空间分开。给 `workspace_table` 传 `url-prefix="logs"` 即可，它内部会处理；**接口那一层不带前缀**。


---

## 五、每页要做的四件套

以 PC 为例，其它页把 `pc` 换成 app 名。

### 5.1 `<app>/payloads.py`

组装 bootstrap。骨架：

```python
from index.common import workspace

def pc_bootstrap(request):
    admin = is_admin(request.user)
    overview = device_overview('computers', Computer)
    log_context = computer_logs_payload(request)          # 现成
    metrics = build_project_task_metrics(project_task_queryset('computers'))
    analysis = project_workspace_context(request, 'computers')
    statistics = latest_analysis_statistics(analysis['latest_task'])

    return workspace.bootstrap(
        page={'key': 'computers', 'title': 'PC', 'heading': '…'},
        blocks=[workspace.block(...), workspace.block(...), workspace.block(...)],
        table=_assets_table(request, admin),
        urls={'rows': '/api/v1/asset-rows/computers/', 'logs': '/api/v1/computer-logs/'},
        csrf='',
        assets=_assets_table(request, admin),
        logs=_logs_table(request, log_context),
        analyses={
            'tasks': workspace.task_block(analysis['task_page'],
                                          section_title=analysis['task_section_title'],
                                          empty_title=analysis['task_empty_title']),
            'stats': statistics,
        },
    )
```

表格块用 `table_payload` + `row_payloads`，再补字段：

```python
payload = table_payload(page_obj, definition, rows, extra={
    'endpoint': '/api/v1/asset-rows/computers/',
    'detailBase': '/assets/computers/',
    'filters': state['filters'],          # apply_table_filters 的第二个返回值
    'sort': state['sort'],
    'order': state['order'],
    'pageSizes': list(PAGE_SIZES),
    'emptyTitle': '暂无 PC 数据',
    'emptyMessage': '请运行 PowerShell PC 信息采集脚本并上报。',
})
payload['visibleColumns'] = {f.key: bool(f.default_visible) for f in definition.fields}
payload['shownFilters'] = {f.key: bool(f.default_filter) for f in definition.fields if f.filterable}
```

`table_payload` 输出的 `columns` 需要带 `filterable` 和 `default_filter`（工具栏靠它决定哪些字段露出、哪些收进「更多筛选」）。
**本轮施工时 `index/common/table_payload.py` 的 `column_payloads` 只有 `key/label/kind/default_visible/sortable` 五个字段，这两个要自己补**：

```python
"filterable": bool(field.filterable),
"default_filter": bool(field.default_filter),
```

### 5.2 `<app>/views.py`

```python
from assets.views import _asset_list_context, asset_detail_json
from .payloads import pc_bootstrap

def pc_workspace(request):
    context = _asset_list_context(request, 'computers')   # 弹窗 include 依赖它
    context['pc_bootstrap'] = pc_bootstrap(request)
    return render(request, 'pc/pc.html', context)

def pc_detail_json(request, pk):
    return asset_detail_json(request, 'computers', pk)
```

复用 `_asset_list_context` 会多算一次旧表格的 payload，但换来的是弹窗所需的表单、权限、配置开关全都齐全，不用重新拼。**先跑通，再优化。**

### 5.3 `<app>/urls.py`

**路径保持不变**：

```python
urlpatterns = [
    path('assets/computers/', views.pc_workspace, name='pc_workspace'),
    path('assets/computers/<uuid:pk>/detail.json', views.pc_detail_json, name='pc_detail_json'),
]
```

然后在 `index/urls.py` 里 `path('', include('pc.urls'))`，**放在 `path('assets/<str:kind>/', ...)` 之前**（Django 按顺序匹配），旧的那行不用删，PC 会被新路由先接住。

不换路径的理由：导航栏、详情里的「查看日志分析记录」、任务的 `history_url`、告警跳转，全站十几处 `reverse('asset_list', args=['computers'])` 或硬编码指着 `/assets/computers/`。换路径要动十几处，收益为零。


### 5.4 模板 + Vue 页

`<app>/templates/<app>/<app>.html` 只剩这些：

1. `{% extends 'common/base.html' %}`
2. `page-heading`（标题、副标题、「`{% include 'common/workspace_actions.html' %}`」六个按钮）
3. 一批弹窗 include（Django 表单和 CSRF 留在这里，不搬进 Vue）：
   - `inspections/issue_settings_modal.html`
   - `devices/collection_template_modal.html`
   - `inspections/profile_modal.html`、`inspections/run_modal.html`、`alerts/policy_modal.html`
   - `devices/maintenance_modal.html`
4. `<div data-vue-page="pc-workspace" data-vue-bootstrap="pc-workspace-bootstrap">`
5. `{{ pc_bootstrap|json_script:"pc-workspace-bootstrap" }}`

`{% block page_scripts %}` 里挂 `app/vue/boot.mjs`、`common/scripts/modal_workflows.html`、`common/scripts/inspection_workflows.html`、`app/js/inspections/analysis_problems.js`。

`static/app/vue/pages/pc_workspace.mjs` 是主体，结构：

```javascript
import MetricCard from '../components/metric_card.mjs';
import WorkspaceTable from '../components/workspace_table.mjs';
import TaskBar from '../components/task_bar.mjs';

export default {
    delimiters: ['[[', ']]'],
    components: {MetricCard, WorkspaceTable, TaskBar},
    props: {blocks: Array, assets: Object, logs: Object, analyses: Object, page: Object, urls: Object, csrf: String},
    data() { return {activeTab: 'assets'}; },
};
```

- 三个方块 → `<metric-card>`，选中态靠 `aria-selected`（CSS 在 `operations.css` 第 1565-1573 行）
- 资产面板 → `<workspace-table v-bind="assets">`
- 日志面板 → `<workspace-table v-bind="logs" url-prefix="logs">`
- 分析面板 → `<task-bar>` + 六格统计 + 问题类型长条

**分析面板的六格统计和问题类型长条只有 PC 用，写在页面文件里，不要抽公共。**

切方块只改 `activeTab`，**不要碰 history**。

`boot.mjs` 的 `pages` 里加一行 `'pc-workspace': () => import('./pages/pc_workspace.mjs')`。

改完把 `index/templates/common/base.html` 的 `?v=` 版本号加一。

---

## 六、页面清单与顺序

| 顺序 | 页面 | app | 视图 | 模板 | 前端 | 特殊之处 |
|---|---|---|---|---|---|---|
| 1 | PC | `pc` | `pc/views.py` | `pc/templates/pc/pc.html` | `pages/pc_workspace.mjs` | 三个方块；分析面板：任务栏 + 六格 + 问题长条 |
| 2 | 网络设备 | `network` | `network/views.py` | `network/templates/network/network.html` | `pages/network_workspace.mjs` | 台账 / 巡检记录两页签；维护窗口批处理 |
| 2 | 服务器 | `server` | 同上规律 | 同上 | 同上 | 与网络设备同构 |
| 2 | 弱电设备 | `weakcurrent` | 同上规律 | 同上 | 同上 | 多一个门禁记录页签 |
| 3 | 人员部门 | `people` | `people/views.py` | `people/templates/people/people.html` | `pages/people_workspace.mjs` | 部门树 + 人员同步入口，方块只有一张 |
| 4 | 域控管理 | `domain` | `domain/views.py` | `domain/templates/domain/domain.html` | `pages/domain_workspace.mjs` | **单独设计**，见第九节 |
| 5 | 清理 | — | — | — | — | 删旧路由、旧模板、旧 JS、改测试 |

网络设备 / 服务器 / 弱电设备**一次做三页**，因为它们改的是同一段代码（同一个 `_asset_list_context` 的 `kind` 分支），分开做等于同一刀切三遍。

---

## 七、每阶段必须做的验证

```powershell
# 语法
Get-ChildItem static/app/vue/components,static/app/vue/composables,static/app/vue/pages -Filter '*.mjs' |
    ForEach-Object { node --check $_.FullName }

# 测试（约 4 分钟；必须单跑，两个 manage.py test 并行会抢 test_net 库）
$env:PYTHONIOENCODING='utf-8'
./.venv/Scripts/python.exe manage.py test tests.frontend tests.system tests.inspections tests.architecture --noinput
```

再做 HTTP 层验证：用 `django.test.Client` 请求页面，断言

- 状态 200
- 响应含 `data-vue-page="pc-workspace"` 和 `pc-workspace-bootstrap`
- 解析 bootstrap JSON 后 `blocks` 长度、`table.count`、方块标题都对
- **解析 JSON 再比中文**，`json_script` 用 `ensure_ascii=True`，直接 grep 中文必然找不到

演示库是 `net-test`（`os.environ['DB_NAME']='net-test'`）：914 台 PC、165 条日志、160 条分析。分析统计挂在任务 `f22929e0-c449-4a3b-b6c5-32afb39e497d` 上，它的 `profile_snapshot.matching_mode` 是 `device`。换成别的任务会显示「人员缺少日志 100%」，那是人员匹配模式的正常结果，不是 bug。

改完 CSS/JS 必须把 `base.html` 的 `?v=` 加一，否则浏览器吃旧缓存——这个坑踩过两次。


---

## 八、验收清单（每页都要过一遍）

- [ ] 页面打开，方块数字和改造前一致，默认选中第一块
- [ ] 点其它方块，下面换内容，**地址栏不变**
- [ ] 未选中的方块明显变暗，选中的有「当前 · 」前缀
- [ ] 表格默认列和改造前一致，点「自定义表格」勾选后立刻增减列
- [ ] 点可排序表头，箭头方向变化，数据重排，**地址栏只多 `sort=xxx&order=asc`**
- [ ] 改每页条数，**地址栏只有 `page_size=50` 一个参数**，没有一串 `filter_xxx=`
- [ ] 翻到第 2 页，**地址栏只有 `page=2`**
- [ ] 手输页码回车，跳到对应页
- [ ] 点「查看详情」，弹窗出现，**地址栏不变、页面不刷新**，弹窗居中
- [ ] 弹窗先显示骨架，再显示内容
- [ ] 头部按钮全部可用，点「问题等级设置」弹窗打开而不是跳页
- [ ] `git diff --stat` 里 `assets/` 的改动只有删旧路由那几行
- [ ] 测试全绿

---

## 九、不适用这套结构的页面

**域控管理**（`domain/`，10 个模板 514 行）：账号 / 计算机 / 组三个对象类型共用一个 `object_list`，不是「一个实体一张表」。需要单独设计——顶部分段器切对象类型，下面一张表，公共层能复用但模板思路不同。

**网络拓扑**（`topology/`，0 个模板）：纯 JSON API + JS 画图，不涉及表格。

**告警维护**（`alerts/`，7 个模板 400 行 + `alert_list.mjs` 126 行）：已经是 Vue 了。

---

## 十、风险清单

| 风险 | 现状 | 对策 |
|---|---|---|
| `reverse('asset_list', args=[kind])` 分散在 `_history_url`、告警、任务十几处 | 实测存在 | 阶段 5 一次性替换，之前保留旧 name |
| 169 处测试引用 `asset_list` / `/assets/` | devices 44、architecture 34、browser 34、inspections 27、frontend 18、system 16、common 13、people 10、alerts 6 | 每阶段跑全量，不攒到最后 |
| `_asset_list_context` 里 18 处 `kind ==` 分支 | 实测存在 | 网络设备/服务器/弱电三页一起拆，别一页一刀 |
| 五份 800 行单文件组件 | 无 bundler | 公共层已抽完，每页应只剩 200-350 行配置 |
| Vue 渲染无本地验证手段 | 无 jsdom / playwright | Django 测试 + HTTP body 断言 + `node --check`，交互靠浏览器点测，**交付时必须如实说明** |
| `json_script` 中文被转义 | `ensure_ascii=True` | 测试解析 JSON 再断言 |
| 静态资源缓存 | 踩过两次 | 每次改 CSS/JS 都 bump `?v=` |
| 行 `actions.detail_modal` 经 REST 后丢失 | 实测 | 首屏走 `row_payloads` 完整；翻页失效时查这里 |
