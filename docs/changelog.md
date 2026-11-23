## 2.04（2026-11-24）

### 修复
- 域控页的批量目录操作不跟方块走：操作栏原本只有一份、放在三个面板外面，
  所以停在域分组时下拉仍是「新增用户」等账户动作。改成每个面板各带一份操作栏，
  下拉选项取该面板自己的 action 清单——分组页没有批量动作，因此不显示操作栏。
- 域控三个面板都没有勾选列：`can_select` 原本排除了 groups，且 `resource_table`
  本身没有全选能力。放开 groups 的勾选，并给 `resource_table` 补表头三态全选框
  与「全选 / 反选」按钮。

### 拓扑
- 连线悬停或选中时在连线中点显示「本地口 → 对端口」与 VLAN，其余时刻不铺文字。
- 工具栏加「IP 台账」入口指向 `ip_management`。

## 2.03（2026-11-24）

### 新增
- 拓扑页工具栏加「按 IP 定位」：输入 IP 回车或点「定位」，命中节点居中并高亮描边。
  先按 IP 精确匹配，再按 IP 包含、最后按名称包含；没命中只提示、不动视口。

### 已知未做
- IP 查询与 IP 台账仍是独立页面，尚未并入拓扑页。
- 拓扑图上的连线只画线，端口与 VLAN 仅在点选连线后的详情面板里显示
  （`localInterfaceLabel → remoteInterfaceLabel` 与 `vlanIds` 早已在数据层算好）。

## 2.02（2026-11-24）

### 修复
- 工作区表格缺勾选列：`workspace_table` 的 `selectAttr` 默认值就是
  `data-device-selection-target`，但 `assets/views.py` 用空字符串覆盖了它，
  PC 与人员页因此没有选择框、也没有全选/反选。改为始终传默认值，只让
  `formId` 跟随 `task_allow_target_selection`；`pc/payloads.py` 与
  `people/payloads.py` 补传 `selectAttr`。
- 详情弹窗的表格没有导出入口：`table_section` 新增 `export_url`，
  任务结果记录用 `result_context` 已有的 `table_export_path` 加当前筛选拼地址，
  `resource_detail.mjs` 在筛选栏右侧露出「导出筛选结果」。

### 核查未改动
- 域控页方块切换实测正常：三个面板都在 DOM 里，`panel_switch.js` 只切显隐、
  不改写地址栏，切换后目标面板 20 行数据完整。
- 域控页的动作下拉本来就按当前对象类型区分：账户有新增用户与重置，
  计算机有移动 OU 与启用停用，分组有安全组与通讯组，不存在动作错配。

## 2.01（2026-11-24）

### 修复
- 干净克隆里「下载 PC 采集器」会 500：发布产物不进仓库后，`agents/pc/windows`
  只剩文本文件，`prebuilt_host()` 读不到 `PCCollectorHost.exe` 就抛错。
  新增 `manage.py fetch_pc_collector`，按固定 SHA256 拉取宿主、PawnIO 驱动与传感器
  DLL，支持 `--check` 只校验；web 请求路径仍然只读本地文件，下载只在部署期发生。
  `settings.PC_COLLECTOR_BASE_URL` 配置产物目录。
- `tests/devices/pc/test_executable.py` 三个用例改为 `skipUnless(PREBUILT_HOST.is_file())`，
  干净环境跳过而不是判失败。

### 文档
- `access.py` 补注 `item_list` 为何仍在公开面：它按 `PUBLIC_INVENTORIES`
  字段白名单投影，不是 `asset_list` 的匿名别名。
- `architecture.md` 的「页面与静态资源」补前端指引；Vue 化施工方案移入
  `docs/archive/workspace-redesign.md`，主文档只指向 `architecture-rest-vue.md`。
- `.gitignore` 里指向已删规则的孤儿注释换成采集产物说明。

## 2.00（2026-11-23）

### 修复
- 生产库补上遗漏的三个迁移（0073 outcome_key / 0074 device_type 中文 / 0075 access_report_config）。
  之前 `net_accessreportconfig` 表不存在，弱电工作区与报表配置保存直接 500。
- 网络模板解析在 Windows 上必然超时：spawn 子进程重建解释器要 200-600ms，
  而默认预算只有 250ms。平台是 Windows 时给足 2 秒上限，解析仍在隔离进程里跑。
- `device_workspace.mjs` 写了两个 `computed` 键，后者覆盖前者，
  `logsView` / `accessView` 全部丢失，弱电「门禁记录」页签读 `accessView.*` 抛 TypeError。
- `assets/views.py` 的 `cached['latest'] = cached if latest else None` 把指标字典写回自己，
  `request._project_task_metrics` 成自环，PC 分析记录方块的「最新任务」分支形同虚设。
- `/api/v1/access-report/` 匿名可取门禁报表（平台名、通过/拒绝数、按天通行量）。补 `@login_required`。
- `dashboard_tasks` 不在 `READER_VIEWS`，只读账号在设备页点任务栏翻页 403。已入白名单。
- 设备问题明细的「等级」筛选恒空：行里存中文标签，choices 是英文枚举，比对不上。改存枚举值。
- 统计面板的「其他」类点开必空：面板按兜底归到「其他」，明细侧查分组表拿不到。改为反向排除。
- `stats.profile_label` 未脱敏：只读账号能读到巡检配置名。按 `is_admin` 清空。
- `server/` 的 `pane in ('logs','access')` 从弱电抄来，服务器页没有 access 块，`?pane=access` 回空 payload。
- 问题明细 bootstrap 的 `endpoint` 手工拼 category，含 `&`/`#` 时断裂。改 `quote()`。

