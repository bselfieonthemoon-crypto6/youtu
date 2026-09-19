# 平台只读管理后台（2026-09-20）

## 一、这次做了什么

在**已有的 `/admin` 页面**里加了一个 **「平台总览」** 标签页，只读展示整个安装的运行状况：
跨工作区与成员、额度与计费、任务与死信、模型与渠道健康、技能启用情况。

前端位置：`apps/web/src/app/(workspace)/admin/page.tsx` 的 `overview` 标签 →
`apps/web/src/components/admin/admin-overview-section.tsx`。
后端：`apps/server/src/http/admin-overview.ts` + `apps/server/src/features/admin/admin-overview-service.ts`，
契约在 `packages/shared/src/admin-overview-contracts.ts`。

**没有**改登录注册、**没有**改任何 RLS 策略、**没有**动计费逻辑——这正是当初评估"换本地 auth"
风险最高、收益最低的部分，本批刻意绕开。

## 二、鉴权（服务端才是控制点）

- 角色表是既有的 `public.platform_admins`（`is_active` + `revoked_at`）。
  判据统一在 `apps/server/src/features/admin/platform-admin.ts`：
  `user_id = 我 AND is_active = true AND revoked_at IS NULL`。
  （既有的目录服务只判 `revoked_at IS NULL`，会漏掉"已停用但未撤销"的行，所以没有复用它。）
- `GET /api/admin/access` → `{ platformAdmin: boolean }`：给**页面**决定要不要显示标签页，200 恒定。
- `GET /api/admin/overview` → 聚合数据；非平台管理员直接 **403 `platform_admin_required`，且不构造任何数据**
  （测试断言 `overview()` 根本没被调用）。隐藏标签页从来不是权限控制。
- 401 / 403 / 500 的响应体只有 `{ error: { code, message } }`，不含内部细节（有测试断言不泄漏 `relation does not exist`、`kaboom`）。

## 三、数据口径（为什么这些数字可以被相信）

- **能精确计数的就精确计数**：任务状态（6 种）、任务类型（6 种）、工作区类型、技能分类，
  全部用 `{ count: "exact", head: true }`，不抽样。
- **需要全表求和的用有界分页扫描**：余额合计、套餐分布、模型与安装计数。
  页大小 500（低于 PostgREST 常见的 1000 行上限——扫描靠"这一页是否满"判断结束，
  页大小贴到上限会提前收尾并少算），最多 20 页；**触顶时该分区返回 `truncated: true`**，
  页面显示"部分统计已达扫描上限，数字可能不完整"，而不是给一个看起来完整的错数。
- **有界列表**：工作区与渠道各最多 50 行，失败任务与额度流水各最多 20 行，
  每条上游错误文本截断到 300 字符。本地实测整包约 **26KB**。
- 工作区名解析不到时显示「未知工作区」，不显示 uuid；`subscriptions` 是 `UNIQUE(workspace_id)`，
  没有订阅行的工作区归入免费档，所以套餐分布之和等于工作区总数（本地实测 34+1+1+1 = 37 ✓，
  与 `workspaces.total` 一致；任务状态之和 870+20+553 = 1443 与 `jobs.total` 一致 ✓）。
- 错误码与上游原文只在这张内部表里出现，**不会**进入面向用户的任何文案
  （客户侧文案规范见 `docs/agent-sim-optimization-20260919.md` 第六节）。

## 四、如何授予平台管理员（重要：现在默认没人是）

`platform_admins` 在本副本里**是空的**，也就是说安装完成后没有任何人能看到「平台总览」。
这不是 bug，而是当初就没有 bootstrap 入口。目前建议：

```sql
-- 授予（把 <user-id> 换成 auth.users.id；本地 QA owner 为
-- 541006fa-d2a1-4305-be55-b6263c27a1e3）
insert into public.platform_admins (user_id, is_active, granted_at)
values ('<user-id>', true, now())
on conflict (user_id) do update set is_active = true, revoked_at = null;

-- 撤销
update public.platform_admins
set is_active = false, revoked_at = now()
where user_id = '<user-id>';
```

本地副本已经执行过上面的授予语句，所以你可以直接在 `/admin` 看到「平台总览」标签。
**生产/自托管环境由你决定授权方式**（手动 SQL 最稳，或第二个管理员由第一个在后台授予）。
不建议在迁移里自动把"第一个工作区所有者"提升为平台管理员：那是把权限提升写进部署脚本。

## 五、验证

- 服务端：`pnpm --filter @loomic/server test` → **249 文件 / 1984 测试**全绿；
  `typecheck` 全绿。新增 `admin-overview-service.test.ts`（11 例：鉴权判据、精确计数、
  名称/套餐回退、截断语义、跨页求和、损坏客户端 fail-closed）与
  `admin-overview.test.ts`（7 例：401/403/500、403 不构造数据、不泄漏内部信息）。
- Web：`pnpm --filter @loomic/web test` → **121 文件 / 797 测试**全绿；`typecheck` 全绿。
  新增 `admin-overview-section.test.tsx`（8 例：渲染、死信、流水符号、渠道健康、
  截断提示、空态、失败重试、格式化），并扩展 `admin-page.test.tsx`（6 例：平台标签只对平台管理员显示、
  探测失败不影响原有工作区管理）。
- **真实数据端到端**：重启 API 后调用两个端点（脚本见 `artifacts/admin-console-smoke.mjs`，
  产物目录不入库），`platformAdmin=true`、`/api/admin/overview` 200 且通过共享 schema 校验，
  真实副本数据（37 工作区 / 1443 任务 / 553 死信 / 23530 额度 / 5 渠道 / 17 模型 / 16 技能）逐项自洽。

## 六、本批刻意不做的（写下来避免重复讨论）

- **写操作**（改套餐、停用渠道、重放死信、删除工作区）：只读批不混入写权限；
  要加时按"每个写操作单独端点 + 单独审计字段 + 确认对话框"来做。
- **换掉 Supabase Auth / 自研登录注册**：风险集中在 160 处 `auth.uid()` 与 136 条 RLS 策略，
  不是"本地化"的必要条件；真要做得做成同构 JWT 的兼容层，并配跨工作区越权回归用例。
- **跨工作区任务钻取与分页/搜索**：先看总量与最近失败；需要时再加 `?workspaceId=&status=&cursor=`。
- **成员明细与个人用量排名**：涉及更多个人信息，等有明确运营需求再做。
