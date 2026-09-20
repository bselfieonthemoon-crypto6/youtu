# 管理后台 B3：套餐与额度管理（2026-09-20）

承接 B1/B2 与总规划（`docs/admin-console-plan-20260920.md` 第二节"套餐与计费"）。
本批把**服务端根本不存在的能力**补上：在此之前，自托管安装若没接支付渠道，就完全无法改套餐或补额度
（`/api/credits/admin/set-plan` 是被刻意删除的，`http/credits-security.test.ts` 断言它保持 404）。

**不改动计费链路**：`deduct_credits`、`refund_credits`、档位守卫（tier guard）与生图扣费逻辑一行未动；
后台只通过同一本额度流水（`credit_transactions`）与同一张余额表（`credit_balances`）移动账户状态。

## 一、数据库（迁移 `20260920000003_admin_billing.sql`，已应用并登记）

三条函数，全部只授予 `service_role`：

**写**
1. `admin_set_workspace_plan(p_actor, p_workspace_id, p_plan, p_grant_credits, p_reason)`
   - 平台管理员校验 + 原因必填 + 工作区存在 + `0 ≤ 赠送额度 ≤ 1,000,000`
   - 订阅行与余额行按需 upsert（正常由工作区触发器创建），`credit_balances ... FOR UPDATE` 加锁，
     `version` 乐观锁递增，写入 `subscription_grant` 流水（金额 = 赠送额度，`description` = 操作原因）
   - 赠送 0 时不写流水（纯改档不动额度），但**一定**写审计
2. `admin_adjust_credits(p_actor, p_workspace_id, p_delta, p_reason)`
   - 同样的校验；`delta ≠ 0` 且 `|delta| ≤ 1,000,000`；**拒绝扣成负余额**（`INSUFFICIENT_BALANCE`）
   - 写 `admin_adjustment` 流水（`description` = 原因，`user_id` = 操作者），同一事务写审计

**读**
3. `admin_workspace_billing(p_actor, p_workspace_id, p_tx_limit)`
   - 工作区信息 + 套餐 + 余额 + 订阅窗口（周期/是否外部渠道/是否已取消）
   - 近 30 天扣费与退款总额；最近流水（含操作者邮箱，能看到"这是谁扣的"）
   - **对账**：`credits_cost` 与实际流水扣费不一致的任务（最近 20 条）。

审计动作：`workspace.plan.set`、`credits.adjust`（`target_kind=workspace`，含 before/after 的套餐与余额）。

## 二、服务端与前端

- `features/admin/admin-billing-service.ts`：调 RPC + 把 7 种拒绝码翻译成 HTTP
  （403 / 400 `admin_reason_required` / 400 `admin_invalid_amount` / 404 `admin_workspace_not_found` /
  409 `admin_insufficient_balance` / 409 并发冲突 / 500 兜底），从不上抛原始消息；
  畸形返回值不会变成 NaN。
- `http/admin-billing.ts`：
  - `GET /api/admin/workspaces/:workspaceId/billing?limit=`（1..100）
  - `POST /api/admin/workspaces/:workspaceId/plan`（套餐 + 可选赠送额度 + 原因）
  - `POST /api/admin/workspaces/:workspaceId/credits`（增减额度 + 原因）
  - 非法请求一律 400 `admin_invalid_request`。
- 前端新标签 **套餐与额度**（仅平台管理员）：
  - 顶部工作区选择器（复用 B2 的工作区目录接口）
  - 概览卡：当前套餐 + 该档位的月额度/并发/最高分辨率（来自 `PLAN_CONFIGS`）、余额、近 30 天扣费与退款、订阅来源
  - **修改套餐**：选档位 + 同时发放额度 + 原因 → 行内确认并明确写出"改为 X、发放 Y 额度、当前为 Z"
  - **增减额度**：正负数值 + 原因 → 行内确认并**先算出结果余额**（"余额将从 A 变为 B"）再执行
  - 最近额度流水表（类型/额度/余额/说明/操作者/关联任务）
  - 对账表：任务成本与流水不一致列表，空态明确写"没有发现不一致的任务"

## 三、验证

- 服务端新增 `admin-billing-service.test.ts`（7 例：非管理员在读之前被拒、流水条数上限收窄、
  套餐 RPC 参数与原因 trim、**畸形返回值不产生 NaN**、增减额度含负数、7 种拒绝码翻译、余额不足文案）
  与 `admin-billing.test.ts`（8 例：三个端点都要认证、对账字段透传、坏 uuid/limit 一律 400、
  套餐成功形状与 `grantCredits` 默认 0、未知套餐/原因过短/超额度的四种 400、
  增减额度双向 + **delta=0 被拒**、余额不足 409、500 不泄漏内部消息）。
- Web 新增 `admin-billing-section.test.tsx`（10 例：概览渲染、切换工作区重新加载、
  **改套餐必须填原因 + 行内确认后才调用**、取消不调用、**调整额度确认前显示结果余额**、
  零值本地即拦截、余额不足原话展示且面板仍可用、对账列表与空态、加载失败重试、空流水与标签/时间格式化）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs`）：
  读账单（套餐 free、余额 50）→ **改套餐 free→starter 并赠送 7** → 余额 50→57，
  流水出现 `subscription_grant` 且说明含操作原因 → **扣减 7** → 流水出现 `admin_adjustment`，余额回到 50
  → **扣成负余额被拒 409 `admin_insufficient_balance`** → `delta=0` 被拒 400 → 未知套餐被拒 400
  → **恢复原套餐**（余额回到起点）→ 审计含 6 条套餐/额度记录。
- 全量：server / web 测试与两端 typecheck 全绿，编码审计干净（见提交信息）。

## 四、踩到的坑与运维要点（重要）

**PostgREST 的 schema cache**：新建函数后即使 `NOTIFY pgrst, 'reload schema'` 也可能没有生效，
表现为 `PGRST202 Could not find the function ... in the schema cache` → HTTP 层就成了 500。
本次 B3 就是先踩到（迁移里已带 NOTIFY，但第一次没生效），**再单独发一次 NOTIFY 并等 5 秒后即恢复**。
排查脚本：`artifacts/probe-billing.mjs`（用 service role 直连 PostgREST 调 RPC，打印原始错误/数据）。
以后新增迁移的固定动作：应用 → 单独发一次 `NOTIFY pgrst, 'reload schema'` → 用探针确认函数可见。

## 五、有意不做

- **改计费规则本身**（单价、各档位月额度与并发的计算口径、扣费时机）：本批只做账户管理，不动计费链路。
- **外部支付渠道的对账**（Lemon Squeezy 订单/退款）：本批只展示"是否外部订阅"，不拉取外部账单；
  需要时单列一批（涉及外部 API 与幂等）。
- **批量调整**（一次给多个工作区发额度）：先做单工作区，避免一次误操作影响面过大。