### 变更
- PC 首页方块顺序改为 PC 资产 / 分析记录 / 日志。
- PC 与三个设备页的六格统计改为并排小卡片（`col-6 col-xl-2` + `card`）。
- 设备页长条可点开问题明细，走独立路由 `inspection_problem_list`，
  与 PC 共用 `_problem_rows_response`，翻页/排序/筛选/导出都回到自己的地址。
- 设备检查项按大类归并出面板（网络 24 项 → 6 类，服务器 9 → 4，弱电 6 → 5），
  记录表列与问题明细仍用细项名。
- 设备任务栏默认选中最新任务；只有选中的不是最新那条才显示「当前选择任务统计」。

### 清理
- 删 `apply_queryset_table` / `_legacy_definition`（全项目零调用）、`_queryset_values`（已被 bulk 版取代）。

# 更新记录

[返回项目首页](../README.md)

本文件只记录**已经生效的变更**和**仍待处理的问题**。
系统当前是什么样，请看导航里的架构、设备巡检、人员与域控、数据库文档，本文件不重复描述。

## 1.60（2026-11-19）

人员页按确认下来的形态重排：统计卡片在上，下面两个按钮切「人员列表 / 部门列表」，详情从右侧抽屉展开。

详情原来是一列 `col-lg-4`，选中行会把表格从满宽挤到 8/12——拓扑页的 `topology-drawer` 是覆盖式，不用推挤布局。这里照同一套思路做 `.asset-drawer`：`position: absolute` 贴在列表右侧、`z-index: 9`、`box-shadow` 做层次，`max-width: 767px` 时改成底部上滑的 `position: fixed` 面板。

部门表从 `<details>` 折叠块改成组件内的第二个 pane。`departments` 随 bootstrap 一起下发，切换纯前端，不发请求；无部门数据时（其它四类资产）整组按钮不渲染。

## 1.59（2026-11-19）

人员页的三块内容真的并排了——上一版只是把它们堆在一起。

指标条原来是一串裸 `<section>` + 自定义类名，项目里根本没有 `metric-strip` 的样式，所以在页面上呈现为八行未加样式的文本（`总人数926` / `在职82589.1%` 挤成一片）。改成复用仪表盘已有的 `card metric-card` + `metric`，六个 `col-xl-2` 卡片一行排开。

详情栏原来挂 `v-if="detail || detailLoading || detailError"`，进页面没有选中项时整列不存在，表格吃掉满宽——所谓「三页合一」在视觉上根本没成立。现在右栏常驻，空态给一句「点左侧任意一行」，选中后 `resource-detail` 原地展开。

部门分布的 `<details>` 也套回 `card surface-card`，跟指标卡同一套外壳。

## 1.58（2026-11-19）

修掉资产列表整片空白，并把同屏多表的分页筛选做全。

### 空白页的根因

`list.html` 的 `page_scripts` 块在 1.54 改模板时丢了 `<script type="module" src="app/vue/boot.mjs">`。浏览器拿不到 boot 模块，Vue 岛永远不挂载，表格区就是一片空白——服务端 payload 里躺着 20 行 926 条，页面上一个也看不见。补回该标签后五类资产列表恢复正常。

这个 bug 是测试抓不到的：断言全在服务端，DOM 挂载属于浏览器行为。教训记在这里——改挂载点所在模板时，`page_scripts` 也要一起看。

### 表查询层的前缀已经有了，只是没用

`index/common/table_query.py` 本就支持 `prefix`：`apply_table_filters(..., prefix='accounts')` 会读 `accounts_filter_*` / `accounts_page` / `accounts_sort`，`table_state['parameter_names']` 也已经按前缀生成，`common/table_workspace.html` 用的正是这套名字。所以这次没有改查询层，只是把它用起来。

域控三个页签各用 `accounts` / `computers` / `groups` 前缀，PC 的采集异常用 `errors` 前缀，各自的分页、排序、筛选互不干扰。旧的无前缀链接由 `_alias_legacy_parameters()` 补成别名，书签不会失效。

### PC 分析记录不是表格

原以为 `/computers/analyses/` 是表格页，实际它是任务与统计视图，字段来自分析结果而非资产快照——`computer_logs` 表定义对应的是 `ComputerLogFile`，套到 `ComputerAnalysis` 上直接 `FieldError: Cannot resolve keyword 'platform'`。所以「分析记录」页签给的是最近八次分析与总数，完整视图仍在 `/computers/analyses/`。「采集异常」是真正的表格，带完整筛选与分页。

## 1.57（2026-11-19）

同一实体的列表、统计、详情与专属操作面收进一个页面。

### 域控对象：三个视图同屏

`domain/object_list.html` 原来一个 URL 一份表。现在 `_domain_panel()` 给每个 object_type 构造独立 payload，模板用 Bootstrap tab 渲染三个 pane——账、计算机、分组的表、工具栏、导出、分页并列在同一页，页签只切显示。打开 `/domain/accounts/` 和 `/domain/groups/` 落的是同一页，只是当前页签不同。

