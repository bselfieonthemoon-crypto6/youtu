# 管理后台规划（2026-09-20）

范围：Cromic/Loomic 自托管安装的**运营管理面**（谁在用什么、花了多少、出了什么问题、内容与技能怎么维护）。
每一节都先写"现在有什么（含证据）"，再写"缺什么"，最后写"建议做成什么样"。
本文件只做规划，不含实现承诺；末尾是分批顺序与我需要你拍板的决策点。

现状速览：
- 管理面只有两块——**工作区级** `/admin`（用户管理 / 第三方渠道 / 设计资源，见 `apps/web/src/app/(workspace)/admin/page.tsx`）
  和上一批新增的**平台级只读**「平台总览」（见 `docs/admin-console-20260920.md`）。
- `/api/admin/*` 目前只有设计目录 CRUD/导入（`design-catalog-*`）与本次新增的 `access`/`overview`。
- 数据库共 63 张业务表（`supabase/migrations/`），**只有 `workspace_provider_audit_events` 一张审计表**，
  且它只管渠道配置；平台级操作没有任何审计轨迹。

---

## 一、用户与访问

**现在**：`profiles`(email/display_name/avatar) + `workspace_members`(role) + `platform_admins`。
`/admin → 用户管理` 只能操作**当前工作区**：列表、按邮箱加人、改角色、移除（`http/workspace-members.ts` 四个端点）。
平台管理员目前只能手写 SQL 授权。

**缺**：
- 平台级用户目录（跨工作区搜索、看某人属于哪些工作区、他的用量与最后活跃）
- 跨工作区成员管理（平台管理员给任意工作区加/删人，而不是只能管自己所在的那个）
- 平台管理员的授予/撤销界面（含"不能撤销最后一个管理员/不能撤销自己"保护）
- （可选）账号停用/封禁——涉及 auth 层，需要单独决策
- 成员维度用量（该成员发起了多少任务、消耗多少额度）

**建议**：平台级「用户」页 = 搜索（邮箱/昵称）→ 用户详情（工作区列表 + 角色 + 近 30 天任务数与消耗 + 最后活跃时间 + 是否平台管理员）
+ 操作（加入/移出工作区、改角色、授予/撤销平台管理员）。所有写操作进审计并在 UI 上二次确认。

---

## 二、套餐与计费

**现在**：`credit_balances`、`credit_transactions`、`subscriptions`、`daily_credit_claims`、`payment_events`。
`credit-service` 只有余额/扣费/退款/领取/流水/订阅**查询**；`/api/credits/admin/set-plan` 是**被刻意删除**的
（`http/credits-security.test.ts` 断言它保持 404，因为当时是"工作区管理员给自己改套餐"）。
现成可复用：RPC `grant_plan_credits(workspace_id, plan, credits)` 已能原子改套餐 + 加额度 + 写流水。

**缺**：整个"管理"能力——改套餐、增减额度、填原因、留审计；订阅周期/取消状态查看；支付事件排查；
失败任务退款核对；按工作区对账（流水 ↔ job 扣费）。

**建议**：
1. 新迁移：`admin_audit_events`（谁/何时/对什么/改前改后/原因）+ 平台管理员专用 RPC
   `admin_set_workspace_plan(...)`、`admin_adjust_credits(workspace_id, delta, reason, actor)`
   （原子、拒绝负余额、写 `admin_adjustment` 流水 + 审计行）。
2. `/admin → 套餐与额度`：按工作区查套餐/余额/周期/取消状态 → 改套餐（下拉，显示该档位月额度与并发上限，来自 `PLAN_CONFIGS`）
   → 增减额度（必填原因）→ 显示该工作区流水与失败退款记录 → 高风险操作二次确认。
3. 只读对账视图：近 30 天扣费/退款笔数与金额、`credits_cost` 与流水不一致的 job 列表。

---

## 三、任务与队列

**现在**：`background_jobs`（6 状态 / 6 类型）、`job_target_finalizations`、`realtime_event_log`/`realtime_event_consumers`、
`design_event_outbox`。平台总览只显示状态计数与最近 20 条失败。

**缺**：按状态/类型/工作区/时间筛选与分页；单个任务的完整详情（payload/result/attempt/错误码/关联画布与消息）；
死信的**重放/取消**；卡住任务（running 超时）识别；队列与 realtime 消费者健康。

**建议**：`/admin → 任务`：筛选列表 + 详情抽屉（含 job 关联的会话/画布/流水）+ 操作
（取消排队中、重放死信——**重放会产生真实费用，必须二次确认并记审计**）+ 队列/消费者健康卡片。

