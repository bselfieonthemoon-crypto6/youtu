# 管理后台 B5b：渠道自检记录与失败率（2026-09-20）

承接总规划（`docs/admin-console-plan-20260920.md` 第四节）与 B5a。
本批补齐"渠道健康"这半：跨工作区渠道目录、单个渠道的自检与配置记录、按 `error_code` 的失败率。

> 说明：B5 到此为止（B5a 任务 + B5b 渠道）。**死信重放**仍不在任何一批里，按原规划单独决策。

## 一、数据库（迁移 `20260920000006_admin_channel_health.sql`，已应用并登记）

**三个只读函数**（都只授予 `service_role`，内部先 `private.is_platform_admin`）：

| 函数 | 作用 |
| --- | --- |
| `admin_channel_directory(actor, workspace, query, enabled, test_status, days, limit, offset)` | 跨工作区渠道列表：身份与地址、密钥尾号、模型数与模态、`last_tested_at/status/error_code`、窗口内任务/失败数与失败率、该渠道 Top 5 错误码；窗口内总量也一并返回 |
| `admin_channel_detail(actor, config_id, days, history_limit, job_limit)` | 单渠道：身份（含创建/修改人）、窗口计数、**自检与配置记录**（`workspace_provider_audit_events` 的 `created/updated/key_rotated/deleted/test_succeeded/test_failed`）、按错误码的失败分布、**最近的失败任务**（不受窗口限制） |
| `admin_channel_failure_rates(actor, days, limit)` | 平台级按 `error_code` 的失败率：失败数、失败/死信拆分、占全部失败的比例、涉及渠道数、最近一次；同时给出总量与两个失败率 |

### 归属口径：为什么不按任务里的模型名去猜渠道 ★

原规划的写法和我的第一版设想都是"用 `background_jobs.payload->>model` 关联 `workspace_provider_models.provider_config_id`"。
动手前先查了真实数据，结论是**这条链路不成立**：

1. `payload->>model` 是**展示用字符串**，实际取值有 `workspace:<uuid>`、`local:<name>`、以及裸的上游模型名三种形态，
   它并不是外键；
2. 就算取出 `workspace:<uuid>` 里的 uuid，本地副本里这些 id 在 `workspace_provider_models` 中**一条都查不到**
   （`isolation` 脚本重写过历史任务），线上同样会随模型删除而失配。

真正记录"这个任务由哪个渠道服务"的是运行时自己写的 `provider_execution_snapshots`（含 `background_job_id` 与
`provider_config_id`，`background_job_id` 有唯一约束、随任务级联删除）。所以三个函数都用它做归属，
并把 `payload->>model` 只当展示信息。**没有任何快照的失败（多为 `design_preview_stale` 之类的非上游失败）被显式计数为
"无渠道记录"**，而不是悄悄从分母里消失。

顺带明确了两个失败率的含义，界面上并排显示：
- **渠道可归属失败率** = 到过渠道的失败 / 到过渠道的任务（运维真正要看的"渠道掉链子的频率"）；
- **全部任务失败率** = 窗口内所有失败 / 所有任务（不把从未到渠道的失败藏起来）。

聚合里对 `(config, job)` 做了 `DISTINCT`：一个任务可能有多次尝试（多条快照），按尝试数统计会把失败率整体抬高。

## 二、服务端

- `features/admin/admin-channel-service.ts`：`assertActor` → 调 RPC → 把 `FORBIDDEN` / `UNKNOWN_CHANNEL`
  翻成 403 / 404。筛选值白名单（自检状态只接受 `never|succeeded|failed`，未知值当"不筛选"）；
  `days` 夹在 1–365、`limit` 1–200、`historyLimit`/`jobLimit` 1–100。
  **`enabled=false` 会被如实传下去**——用 `?? null` 会把它当成"未设置"，让想看"停用渠道"的人看到全部渠道。
- `http/admin-channels.ts`：
  - `GET /api/admin/channels`（workspaceId / query / enabled / testStatus / days / limit / offset）
  - `GET /api/admin/channels/failure-rates`（days / limit）——声明在参数路由之前，避免被当成渠道 id
  - `GET /api/admin/channels/:configId`（days / historyLimit / jobLimit）
  - 三个端点都是只读；参数不合法一律 400 `admin_invalid_request`，未知错误 500 且不泄漏内部消息。
- 服务端把 RPC 必需字段**原样透传**给契约解析，而不是给默认值兜底：函数一旦不再返回某个字段，
  会变成响亮的 500，而不是界面悄悄显示成 0。