三个表字段各不相同，共用一套 `filter_*` 会让互不认识的键互相误伤，所以 `_without_filters()` 让非当前页签取默认排序与首页。这是刻意的：同一页里三套筛选如果互相串，比切页更糟。

### PC：资产 + 分析 + 异常同屏

`/assets/computers/` 现在带三个 pane：资产工作区（完整筛选、分页、详情栏）、分析记录、采集异常。后两个是首屏预览，各带一条「打开完整列表」的链接——它们和资产表分属不同的表与分页，硬塞进同一套 query 参数只会互相覆盖。

### 人员：部门分布并入

`department_totals()` 把原来只在 `/people/statistics/` 上的部门分布搬到人员工作区顶部，收在指标条下方的折叠面板里。看人数和看部门构成不再需要跳页。

### 未改动的

巡检记录（`record_detail`）和 PC 分析详情（`computer_analysis_detail`）仍是独立页——它们不是资产实体，走自己的 `detail-bootstrap`。

## 1.56（2026-11-19）

域控对象与 PC 的分散入口收成页内页签。

域账户、域计算机、域分组原本是三个平级入口，要对照就得反复进出；`domain/object_tabs.html` 把它们放在同一组页签下，`aria-current` 标出当前视图。PC 同理：资产、分析记录、采集异常现在共享 `pc/tabs.html`，第三个页签正好接上「这台机器为什么采不到数据」那条链路。

切换仍是整页请求，没有把三份数据塞进同一个 payload——它们分属不同表、不同分页、不同权限，硬合成一份只会让其中两处先腐烂。页签解决的是位置感，不是数据耦合。

## 1.55（2026-11-19）

列表页加指标条，详情深链直接落在工作区里。

### 指标条

人员、服务器、网络设备、弱电、PC 列表顶部现在有一行数字，数据来自 `assets/overview.py`。原来这些只出现在独立的统计页，看规模要单开一页再回来；现在和列表同屏。

人员沿用 `people_statistics` 的口径（总数、在职、离职、当年入职/离职、平均司龄），设备是总数/启用/厂商数；服务器没有 `vendor`，第三格换成采集方式。

### 深链合并

`/assets/<kind>/<pk>/` 和 `/people/<pk>/` 不再渲染独立详情页，而是渲成工作区，选中项就是路径里的那条记录：`asset_detail` 转调 `entity_workspace`，把 `initialDetail` 塞进 bootstrap，`selectedId` 由路径给出。

于是在列表里点行（`replaceState` 换成 `?selected=`）和从收藏夹打开 `/people/<pk>/`，落的是同一个页面同一处状态。原来那条“点进详情再退回来”的往返没有了。

`NET_ENTITY_WORKSPACE` 控制生效范围：默认 `all` 全开，设成 `networks,servers` 逐类生效，留空全部回退到旧详情页。出问题时不用改代码。

### 边界

巡检记录详情（`record_detail`）和 PC 分析详情（`computer_analysis_detail`）不走工作区——它们不是资产，`detail-bootstrap` 照旧。

## 1.54（2026-11-19）

资产列表改成 REST 驱动的 Vue 岛，并把详情收进右侧面板——点行不再跳页。

### 五类资产列表 Vue 化

`assets/templates/devices/list.html` 里的服务端表格换成 `asset-workspace` 挂载点，行数据由新增的 `GET /api/v1/asset-rows/<kind>/` 提供。该端点复用页面自己的 `apply_table_filters` 与 `table_row_payloads`，所以首屏和翻页看到的列、筛选、排序、行动作是同一套代码算出来的，不会各自漂移。

列定义仍以服务端 `table_registry.py` 为唯一来源，通过 bootstrap 传给前端；列偏好开关继续走 `data-column-toggle`，组件监听 change 事件同步可见性。

### 右侧详情面板

`static/app/vue/pages/asset_workspace.mjs` 负责表格 + 分页 + 详情栏。点行时取一次 `GET /assets/<kind>/<pk>/detail.json`，右栏直接嵌 `resource_detail.mjs` 渲染，URL 用 `replaceState` 记下 `?selected=`。宽屏两侧分栏，窄屏详情落在列表下方。

详情 JSON 由新视图 `asset_detail_json` 提供，与整页详情共用同一个 `_asset_detail_context`，两边字段不会分叉。它按普通读者放行（进了 `READER_VIEWS`）——同一份数据、同一套判定，多一层白名单只会让两处规则漂开。

### 渲染契约测试跟着搬家

表格结构现在归组件所有，所以约二十条断言从「grep HTML」改成读 bootstrap JSON（`tests.payloads.asset_table` / `asset_table_text`）。少数纯前端的约定（选择列在第一列、`role="region"`、分页控件）改成断言组件源码。

### 尚未做的

`改装方案.md` 里的 `/people/<pk>/` 深链合并、PC 与域对象的页内 tab、人员统计并入工作区，都还没动。本次只覆盖五类资产列表与它的详情面板。

## 1.53（2026-11-19）

### 巡检令牌走明文 HTTP（SEC-04）