---

## 四、模型与渠道

**现在**：`workspace_provider_configs`、`workspace_provider_models`、`provider_execution_snapshots/credentials`、
`workspace_provider_audit_events`；工作区级 UI 已有（`ProviderSettingsSection`，含连接自检）。
平台总览显示渠道数/停用/自检失败/模型与模态分布。

**缺**：跨工作区渠道总览与筛选；自检历史（现在只有 `last_tested_at`/`last_test_status`）；按 error_code 的失败率；
模型启用/停用与默认模型的平台级视角；凭据轮换提醒。

**建议**：`/admin → 渠道与模型`：跨工作区渠道表 + 一键自检 + 失败率（按 error_code 聚合最近 N 天）
+ 模型启停（写操作，审计）+ "工作区默认模型"分布（`workspace_settings.default_model`）。

---

## 五、技能管理（含技能图片）★ 你点名的部分

**现在**：
- 表：`skills`(slug/name/description/author/version/license/category/**icon_name**/source/skill_content/metadata)、
  `skill_files`(path/content/mime_type)、`workspace_skills`(enabled/config/installed_by)。
- 界面：**工作区级** `/skills`（`create-skill-dialog` / `import-panel` / `marketplace-panel` / `skill-card` /
  `skill-detail-dialog` / `skill-metadata`），能建/导入/启停/看依赖就绪。
- **没有任何技能图片**：`icon_name` 只是 lucide 图标名；全库带图的表是另外几套
  （`design_resources.preview_asset_object_id`、`home_discovery_cases.cover_image_url`、`home_example_examples.image_urls`、
  `brand_kits.cover_url`），技能没有对应字段。
- 技能包正文与 `skill_files`、内容哈希都在，但**没有版本历史**，也没有"这个技能被哪些工作区启用"的平台视图。

**缺**：
1. 平台级技能目录：全部技能包（分类/来源/版本/哈希/依赖就绪）+ **启用工作区数与名单** + 一键为某工作区启停。
2. **技能图片**：封面图 + 多张示例输出图（带说明/所用模型/提示词），支持上传、排序、删除、草稿/发布。
3. 技能包版本：改动历史（或至少"重新导入并显示变更摘要"）、导入失败原因可见。
4. 前台展示：技能卡/详情弹窗/首页推荐位用上图片（现在只有图标与文字）。

**建议（技能图片的具体做法）**：
- 新迁移：`skill_previews`（`skill_id`、`asset_object_id → asset_objects`、`role: cover|example`、
  `caption`、`sort_order`、`status: draft|published`、`created_by`、时间戳）+ 唯一约束与排序索引；
  图片本体复用既有 `asset_objects` 存储与 RLS/GC（**不新建存储桶、不绕过删除引用检查**）。
- 服务端：`/api/admin/skills`（平台只读：目录 + 启用统计 + 预览图）、
  `/api/admin/skills/:skillId/previews`（增删改序，平台管理员）、
  `/api/admin/skills/:skillId/workspaces`（某技能的启用工作区名单，只读）；
  公开读走既有 `/api/skills`，只返回 `status=published` 的预览。
- 前端：`/admin → 技能`（平台目录 + 图片管理，拖拽排序、封面标记、发布/下架）；
  `/skills` 卡片与详情弹窗展示封面与示例图；首页推荐位可直接引用 published 示例。
- 前台安全：示例图可能含用户数据 → **只允许平台管理员上传**，`caption` 与提示词可留空；
  published 前必须有封面，弃用（下架）不删 asset，走软删 + 引用检查（与设计目录同一套做法）。

---

## 六、内容与素材（首页案例、发现、设计目录）

**现在**：
- 首页内容表 `home_discovery_cases/categories`、`home_example_categories/examples` **在服务端代码里完全没有引用**
  （全仓 `apps/server/src` 搜不到），也就是**只能靠脚本/迁移写入，没有任何管理面**。
- 设计目录（`design_resources`/`design_templates`/`font_families`/`font_faces`/`text_presets`/`resource_categories`/`resource_tags`/
  `resource_import_jobs`/`resource_import_items`）**已有完整 admin API + 一个工作区级 UI**。

**缺**：首页案例/发现内容的增删改与配图（它们本来就有 `cover_image_url` / `image_urls`，却没入口）；
设计目录 UI 的关键字段补全（预览图、标签、上架状态、批量操作）；导入任务的进度与失败原因可视。