## 三、前端

`/admin → 渠道健康`（仅平台管理员；该标签页最初叫「渠道与模型」，后来为避免与工作区级的「模型与渠道」混淆而改名）：筛选条（工作区 / 关键词 / 启用状态 / 自检状态 / 统计窗口）**点「查询」才发请求**；
- **失败率卡片**：两个失败率 + 无渠道记录的失败数 + 窗口内活跃渠道数，下面是错误码表（失败总数 / 失败 / 死信 / 占比 /
  涉及渠道 / 最近一次）。`design_preview_stale` 这类从未到渠道的错误码显示"无渠道记录"——这是一个结论，不是缺失值。
- **渠道表**：工作区、渠道（类型 + 密钥尾号 + 版本）、地址、启用状态、模型启用数/总数与模态、
  **自检状态与时间（失败时带错误码）**、窗口内任务数与失败数、失败率。
- **详情面板**：配置身份（创建人/修改人/时间）、自检与配置记录、窗口内错误码分布、最近失败任务。
  切换统计窗口时详情也按同一窗口刷新。
- 详情加载失败**不会**清空正在看的表格与失败率卡片（错误只落在详情面板里）。

## 四、验证

- 服务端新增 `admin-channel-service.test.ts`（9 例：非管理员在读取前被拒、
  筛选全量透传且 `enabled=false` 保持 false、窗口/页大小/偏移夹取、目录原样返回、
  畸形负载不被静默改写成 0、详情含历史与失败清单、未知渠道 404 与详情上限夹取、
  失败率与错误码明细、3 种拒绝码翻译不留原始消息）
  与 `admin-channels.test.ts`（9 例：3 个端点都要认证、目录筛选透传、
  **省略 enabled 与显式 false 的区别**、坏参数（含 `enabled=maybe`/`days=400`/`limit=500`）全部 400、
  `failure-rates` 不会被解析成渠道 id 且带自己的边界校验、详情成功、
  渠道 id 与详情上限的 400、404/403 映射、500 不泄漏内部消息）。
- Web 新增 `admin-channels-section.test.tsx`（8 例：渠道表含自检状态/模型数/失败率且未自检与无数据显示为 `—`、
  **两个失败率与"无渠道记录"标记**、筛选提交式触发（窗口同时驱动失败率卡片）、
  详情含自检与配置记录/错误码分布/最近失败、三种空态、目录失败后重试、
  **详情失败仍保留表格与失败率**、标签与格式化函数）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs` 的 B5b 段，全部只读、无需造数据）：
  渠道目录 5 个渠道（最忙的 BASE 350 条任务 / 失败 42 / 12.0%）→ 逐渠道校验
  `failureRate == failures/jobs` 与 `enabledModelCount <= modelCount` →
  失败率端点校验 `providerJobs == 目录 totalJobs`、`providerFailures == 目录 totalFailures`、
  `providerFailureRate == providerFailures/providerJobs`、每个错误码 `failed + deadLetter == failures`、
  占比在 0–1、涉及渠道数不超过渠道总数、且**确有错误码是"无渠道记录"**（本副本为 `design_preview_stale`）→
  筛选收窄（停用 1 个、名称命中、工作区过滤不漏）→ 5 + 2 组非法参数全部 400 →
  渠道详情（BASE 自检记录 5 条、错误码 7 类、最近失败 5 条，且最近失败都处于终态失败）→
  未知渠道 404 `admin_channel_not_found`、坏 id 400。
  目录与失败率两个视图对同一批任务的计数必须完全一致，这是本批最重要的回归断言。
- 全量：server / web 测试与两端 typecheck 全绿，编码审计干净；`check:postgrest-schema`（已把本批 3 个函数加入清单）确认 **23 个函数**在 schema cache 中可见。

## 五、有意不做

- **在后台改别人的渠道**（改地址、轮换密钥、启停模型）：一个平台管理员悄悄把某个工作区的流量改到别处，
  是比"看一眼"大得多的决定。规划里提过"模型启停 + 默认模型分布"，本批只做只读。
- **一键自检**：自检会真实请求上游并消耗配额，且已有工作区级入口（`ProviderSettingsSection`）。
  本批先把**自检记录与失败率**读出来；要不要在平台级触发、以及是否加频率限制，另开一批。
- **默认模型分布**（`workspace_settings.default_model`）：属于"模型与渠道"的另一半，留到运行健康/平台设置批次。
- **失败率的趋势曲线**：需要按时间分桶的历史序列，现在给的是窗口内的静态切片。