Windows 采集端填了巡检令牌、地址留空时，用的是内置 `http://<IP>:9180/inspection`——令牌在抓包里是明文，拿到就能伪造上报、污染分析结论。表单现在拒绝「令牌 + 明文地址」这个组合：地址改成 `https://`，或者清空令牌只做只读采集（这种情况仍然允许，现场不少脚本就跑在隔离网里）。

### 前端 ESM 测试从未在 CI 上跑过（TST-02）

`tests/frontend/*.test.mjs` 里是 Vue 岛的逻辑核心（成员选择、API 客户端共 15 条用例），CI 的 glob 只匹配 `.test.js`。现在分两步跑；两种扩展名塞进同一次 `node --test` 会静默丢掉 `.mjs` 那一批，所以没有合成一步。

## 1.52（2026-11-19）

### 首页 SQL 随历史任务线性增长（PERF-01）

`inspection_task_queryset()` 用 `.defer()` 排除了 `parameters_snapshot` 这个大 JSON 字段，而 `_frozen_roster_ids()` 每读一次就补一条 SELECT——实测首页 25 条 SQL 里有 10 条是逐个任务回查同一个字段，历史任务越多越慢。现在一次批量取回并回填，只给真正需要名册的人员模式任务查。首页降到 15 条，且不随任务数增长。

新增 `tests/dashboard/test_home_query_budget.py`：10 个任务和 30 个任务的首页 SQL 上限相同。

### 版本号三处不一致（DOC-05）

`net/__init__.py` 写死 1.4.0、README 写 1.50、`VERSION` 文件又是第三个数。现在 `net.__version__` 直接读 `VERSION`，改版本只改一处；测试同时断言 README 首行与 `VERSION` 一致，且没有模块再硬编码版本串。

### .env.example 缺 15 个变量（DOC-02）

补到与代码读取的 36 个变量完全覆盖，包括登录限速四项、SQLite 三项、HTTPS 与静态目录。新增 `tests/system/test_env_example_coverage.py` 守住这条。

顺带修掉示例里 `# DB_TEST_NAME=net-test` 这行——它教的正是 1.51 修掉的那个删库写法，现在改为 `DB_DEMO_NAME=net-test` 并加注释说明两者不能重名。

### 未在本轮处理

PERF-02（拓扑写入持锁逐条 N+1）需要重排双向链路的规范化逻辑与 stale 计数，改动面覆盖整段 `complete_topology_batch` 事务，单独排一期；Q-02/Q-03（视图直连 ORM、11 组循环依赖）同理。

## 1.51（2026-11-19）

健康检查报告里「立即」一档的七项。

### DB_TEST_NAME 与演示库重名会删数据（ENG-01）

`deploy/demo.py` 优先读 `DB_TEST_NAME` 决定演示库名，而 settings 又用它推导测试库名——`.env` 里写了 `DB_TEST_NAME=net-test` 时，`manage.py test` 会把演示库当成测试库 DROP 重建。现在演示库只认 `DB_DEMO_NAME`，settings 在测试库名撞上生产库或演示库时直接抛 `ImproperlyConfigured`，启动就失败而不是跑到一半删库。

### admin 登录没有限速（SEC-05）

`/login/` 早就有失败计数，`/admin/login/` 一直裸奔，而 admin 能改全部设备口令。改用 `ThrottledAdminConfig.default_site` 挂自定义 `AdminSite`，锁定期间即使密码正确也拒绝，成功登录清零计数。

### 模板解析超时预算恒为 2 秒（F-01）

`max(2.0, min(timeout, 2.0))` 对任何输入都等于 2.0，调用方传的 250ms 快速放弃预算完全没起作用。改成 `min(max(timeout, 0.05), 2.0)`，并把计时起点挪到进程启动之后——Windows 上 spawn 冷启动要 200-600ms，算进预算会让每次解析都判超时。

### 依赖升级（SEC-01）

按 OSV 通告升级：aiohttp 3.14.5、certifi 2026.10.23、djangorestframework 3.18.3、dnspython 2.9.2、pyasn1 0.6.5、urllib3 2.8.0、yarl 1.25.1。`requirements.txt` 与 lock 同步更新。

### 依赖测试不再钉版本号（SEC-02）

`tests/system/test_dependencies.py` 原先把 19 个依赖的最新版本写成常量双向断言，任何升级都会被判成契约破坏。现在只保证 requirements ↔ lock ↔ 已安装三方对齐。

### manage.sh 忽略角色参数（ENG-05）

`start` 和 `restart` 共用一支分支，且都遍历写死的 `web worker`，传 `restart worker` 照样把在线 Web 重启一遍。拆成两支，各自只操作 `roles` 数组里点名的角色。

### 空目录（Q-01）

删掉 `net/api`、`net/exports/adapters`、`net/services/collectors`、`net/tasks/executors`、`net/integrations/people`、`index/forms` 等 10 个零文件目录。

## 1.50（2026-11-19）

### 更名为天枢

品牌标题改成「天枢」，下面一行小字是「网络巡检管理中心」。标题统一由 `common/base.html` 拼成「页面名 · 天枢」，页面只写自己的名字；登录页、拓扑页、admin 之前各自硬拼了后缀，一并去掉。GitHub 仓库改为 `Network-Inspection-Management-Center`。

### 域账号统一叫域账户