**建议**：`/admin → 内容`：首页案例与发现内容的 CRUD + 配图 + 排序 + 上架状态；
设计目录沿用现有 API，补上预览图与批量启停；导入任务列表（进度/失败原因/重试）。

### B6b 现状复核（2026-09-20，B6a 完成后动手前核对了一遍）

首页内容已在 **B6a** 完成（`docs/admin-console-b6a-20260920.md`）。设计目录这一半复核后**比原判断小**：

- **已经有**：工作区级 UI（`apps/web/src/components/settings/design-resource-admin-section.tsx`，约 1640 行）
  已支持状态筛选与变更、标签筛选、分类、删除/恢复、字体上传、批量导入任务与进度；
  API 侧 `updateDesignResourceRequestSchema` 也已接受 `preview_asset_object_id` / `category_id` / `tag_ids`，
  `design_resources` 表本来就有 `preview_asset_object_id`、`status`、`published_at/by`、`deleted_at/by`。
  也就是说"标签、上架状态"**不缺**，原规划低估了现状。
- **真正缺的是预览图的可视化**：`design-resources.ts` 有 `GET /api/design-resources/:id/preview`
  （无预览图时回退到 `asset_object_id`），但它是**需要 Authorization 头的二进制响应**，
  浏览器的 `<img src>` 发不出这个头，所以列表里没法直接显示缩略图。
  技能图片那批（B4a）解决同一问题的办法是**服务端签发短时 URL**（`admin-skill-service.ts` 的 `signedUrl`），
  设计目录要走同一条路。
- **批量操作**：现有"批量导入"是导入任务，不是多选批量改状态/上下架。
- **一个需要在实现时想清楚的点**：设计目录既有 `scope='workspace'` 也有 `scope='platform'` 的条目，
  而预览图上传目前只走 `workspace-assets`（字体上传那条路径要求 `workspace_id`）。
  平台级条目的预览图要落在哪个桶、由谁签 URL，得先定下来——这也是本批没有仓促开工的原因。

**B6b 的建议做法**：新增一个只读的 `GET /api/admin/design-catalog/:collection/:entityId/preview-url`
（先按现有 `references()` 的做法用**用户态客户端**确认该条目对调用者可见，再用服务角色签发短时 URL，
签不出就返回 `null` 让界面显示占位符而不是坏图）+ 列表缩略图列 + "上传/清除预览图"两个动作；
批量操作先用"多选 + 逐条调用既有 update/status 接口"，不新造批量语义。

---

## 七、资产与存储

**现在**：`asset_objects`、`asset_references`；GC 逻辑分散在 `design-export-gc.ts`、`canvas-asset-references.ts`、
上传删除 RPC；**没有任何管理面**。

**缺**：按工作区/桶的占用统计；孤儿资产（无引用）盘点与清理；`deletion_pending_at` 待删队列；
导出产物与大文件排行。

**建议**：`/admin → 存储`：占用统计（按工作区/桶/类型）、孤儿资产列表（含"为什么判定为孤儿"）、
待删队列、清理操作（软删→GC，二次确认 + 审计）。

### B6c 现状复核（2026-09-20，B6b 完成后动手前核对）

**清理路径已经存在，而且是完整的**，所以这一批**不应该新写删除逻辑**：

| 现有函数 | 作用 |
| --- | --- |
| `loomic_asset_has_live_references(p_asset_id)` | 判断素材是否还有活引用——**唯一可信的"是不是孤儿"判据** |
| `loomic_orphan_asset_claim(p_asset_id)` | 领取一个孤儿（返回 bucket/object_path），内部会复查引用 |
| `loomic_orphan_asset_finalize(p_asset_id)` | 对象删掉后收尾（删除 `asset_objects` 行） |
| `loomic_asset_gc_prepare_delete` / `loomic_asset_gc_claim` / `loomic_asset_gc_finalize` | 另一条更细的 GC 流程（`gc_eligible_at` / `gc_claim_token` / `gc_claimed_at`），带领取令牌 |
| `loomic_asset_is_usable(p_asset_object_id, p_workspace_id)` | 读取侧的可用性判定 |
| `cancel_asset_gc_on_reference` | 引用出现时取消 GC |
| `loomic_jsonb_has_asset_reference` | jsonb 字段里的引用（如画布文档）也算引用 |

**关键认识**：`asset_references`（当前 319 行 / 316 个素材）**不是唯一的引用来源**——
`design_resources.asset_object_id`、`skill_previews.asset_object_id`、`design_templates.preview_asset_object_id`、
画布文档 jsonb 等都指向 `asset_objects`。所以"孤儿"**必须**问 `loomic_asset_has_live_references`，
自己在 SQL 里 `LEFT JOIN asset_references` 判断会误删——这也正是 B4a 删除技能图片时只删记录、
把存储对象留给回收流程的原因。

