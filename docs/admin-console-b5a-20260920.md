# 管理后台 B5a：任务目录、详情与处置（2026-09-20）

承接总规划（`docs/admin-console-plan-20260920.md` 第三节）与 B1–B4b。
本批解决**第三节**里最常用的那半：任务按条件筛选、看单个任务的完整上下文、取消排队中的任务、把死信标记成"已处置"。

> 说明：B5 拆成两半。**B5a（本批，已完成）**= 任务目录 / 详情 / 取消 / 死信处置 + 卡住识别；
> **B5b（下一批）**= 渠道自检记录与按 `error_code` 的失败率。
> **死信重放不在本批、也不在 B5b**：它会真实调用上游并可能计费，按原规划留给你单独拍板（决策点 3）。

## 一、数据库（迁移 `20260920000005_admin_jobs.sql`，已应用并登记）

**四个函数**（全部只授予 `service_role`，内部先 `private.is_platform_admin` 再干活）：

| 函数 | 作用 |
| --- | --- |
| `admin_job_directory(actor, status, job_type, workspace_id, error_code, since, limit, offset, stuck_running_min, stuck_queued_min)` | 一次往返拿到"总数 + 当页任务"：状态 / 类型 / 工作区 / 错误码 / 时间五个筛选、`queued` 超 30 分钟或 `running` 超 15 分钟标记 `stuck`、附带该任务最新一次处置记录 |
| `admin_job_detail(actor, job_id, preview_chars)` | 单任务全貌：关联会话与画布、尝试次数、上游错误、`payload`/`result` 的**有界文本预览**（200–8000 字符）、额度流水、全部管理操作记录 |
| `admin_cancel_job(actor, job_id, reason)` | 取消：只改 `status`/`canceled_at` 并写 `error_code='admin_canceled'`；已是终态则拒绝 |
| `admin_acknowledge_job(actor, job_id, reason)` | 标记已处置：只在终态任务上写一条审计；**没有新列** |

三条设计边界，都是刻意的：

1. **取消只翻状态，不发明计费。** 退款对账与终态结算仍由既有机制负责（`credits_transactions` 的退款路径、
   worker 的终态 settle）。后台取消与用户侧取消走的是同一条语义，不会出现"后台取消了但钱不退"的新规则。
2. **"已处置"是派生状态。** 该任务最新的一条 `job.failure.acknowledge` 审计行**就是**状态本身——
   列表与历史因此不可能互相矛盾，也不会因为漏更新某一列而说谎。标记已处置不改变任务状态（死信仍然是死信）。
3. **不返回整份 payload。** 目录里只给 `title`/`model` 两个键，详情里给有界文本预览：既能读懂请求，又不会把
   用户的大 payload 整份搬进浏览器或日志。

审计动作：`job.cancel`、`job.failure.acknowledge`（`target_kind='job'`，`target_id` 是任务 id 文本，
`before/after` 记录状态变化与原因）。

### 一个被真实数据抓出来的缺陷（已修）

`admin_job_detail` 第一版漏了 `acknowledgedAt` / `acknowledgedByEmail` / `acknowledgeReason` 三个字段，
而共享契约 `adminJobDetailResponseSchema` 要求它们、详情面板也要显示它们。
单测用的是假 RPC 返回值，所以**全部通过**；是真实数据端到端自检在第一次运行时把它打成 500
（路由里 `schema.parse` 抛错 → 500），并顺带暴露出"详情面板的『处置』一栏永远是 `—`"这个 UI 现象。
修法是给详情函数补上与目录**同一个** `LATERAL` 派生视角（复用同一份 SQL，两处不会漂移），
重新应用迁移 + `NOTIFY pgrst, 'reload schema'`，并补了一条 web 用例锁住"详情面板读得到处置状态"。

## 二、服务端

- `features/admin/admin-job-service.ts`：`assertActor`（先查平台管理员）→ 调 RPC → 把数据库错误
  （`FORBIDDEN` / `REASON_REQUIRED` / `UNKNOWN_JOB` / `ALREADY_TERMINAL` / `NOT_TERMINAL`）翻成
  403 / 400 / 404 / 409 / 409 的 `AdminJobError`。筛选值只接受契约里列出的状态与类型（白名单），
  未知值当"不筛选"而不是报错；`sinceHours` 上限一年；`limit` 夹在 1–100。