同一个对象在模型 choices、消息文案、导航、表头里有「域账号」「域账户」两种写法。现在统一成「域账户」，导航项、下拉选项、错误提示、导出表头跟着改，迁移 0071 只更新 choices 文本。

### 拓扑按场地分行

原先所有设备平铺在四层里，几个场地通过防火墙 VPN 互联时，看不出哪台跟哪台是一伙的。现在后端按「摘掉出口之间的链路后剩下的连通分量」切场地——只看链路结构，不看设备名；同场地的主备防火墙经核心仍然连通，不会被拆开；单场地时全部落进一个分量，布局自动退化成一棵树。前端一个场地一列并排展开，场地内仍是出口→核心→汇聚→接入，场地之间的链路按 VPN 隧道单独上色。展开的终端统一沉到各场地底部，不再和接入层混在一起。

### 清理

删掉无引用的 `index/templatetags/custom_filters.py`、`inspections/task_row.html`、`inspections/task_target_row.html`、`common/empty_state.html`，以及仓库里的临时目录、备份包和旧 `.env` 副本。

## 1.4.0（2026-11-18）

### 维护窗口改成列表页批量登记

原先在设备详情页单台新建，等于把"批量变更"拆成点开一台、填一次表。现在入口在列表页：勾选若干资产，点「加入维护窗口」，弹窗填一次起止时间与备注，就为每个选中项各建一条窗口。设备详情页的维护区块和相关路由一并删除。

维护窗口从"只认网络设备"扩到三类资产：网络设备、服务器、弱电设备。`MaintenanceWindow.device_id` 改名 `target_id` 并新增 `target_type`（取值与 `AlertEvent.target_type` 对齐），迁移 0070。这样同一个 UUID 在不同资产类型下不会互相压制告警。

### 维护记录页

新增「维护记录」页，列出全部窗口：资产名、类型、开始、结束、状态（进行中/未开始/已结束）、备注，可按状态筛选、逐条删除。导航里的「告警记录」改成「告警维护」下接「告警记录」与「维护记录」两项。

### 内存总量、磁盘总量支持大于/小于/等于

这两个数值列原先有输入框但筛选不生效：`_filter_queryset` 只处理 text/choice/boolean/date 四类，number 落空。现在改成"操作符下拉 + 数值框"，`gt`/`lt`/`eq` 走同一条查询路径（`NUMBER_LOOKUPS` 把 `eq` 映射到裸 lookup）。数值非法或被篡改时静默忽略，不会 500。

### 筛选栏整理

删掉列表页那排"已选筛选"chip——它显示的条件和下方筛选面板完全重复，且没有可用的撤销动作，只剩一个不起作用的 ×。同时把筛选栏按钮改为右对齐，和表格工具区其他操作同一视觉起点。

## 1.3.1（2026-11-18）

只做一件事：域分组成员弹窗的选择状态迁到 Vue 岛屿（见下）。页面外观与提交行为不变。

## 1.3.0（2026-11-17）

### IP 台账与 IP 管理页

IP 定位原先只是一个查询框。现在和台账合成一页：上面查“这个地址在哪台设备的哪个口被看到”，下面是对照表——网段、用途、VLAN、网关、DHCP 地址池、登记数与巡检实际观察数。

两张表：`IpSubnet` 存网段、网关、VLAN 和 DHCP 池；`IpAddress` 存登记（状态、主机名、MAC、使用人）。迁移 0069。录入在运维管理台的「IP 网段」，网段表单里带内联的地址登记。

四类提示，都在同一页顶部列出来：同一 IP 被观察到多个 MAC（冲突）、登记 MAC 与巡检看到的不一致（漂移）、静态地址落在 DHCP 池内（会被池发出去）、网段互相重叠（统计重复计数）。同时列出“观察到但没登记”的地址，方便补台账。

### 配置备份历史改版

两张说明卡换成一条提示，页面顶部加摘要（版本数、合计大小、累计变更、最近采集时间）。变更列拆成绿 `+N` 和红 `-M` 两个 chip，首个版本单独标注。

### 维护窗口进入设备详情

以前只能在运维管理台建窗口。现在网络设备详情页有「维护窗口」区块：列表显示开始、结束、状态（进行中/未开始/已结束）、备注，右上角「新建窗口」展开内联表单，默认填当前时间到一小时后，每行可删除。接口与 admin 共用同一张表。

### 域分组成员弹窗改为 Vue 岛屿

成员选择（全选/反选/清空、已选计数、提交按钮禁用）原先靠 87 行命令式 DOM 操作，分布在 document 级事件监听里。现在改为 Vue 岛屿：纯逻辑（`nextSelection`/`summaryLabel`/`submitDisabled`）抽成 `member_selection.mjs`，可在 Node 下直接测；组件只负责把选中数组映射到界面。

表格仍由服务端渲染，只给 checkbox 加 `v-model`，没有引入 SFC、构建步骤或新依赖。挂载是幂等的（检查 `__vue_app__`），因为弹窗内容在分组列表页是 fetch 后注入的，脚本要在 `app:modal-updated` 时对注入的 DOM 重新挂载。表单失败回填仍然有效：初始选中从服务端渲染的 `checked` 读取。

### 网络拓扑全屏

拓扑页改成满屏：画布占满视口高度，标题与说明、刷新控制、链路筛选与缩放、图例、链路详情、文字列表全部浮在画布上方，不再占据纵向空间。窄屏（<992px）自动退回流式布局，避免浮层互相遮挡。