当前副本规模（用于设计分页与默认窗口）：`workspace-assets` 5731 个对象 / 1370 MB，
`project-assets` 4 个（全部 `deletion_pending_at`），`gc_eligible_at` 非空的 3 个，已领取 0 个。

**B6c 的建议做法**：
1. **只读**（本批主要价值）：`admin_asset_overview`（按桶/scope/工作区聚合对象数、字节数、
   待删与待 GC 计数）、`admin_asset_orphans`（用 `loomic_asset_has_live_references` 判定，
   每条给出**判定理由**：无 `asset_references`、且无其它列引用、`deletion_pending_at` 是否已置）、
   `admin_asset_large_objects`（大文件排行）、`admin_asset_pending_queue`（待删/待 GC）。
2. **清理**（写）：只提供"把选中的孤儿交给**既有** `loomic_orphan_asset_claim` → 删对象 →
   `loomic_orphan_asset_finalize`"，并在同一个事务外记录审计；**不提供**任何绕过引用检查的删除。
   每条都要行内原因 + 确认（沿用平台后台约定）。
3. 界面：`/admin → 存储`：占用卡片（桶/工作区/类型）、孤儿表（带判定理由）、大文件排行、待删队列，
   清理动作只出现在孤儿表上。

---

## 八、Agent 运行时

**现在**：`agent_runs`、`agent_run_context_snapshots`、`agent_autonomy_preferences`、`agent_delegations`、
`agent_action_confirmations`、`agent_expert_model_snapshots/credentials`、`workspace_settings.default_model`；
用户侧有设置页与确认流程。平台总览没有这一块。

**缺**：运行失败 Top 原因（按 error_code/模型聚合）；运行耗时与 token 消耗分布；
待确认动作队列（是否有卡住的 confirmation）；自主性开关的默认值与分布；上下文预算触发率。

**建议**：`/admin → 运行健康`（只读为主）：失败 Top、慢运行、待确认积压、预算触发率；
写操作只有"清理过期确认"这类无副作用维护。

---

## 九、平台设置与审计

**现在**：没有任何平台级设置表；`platform_admins` 只能 SQL 授权；审计只有渠道配置一张表。

**缺**：
- `admin_audit_events`（第一部分就说过）：谁在什么时候对哪个对象做了什么、改前改后、原因、来源 IP/UA
- 平台级开关：注册开关、默认套餐、默认模型、维护公告、功能开关（现在散落在 env 与代码常量里）
- 审计查询页（按操作者/对象类型/时间筛选）+ 导出

**建议**：`/admin → 审计`（列表 + 筛选）+ `admin_audit_events` 迁移（所有写操作强制写入）；
平台设置只做**少量高价值项**（注册开关、默认套餐、维护公告），不要做成"什么都能改的配置面板"。

---

## 十、建议的分批顺序与进度

> **进度（2026-09-20 更新）**：**B1–B4 已全部完成并推送**（`7b05fa2` / `04d71b3` / `5c2e368` / `f7eee69` + `8fec24d`），
> 每批都有各自的实现记录：`docs/admin-console-b1-20260920.md`、`b2`、`b3`、`b4a`、`b4b`。
> 另外补了两个运维前置（**不在原计划里**）：平台管理员首次初始化 + PostgREST schema cache 检查，
> 见 `docs/admin-console-ops-bootstrap-20260920.md`。
> **B5 已拆成两批并全部完成**：**B5a（任务目录/详情/取消/死信处置）** 见 `docs/admin-console-b5a-20260920.md`，
> **B5b（渠道自检记录与按 error_code 的失败率）** 见 `docs/admin-console-b5b-20260920.md`。
> **B6 三批全部完成**：**B6a（首页内容管理）** 见 `docs/admin-console-b6a-20260920.md`；
> **B6b（设计目录缩略图 + 批量上下架）** 见 `docs/admin-console-b6b-20260920.md`；
> **B6c（存储健康与孤儿回收）** 见 `docs/admin-console-b6c-20260920.md`。
> **下一批 = B7（运行健康与平台设置）**。死信重放仍未做，等你拍板（决策点 3）。