- `http/admin-jobs.ts`：
  - `GET /api/admin/jobs`（status / jobType / workspaceId / errorCode / sinceHours / limit / offset）
  - `GET /api/admin/jobs/:jobId`
  - `POST /api/admin/jobs/:jobId/cancel`、`POST /api/admin/jobs/:jobId/acknowledge`（都要 reason，2–500 字符）
  - 取消成功后**顺带触发既有的终态 settle**（与用户侧取消同一个注入的 hook），让聊天卡片与画布占位图
    立刻收敛；settle 抛错只记日志、不影响已经落库的取消结果（恢复扫描会补做）。
  - 参数不合法一律 400 `admin_invalid_request`，未知错误 500 `admin_write_failed`（不泄漏内部消息）。

## 三、前端

`/admin → 任务`（仅平台管理员）：筛选条（状态 / 类型 / 工作区下拉 / 错误码 / 时间范围）**点「查询」才发请求**，
不是每次改选都打一次接口；表格显示状态、类型、工作区、发起人、尝试次数、错误码与**卡住徽标**（含已排队多久）；
点「详情」展开面板：关键时间点、尝试次数、会话 / 画布、上游错误原文、额度流水、管理操作记录、
`payload` / `result` 预览；终态任务给「标记已处置」，在途任务给「取消任务」，
两者都是**行内原因 + 确认**（原因不足 2 个字符时确认按钮禁用），成功后刷新列表与详情。

## 四、验证

- 服务端新增 `admin-job-service.test.ts`（9 例：非管理员在读之前被拒、五个筛选与 limit/offset 夹取、
  未知状态不当筛选、时间窗换算、RPC 参数与 reason trim、5 种数据库错误码翻译、详情不存在为 404）
  与 `admin-jobs.test.ts`（11 例：4 个端点都要认证、limit/offset/sinceHours/workspaceId 的边界拒绝、
  真实筛选参数透传、详情成功与 404、取消成功路径**包含终态 settle 被调用**、settle 抛错不影响取消结果、
  拒绝码映射、500 不泄漏内部消息）。
- Web 新增 `admin-jobs-section.test.tsx`（10 例：列表含错误码 / 尝试次数 / 卡住徽标、筛选提交式触发、
  详情含尝试与上游错误与流水与管理记录、**详情读得到派生处置状态**、取消需行内原因 + 确认、
  处置需原因 + 确认、服务端拒绝后保留面板与提示、加载失败重试）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs` 的 B5a 段）：在真实工作区里造 4 条一次性任务
  （一条取消用、一条留在途用于拒绝路径、一条 45 分钟前的排队任务用于卡住识别、一条死信用于处置）：
  工作区 + 类型筛选命中全部 4 条 → 错误码筛选恰好 1 条 → `status=dead_letter` 命中而 `status=queued` 不命中 →
  24 小时窗口仍包含刚建的任务 → **45 分钟的排队任务被判为卡住，新任务不受影响** →
  三个非法筛选（`limit=0` / `sinceHours=-1` / 非 UUID 工作区）都 400 →
  详情带 payload 预览、流水为空、审计为空 → 未知任务 404 →
  **取消成功**（`queued → canceled`，`canceled_at` 与 `error_code=admin_canceled` 到位，审计含 `job.cancel`）→
  **重复取消 409 `admin_job_already_terminal`** → 原因过短 400 → **对在途任务标记处置 409 `admin_job_not_terminal`** →
  取消未知任务 404 → **标记死信成功**（列表里 `acknowledgedAt`/`acknowledgeReason` 派生到位，状态仍是 `dead_letter`）→
  审计含 `job.cancel` 与 `job.failure.acknowledge` → 脚本删除 4 条自检任务与它们产生的审计行。
  自检还会**先清掉上次崩溃残留**的同名任务，所以重复运行的结果是确定的。
- 全量：server **260 文件 / 2087 例**、web **127 文件 / 858 例**、两端 typecheck 全绿，编码审计干净；
  `check:postgrest-schema` 报 16 个函数在 schema cache 中可见。

## 五、有意不做

- **死信重放**：会真实调用上游并可能计费，按原规划单独决策，本批只做"取消 + 标记已处置"。
- **队列 / realtime 消费者健康卡片**：原规划把它和任务列表放在一起，但它读的是 pgmq 与消费者表，
  与"任务处置"是两套数据；放进 B5b 之后的运行健康批次更合适。
- **按成员维度统计任务与消耗**：属于 B2 用户目录的加深，不在本批。
- **批量处置**：先保证单条操作的原因与审计路径正确，批量等有真实需求再做。