## 1.2.0（2026-11-17）

### 设备命令行并发上限

巡检配置里的 `concurrent_workers` 只约束一个任务。两个巡检同时跑、或单个配置设得很高，就会把被巡检交换机的 VTY 打满，现场表现是大面积登录失败，排查方向会被带到"凭据错误"上去。

新增 `NET_SSH_CONCURRENCY`（默认 10）与进程内信号量，在任务线程进入执行前占位，超时按"等待并发配额超时"记录，不无限阻塞。网络设备与服务器同池——两者都可能开 SSH 会话；弱电设备走 SNMP/HTTP，不进池。

信号量是进程内的，N 个 Worker 进程就是 N 倍预算。这条天花板有意保留并写在代码注释里，升级路径是换 Redis 计数。

### 配置版本对比与变更行数

配置备份一直有 10 个历史版本，但没有任何对比入口，只能下载两份到本地用其他工具比。新增按行对比：`difflib.SequenceMatcher`、`autojunk=False`（配置里重复短行多，开启popularity 启发式会错位整块）。对比页只有管理员可见，**不做脱敏**——打掉 `enable secret` 那几行，正好藏住运维要找的改动。

同时修掉一个契约冲突：备份历史页有一项既有测试断言"历史页绝不解密"。变更行数改在**写入时**算好，落库为 `change_added` / `change_removed` 两列，列表页直接显示 `+N / -M`，不再解密。迁移 0067。

### 告警维护窗口

给单台网络设备设定计划变更时间段，窗口内的告警**照常生成、照常入库，只是不投递**：投递行保持 pending，历史里能看到"当时确实告警了、被窗口压住"。窗口结束若仍在重试范围内会自动发出。

判断点在 `_claim_deliveries` 抢占之前，因此摘要类与单目标类两条投递路径都生效。区间为半开 `[start, end)`，全部在 Python 侧按 `settings.TIME_ZONE` 计算——`net.W001` 未解决，数据库时区函数会求值为 NULL。迁移 0068，录入入口在运维管理台。

### IP 定位

ARP、MAC、LLDP、路由表本来就是交换机/路由器/AC/AP 的默认巡检项，证据每天都在采，只是没有查询入口。新增按 IP 或 MAC 反查：返回哪台设备的哪个接口、哪个 VLAN、哪次巡检、什么时候。

不改采集、不加扫描：只读各设备最近一次成功巡检结果，默认回看 7 天，MAC 比较忽略分隔符（`aa:bb:cc`、`aabb.ccdd.eeff`、`aabbccddeeff` 等价）。页面明确标注 ARP/MAC 是被动观察，只证明某次巡检见过，不证明此刻在线。

### 未包含

IP 台账与 Vue 岛屿按约定放到 1.3.0。

## 1.1.0（2026-11-17）

### 网络设备新增 Telnet 传输

命令行会话有 SSH 与 Telnet 两种传输，由设备的「命令行协议」二选一，互斥：同一个 Netmiko 会话只换传输层，命令表、分页处理和解析完全复用，没有第二套采集实现。Netmiko 对每个已映射厂商都提供 `_telnet` 驱动（Cisco、H3C、Huawei、Ruijie 与通用终端），切换传输不需要改模板、命令或解析。

没有做成「SSH / Telnet / SNMP 三个独立勾选」：SSH 与 Telnet 属于同一个命令行会话，同时勾选没有意义；系统又已按巡检项选择协议（`snmp` / `ssh` / `auto`），再加一层开关会与项目级设置互相矛盾。因此拆成两个维度——`connection_type` 决定命令行与 SNMP 的分工，新增的 `cli_protocol` 决定命令行走哪种传输，实际组合全部可达。

### 设备端口改为留空取默认值

`port` 与 `snmp_port` 不再是必填项：留空时命令行端口按协议取 SSH 22 / Telnet 23，SNMP 端口取 161；填写即覆盖，非标准端口只需改这一项。表单占位符随协议切换，CSV 导入与导出新增「命令行协议」列。任务快照一并记录 `cli_protocol`，入队后改协议会被判定为配置变更，不会拿旧快照跑新协议。

Telnet 是明文协议，账号口令与采集内容在链路上可读，只用于确实没有 SSH 的老设备。

### 部署不再丢失默认设备模板

`deploy/setup.py` 与 `deploy/demo.py` 在迁移后调用 `create_network_templates`：新机器安装完即带 31 个默认模板（网络 20、弱电 9、深信服 2），不必再手工执行命令。该命令幂等，跳过已有同范围模板，不覆盖人工修改。

### CI 修复

CI 的 MariaDB 服务镜像只创建库用户、不建应用库，`manage.py check` 报 `(1049, "Unknown database 'net'")`；改为在跑检查前显式 `CREATE DATABASE`。

> 本版本同时包含 1.0.0 之后记录在下方日期小节里的变更：凭据加密存储、登录失败限速、HTTPS 与 Cookie 加固开关、MariaDB 时区表告警、工程清理。

## 2026-10-05

### 设备与告警凭据加密存储

