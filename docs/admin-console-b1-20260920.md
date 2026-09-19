# 管理后台 B1：写操作地基（2026-09-20）

规划见 `docs/admin-console-plan-20260920.md`。B1 是后续所有管理写操作的地基：
**审计表 + 原子 RPC + 平台管理员授权界面 + 二次确认**。不改登录注册、不改任何 RLS 策略、不动计费链路。

## 一、为什么先做 B1

在 B1 之前，整个平台只有一张审计表（`workspace_provider_audit_events`，只管渠道配置），
而"谁能改什么"完全没有约定；平台管理员只能用 SQL 授权，且**撤销最后一个管理员会把安装锁死**（没有任何保护）。
B1 把这三件事一次定死，后面的用户/套餐/技能写操作直接套用同一套规则。

## 二、数据库（迁移 `20260920000001_admin_write_foundation.sql`）

### `public.admin_audit_events`
| 列 | 说明 |
| --- | --- |
| `actor_user_id` | 操作者（`auth.users.id`，可空表示系统） |
| `action` | 稳定动作 id：`platform_admin.grant` / `platform_admin.revoke` / 后续 `workspace.plan.set`、`credits.adjust`、`skill.preview.publish` … |
| `target_kind` / `target_id` | 被操作对象（`user` / `workspace` / `skill` / `job` / `provider_config` …） |
| `workspace_id` | 相关工作区（可空） |
| `reason` | 必填原因（≤500 字符） |
| `before` / `after` | 改动前后快照（jsonb） |
| `created_at` | 时间 |

- **FORCE ROW LEVEL SECURITY 且不建任何 policy**：只有 service role 能读写，任何工作区成员都无法通过 PostgREST 读到平台操作日志。
- 三个索引：时间倒序、`(target_kind,target_id,时间)`、`(actor_user_id,时间)`。

### 两个原子 RPC
- `admin_grant_platform_admin(p_actor_user_id, p_user_id, p_reason)`
- `admin_revoke_platform_admin(p_actor_user_id, p_user_id, p_reason)`

两者都在**同一事务**内：校验操作者是活跃平台管理员（`private.is_platform_admin`）→ 校验目标/原因 →
改 `platform_admins` → 写 `admin_audit_events`。撤销额外做两件事：
`pg_advisory_xact_lock` 串行化并发撤销，并**拒绝移除最后一个活跃平台管理员**
（这同时覆盖"只有你一个管理员时撤销自己"）。

权限：`REVOKE ALL FROM PUBLIC` + 只 `GRANT EXECUTE TO service_role`。

> **运维注意**：新建/替换函数后必须 `NOTIFY pgrst, 'reload schema';`，否则 PostgREST 的 schema cache
> 里没有这个函数，调用会返回 `Could not find the function ... in the schema cache`。
> 本次就是先踩到这一点（表现为 500），补了 notify 才通。本地副本已执行并已在 `schema_migrations` 登记 `20260920000001`。

## 三、服务端

- `features/admin/admin-access-service.ts`：授权判定 → 解析邮箱 → 调用 RPC → 回读视图；
  把数据库拒绝码翻译成 HTTP：`FORBIDDEN`→403、`UNKNOWN_USER`→404、`NOT_PLATFORM_ADMIN`→404、
  `LAST_PLATFORM_ADMIN`→409、`REASON_REQUIRED`→400，其余→500，**从不上抛原始数据库消息**。
- `features/admin/platform-admin.ts`：唯一的"是否活跃平台管理员"判据（`is_active` **且** `revoked_at IS NULL`），
  总览、访问管理、RPC 内部三处共用同一语义。
- 路由 `http/admin-access.ts`：
  - `GET /api/admin/platform-admins`（列表）
  - `POST /api/admin/platform-admins`（按邮箱授权，原因必填，201）
  - `DELETE /api/admin/platform-admins/:userId`（撤销，原因必填）
  - `GET /api/admin/audit?limit=&targetKind=&targetId=`（只读，limit 1..200）
  - 请求体校验失败一律 **400 `admin_invalid_request`**（不合法请求是调用方的错，不该是 500）。

## 四、前端

`/admin → 权限与审计`（只对平台管理员显示，与「平台总览」同一 `platformAdmin` 探测）：

- **平台管理员**：列表（账号/显示名/授权时间/是否自己）→ 按邮箱授予（邮箱 + 原因，原因 <2 字符按钮禁用）
  → 撤销采用**行内二次确认**：点"撤销"后该行出现原因输入框与"确认撤销/取消"，原因为空不能提交。
  服务端拒绝（例如最后一个管理员、邮箱不存在）时把原话显示出来，且**不**把该行从列表里移除。
- **操作审计**：最近 50 条，展示时间/动作/对象/操作者/原因；空态、`系统`（无操作者）、
  未知动作与未知对象类型都有兜底文案；时间按 `Asia/Shanghai` 固定格式化。

选择行内确认而不是弹窗，是为了让"原因"始终贴着它所作用的那个账号，也便于测试覆盖。

## 五、验证

- 服务端测试新增 `admin-access-service.test.ts`（8 例：非管理员在写之前就被拒、只列活跃管理员、
  按邮箱授权并透传 RPC 参数、邮箱不存在/歧义、**六种数据库拒绝码逐一翻译且不泄漏原文**、
  审计列表的 actor/工作区解析、limit 收窄）与 `admin-access.test.ts`（8 例：四个端点都要认证、
  201/400/409/500 的语义、审计筛选与 limit 边界）。
- Web 测试新增 `admin-access-section.test.tsx`（11 例：列表与"（你）"标记、原因不足禁用提交、
  服务端拒绝原话展示、撤销必须行内确认且原因必填、最后一个管理员被拒后该行仍在、取消不调用服务端、
  加载失败重试、审计渲染/空态/系统操作者/未知动作/时间格式化），并扩展 `admin-page.test.tsx`（7 例：
  平台标签只对平台管理员显示、探测失败不影响工作区管理）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs`，产物目录不入库）：
  `platformAdmin=true` → 授予真实第二账号（201，审计出现 `platform_admin.grant` 且原因逐字一致）→
  列表 2 人 → 撤销（审计出现 `platform_admin.revoke`）→ 列表回到 1 人 →
  **撤销最后一个管理员被拒 409 `admin_last_platform_admin`** → 原因过短 400 `admin_invalid_request`。
  全过程只改了 `platform_admins` 与审计表，未触碰其他数据。
- 全量：服务端 **251 文件 / 2000 测试**、Web **122 / 809**、两端 typecheck、编码审计（见提交信息）。

## 六、下一批（B2）预告与约束

B2 = 平台级用户目录与跨工作区成员管理，写在 B1 的规则上：**平台管理员 + 原子 RPC（含审计）+ UI 二次确认**。
届时会把 `target_kind=user|workspace` 的审计动作补齐（`workspace.member.add/remove/role`），
并复用本批的 `admin_audit_events` 与错误翻译方式；不再新造第二套审计机制。