| 批次 | 状态 | 内容 | 为什么这个顺序 | 风险 |
| --- | --- | --- | --- | --- |
| **B1 写操作地基** | ✅ 已完成 | `admin_audit_events` 迁移 + 审计写入约定 + 二次确认组件 + 平台管理员授予/撤销 | 后面所有写操作都依赖它；先把"谁能改、改了留痕"定死 | 低（多为新增表与只写审计） |
| **B2 用户与访问** | ✅ 已完成 | 平台用户目录/搜索/详情（工作区、用量、最后活跃）+ 跨工作区成员管理 | 不依赖计费改动，收益立刻可见 | 中（涉成员增删，需保护最后管理员） |
| **B3 套餐与额度** | ✅ 已完成 | 平台管理员改套餐/增减额度（原子 RPC + 原因 + 审计）+ 对账视图 | 你说了"先不动生图扣费"——本批只做**后台管理**，不改扣费链路与计费规则 | 中（涉及钱，必须原子 + 审计 + 二次确认） |
| **B4 技能管理与技能图片** ★ | ✅ 已完成（B4a 数据/服务端/后台 + B4b 用户侧展示） | 平台技能目录 + `skill_previews` + 上传/排序/发布 + 技能卡与详情展示 | 你点名要的；且它独立于计费，可与 B3 并行 | 中（新表 + 前台展示位） |
| **B5 任务与渠道** | ✅ 已完成（B5a + B5b） | **B5a**：任务按状态/类型/工作区/错误码/时间筛选 + 详情（尝试次数、上游错误、关联会话画布、额度流水、管理记录、payload 预览）+ 取消排队中任务 + 死信标记已处置 + 卡住识别。**B5b**：跨工作区渠道目录 + 渠道自检/配置记录 + 按 `error_code` 的失败率（归属走 `provider_execution_snapshots`，无渠道记录的失败显式计数）。**重放仍不在内** | 运维最常用；先做只读+取消/标记，把"要不要花钱重放"留给你决定 | 中（取消影响在途任务；重放另议） |
| **B6 内容与存储** | ✅ 已完成（B6a + B6b + B6c） | **B6a**：首页两个内容库（发现案例 + 示例）的分类、条目 CRUD、配图（URL）、排序与上下架。**B6b**：设计目录缩略图（服务端签短时 URL）+ 多选批量上下架。**B6c**：存储占用统计、孤儿候选（两层判定，只为当前页给权威结论）、待删/回收队列、大文件排行，清理走既有 orphan 回收流程（认领→删对象→收尾） | 内容维护可人工顶一阵；存储清理涉及删除，谨慎 | 中（删除类操作） |
| **B7 运行健康与平台设置** | 待做 | 运行失败 Top/慢运行/积压 + 少量平台开关 + 审计查询页 | 锦上添花，且需要先有前几批的数据沉淀 | 低 |

每批的固定纪律（沿用本仓现有约定）：全量 server/web 测试 + typecheck 通过、编码审计干净、
提交推送两条分支、必要时重启本地 API/worker；写操作一律"平台管理员 + 原子操作 + 审计 + 二次确认"。
新增/替换数据库函数后必须：**单独发一次 `NOTIFY pgrst, 'reload schema'` → 跑 `check:postgrest-schema` 确认可见**。

---

## 十一、需要你拍板的决策点

1. **技能图片的展示位**：只放技能卡/详情，还是也要进首页推荐位？（后者需要前台首页改动与图片审核口径）
2. **技能图片的权限**：我建议只允许平台管理员上传（示例图容易带用户数据）；是否同意？
3. **死信重放**：允许在后台一键重放吗？（会真实调用上游并可能计费）还是只允许"取消 + 标记"？
4. **账号停用/封禁**：需要吗？它会动到 auth 层（`auth.users`），与"不自研 auth"的边界相关。
5. **首页案例/发现内容**：以后由后台人工维护，还是继续脚本导入？（决定是做 CRUD 还是只做"查看 + 重新导入"）
6. **顺序**：是否按 B1→B4 走（先地基 + 用户 + 套餐 + 技能图片），任务/渠道/内容/存储放后面？

---

## 十二、明确不做（避免重复讨论）

- **自研登录注册 / 换掉 Supabase Auth**：160 处 `auth.uid()` + 136 条 RLS 策略的耦合，风险与收益不成正比；
  真要做得做成同构 JWT 兼容层 + 跨工作区越权回归用例。
- **聊天侧原生画板创建/导出**：你已明确"先不需要做"。
- **改扣费规则本身**（单价、档位额度、并发上限的计算口径）：本规划只做后台管理面，不动计费链路。
- **提示词库管理**：它是仓库内的静态目录（`features/prompt-library/prompt-library-service.ts` 词法检索），
  不是数据库内容，改它等于改代码发版，不需要后台页面。