这些列此前是**明文**：网络设备 SSH 口令、SNMP 团体字与 SNMPv3 密钥、深信服 AC 共享密钥、
服务器与弱电设备口令令牌、域控绑定口令、告警 SMTP 口令与 webhook secret、飞书/钉钉 app_secret。
一次数据库读取泄露——备份被拷、账号权限过宽、一次 SQL 注入、运维导出一份库——就等于同时
交出整份清单。项目另外 5 处密钥早已用 Fernet，这里补上缺的部分。

复用 `DEVICE_BACKUP_ENCRYPTION_KEY`，未新增独立密钥。读写经 `EncryptedCharField` /
`EncryptedJSONField` 自动完成，界面与调用方无感知；JSON 只加密字符串叶子，保留文档形状。
迁移 0064 改列类型、0065 转存量明文为密文（可逆）。

> 注意：这把密钥因此从「只保护配置备份」升级为「能解开全网设备凭据」。**丢失即永久无法恢复**，
> 必须离线独立备份；Web 与 Worker 必须一致。轮换它会同时作废配置备份，如需分开轮换应改用独立密钥。

### 登录失败限速

按账号与来源双计数，登录成功立即清零，计数存在缓存里，不引入 `django-axes`。来源阈值默认 20、
故意宽于账号阈值 5：整个办公室通常共用一个 NAT 地址，等值阈值会让几个人输错密码就锁死所有人。
所有缓存读写都包了异常，缓存故障时放行而不是把所有人锁在门外。

### HTTPS 与 Cookie 加固开关

`NET_SECURE_COOKIES`、`NET_SECURE_SSL_REDIRECT`、`NET_SECURE_HSTS_SECONDS` **默认全部关闭**：
直连 HTTP 的部署一旦开启 SSL 重定向，整个站点会跳到自己无法服务的地址；浏览器对 `Secure` Cookie
是丢弃而不是降级；HSTS 客户端无法撤回。确认证书与代理转发就位后再逐项开启。

### MariaDB 时区表缺失告警

日期筛选一律用半开区间而非 `__date`，所以当前没有故障；但以后在 `DateTimeField` 上用 `TruncMonth`
或 `ExtractHour`，Django 会生成 `CONVERT_TZ(列, UTC, Asia/Shanghai)`，时区表为空时求值为 `NULL`，
筛选不报错、直接返回空。新增 `net.W001` 系统检查提示并给出导入命令；官方 `mariadb:12` 镜像同样不导入。

### 清理与工程卫生

- 删除 3 个死模板（无 view 渲染、无 include，唯一引用来自断言它们存在的测试）及对应断言。
- 清理 `runtime/`、`.task6-artifacts/`、`.worktrees/`、`demo-runtime/` 等磁盘垃圾约 374 MB。
- 修复 ACL 损坏的临时目录，`ruff check` 此前静默吞掉 `os error 5`、`ruff format --check` 直接 panic。
- 最低 Python 回到 3.12（Django 6.1 自身支持的最低版本）；CI 与 ruff 目标仍为 3.14。
- 与 `origin/main` 建立共同祖先，两条历史此前无共同祖先，一次 `push --force` 会抹掉远端提交。
## 当前待处理

| 事项 | 说明 |
| --- | --- |
| 门禁平台兼容性 | V6600 需部署实例核实端点与认证，当前按 V6000 2.11 兼容格式处理；海康/大华仅为占位，不承诺可用 |
| SSH 主机身份校验 | 尚未做 known_hosts 校验，见 [安全待办](security-followups.txt) |
| 数据库口令存储 | 数据库密码依赖系统凭据库，跨主机迁移需重新配置（设备凭据已改为应用层加密，见 2026-10-05） |
| PC 采集器 HTTPS 与双向认证 | 当前仅 Bearer Token，无客户端证书 |
| `index/access/adapters.py` 方向与结果字段 | 目前固定回填 `unknown`，已知问题 |
| H4 无障碍项 | 部分弹窗与表格控件缺少完整键盘与读屏语义 |
| `static/app/css/style.css` | 1 行注释空壳，仍被两个 base 模板 `<link>`，每页浪费一次请求 |
| `sync_domain` / `policy_snapshot` | 仅被测试引用的函数 |
| 拓扑批量删除 | 关联 PROTECT 保护缺失（D2），删除前需确认级联范围 |
| PostgreSQL 排序规则 | 库必须按 `LC_COLLATE 'C'` 建，locale 排序会让中文名先后与 MariaDB 相反 |
| PC 采集宿主自测 | 3 个用例在受限令牌下会因目录 ACL 报「访问被拒绝」，已用 `@requires_powershell` 跳过。采集器本身在管理员与普通桌面会话下均已实测可用；`PCCollectorHost.exe` 现优先 PowerShell 7，找不到才退回 5.1 |

## 1.0.0（2026-10-04）

### MariaDB / PostgreSQL 双数据库

`DB_ENGINE` 取 `mysql` 或 `postgresql`，正式环境和模拟环境共用同一份 `.env`，改一个值即可整体换库。
两种后端跑同一套迁移、同一套测试。`psycopg[binary]==3.3.6` 进入 `requirements.txt` 与锁文件。

为了让同一份代码在两个后端上行为一致，修掉了这些后端差异：

- `JsonKeyType` 补齐 PostgreSQL（`JSONB_TYPEOF(JSONB_PATH_QUERY_FIRST)`）和 SQLite 分支。
  用 `_FIRST` 是因为 `JSONB_PATH_QUERY` 是集合返回函数，放进 `CASE` 会报类型不匹配。
- 去掉三处 `select_for_update()` + 可空外键 `select_related()` 的组合（`DomainOperation.task`、
  `Schedule.people_source`、`Schedule` 的四个档案字段）。PostgreSQL 拒绝在外连接可空侧加锁。
- 设备配置备份的文件名在落库前剔除 NUL：MariaDB 收得下，PostgreSQL 报 `DataError`，Windows 本身也不允许。
- 告警策略的 upsert 按后端能力决定是否传 `unique_fields`。

### 域控同步纳入告警

域控同步失败此前不产生任何告警：告警白名单只认巡检和日志分析两种任务类型，而域控同步按 DC 配置分作用域，
既没有档案也没有可映射的外键。现在 `result_type='domain_sync'` 会生成 `execution.failure` critical 告警，
并在同步结果落库后立即评估，不用等 worker 下一轮。

### 人员自动同步纳入告警

和域控同步同样的漏网：`ALERTED_TASK_TYPES` 里没有 `people_sync`，人员自动同步失败不产生任何告警。
现在按同步源分作用域（`people_source`），同步结果落库后立即评估，不用等 worker 下一轮。

### 界面

域控连接设置页的「启用定时同步」改用与右侧间隔输入框一致的开关卡片样式。

## 2026-10-03

### 巡检项目按设备动态备注采集方式

巡检项目标签会显示该项目在**当前所选设备**上实际使用的采集方式，例如 `实时接口流量（SNMP）`、
`CPU（SNMP/SSH）`。备注随勾选设备变化，一台没选时清空。

口径跟着采集器走：网络用 `_network_item_plan`，服务器按 `server_type`，
弱电取 `_collect_auto` 的 SNMP → HTTP API → Ping 回退链首选，避免界面与实际路径不符。

### 设备类型标签统一中文

台账里存的是代码（`switch`/`camera`）或历史自由文本，弱电设备在列表、筛选、巡检配置、导入四处
显示不一致。现统一由 `device_type_label` 翻译，来源为 `SUBTYPES`。

### 折叠区块嵌在卡片里的白块

`foundation.css` 的裸 `details { background: #fafbfc }` 会在「SNMP 高级参数」这类玻璃卡片内部
刷出不透明底色。加 `.config-section-card > details { background: transparent }` 精准覆盖，不影响
其余 14 处独立 `details`。

### 巡检项目按所选设备动态显示

一台设备都没选时不再回退显示全部项目的并集，直接不显示任何巡检项目。

### 巡检配置「测试回显解析」不再刷新页面

改为 AJAX 提交并就地回显/报错，两处入口（模板配置、单设备覆盖）都已处理。

### 服务器巡检配置工具栏与代码整理

- 服务器不渲染厂商筛选，五列工具栏会拉伸「全选」按钮，补 `.target-device-picker__toolbar--no-vendor`。
- 删除 `index/devices/network/`、`index/devices/security/` 两个空壳包（零引用）。
- 弱电设备默认模板与网络设备对齐，并统一列表、分析、巡检页面的操作按钮顺序。

### 文档整理

把 15 份现役文档合并为 7 份（架构 / 设备巡检 / PC 采集 / 人员与域控 / 数据库 / 部署 / 本文件），
删除 45 份历史实施计划与设计规格、30 份 SDD 任务记录、5 份评审报告。

## 2026-10-01

### PostgreSQL 支持

`DB_ENGINE` 增加取值校验，拼错直接启动失败。**这是刻意的**：早前拼错会静默连上根目录 SQLite 空库，
看起来像数据全没了。阶段 1 迁移评估见上表。

### 后台批量删除与设备停用

管理后台支持批量删除设备并带连带清理；前端改为停用而非删除，避免误删台账。

### 弱电设备扩充

「安防设备」更名为「弱电设备」，新增打印机与温湿度计类型，默认模板对齐网络设备。

## 2026-09

### 一键部署与双服务

Windows 计划任务 / Linux systemd 各起 Web 与 Worker 两个服务，支持重启。
完整步骤见 [一键部署](../deploy/README.md)。

### MariaDB / Redis

从 SQLite 切到 MariaDB，Redis 仅用于页面缓存（默认关闭），不承担任务队列。
回退边界与迁移校验见 [数据库与维护](database.md)。

### 网络设备 SNMP/SSH 混合采集

默认 auto（SNMP 优先、缺项 SSH 补充），项目可显式指定协议。深信服 AC 走独立 Open API。
详见 [设备巡检](device-inspection.md)。

### 企业网络拓扑与运维总览

自顶向下的骨干拓扑，物理链路只来自真实 LLDP/CDP 采集结果，端点按证据再按网段挂接；
演示数据为推断链路，生产不生成模拟设备。

### PC 日志采集与远程分析

Windows/macOS 采集器每两小时本地覆盖 `latest.json` 后直传 Web API，分析从数据库冻结最新日志。
详见 [PC 采集与分析](pc-collection.md)。

### 表格工作区与前端整合

统一筛选、排序、分页、导出与列偏好；Vue 仅用于运维总览页，其余为服务端模板 + 原生 JS。

