# 管理后台 B2：平台级用户目录与跨工作区成员管理（2026-09-20）

承接 B1（`docs/admin-console-b1-20260920.md`）与总规划（`docs/admin-console-plan-20260920.md`）。
本批解决的是规划第一节"用户与访问"的核心缺口：**平台方看不到全站账号，也不能给别的工作区加人**。

## 一、这一批做了什么

**数据库**（迁移 `20260920000002_admin_user_directory.sql`，已应用到本地副本并登记）

读：
- `admin_user_directory(p_actor, p_query, p_user_id, p_limit, p_offset)` →
  按邮箱/昵称搜索（也可按 user id 精确取一行），每行带：账号信息、是否平台管理员、
  **所属工作区（名称/类型/角色）**、**最后活跃时间**、近 30 天运行数/任务数/消耗额度、总数。
  用 SQL 一次算完，是因为这些聚合如果走 PostgREST 就是 N+1。
- `admin_workspace_directory(p_actor, p_query, p_limit)` → 工作区选择器（名称搜索 + 成员数）。

写（都要求原因，且**审计行与改动同事务**）：
- `admin_add_workspace_member(p_actor, p_workspace_id, p_user_id, p_role, p_reason)`
- `admin_set_workspace_member_role(...)`
- `admin_remove_workspace_member(...)`

三条写路径的共同规则：
1. `private.is_platform_admin(p_actor)` 再查一次（HTTP 层的检查只是纵深之一）。
2. 原因必填（<2 字符直接拒绝）。
3. **不能授予或改动 `owner`**：后台不提供所有权移交，`owner` 的成员身份不可改、不可删
   （与工作区级既有的 `member_owner_immutable` 保持一致；移交所有权是独立的产品决策）。
4. 审计动作 `workspace.member.add` / `workspace.member.role` / `workspace.member.remove`，
   带 `before/after`（角色）与 `workspace_id`，所以审计页能显示"在哪个工作区动了谁"。

**服务端**
- `features/admin/admin-user-service.ts`：调 RPC + 把 9 种数据库拒绝码翻译成 HTTP
  （`FORBIDDEN`→403、`REASON_REQUIRED`→400、`UNKNOWN_USER`/`UNKNOWN_WORKSPACE`/`NOT_MEMBER`→404、
  `ALREADY_MEMBER`/`OWNER_IMMUTABLE`→409、`INVALID_ROLE`→400，其余→500），从不上抛原始消息。
- `http/admin-users.ts`：
  - `GET /api/admin/users?query=&userId=&limit=&offset=`（limit 1..100）
  - `GET /api/admin/workspaces?query=&limit=`
  - `POST|PATCH|DELETE /api/admin/workspaces/:workspaceId/members[/:userId]`
  - 请求体用共享 schema 校验（`userId` 必须是真 UUID、角色只能是 admin/member、原因必填），
    不合法一律 400 `admin_invalid_request`。

**前端**：`/admin → 用户目录`（仅平台管理员可见，与「平台总览」「权限与审计」同一探测）
- 搜索（提交时查询，不逐键打服务器）+ 列表：账号、所属工作区与角色、近 30 天任务数/额度消耗、最后活跃、是否平台管理员。
- 选中账号后的「成员管理」面板：所属工作区列表 + 「加入工作区」（工作区选择器可搜索、
  已加入的不再出现在下拉里、角色 + 原因必填）+ 「改角色」/「移出」都采用**行内二次确认 + 原因**；
  `owner` 行直接显示"所有者（后台不可改）"且不给按钮。
- 服务端拒绝（例如所有者不可移出）时把原话显示出来，并**保持该行不变**。
- 顺带把原来的工作区级标签 `用户管理` 改名为 `本工作区成员`，避免与平台级「用户目录」混淆。

## 二、验证

- 服务端新增 `admin-user-service.test.ts`（8 例：非管理员在任何读写之前被拒、搜索/分页/userId 过滤透传、
  页大小收窄与负 offset 归零、**畸形 JSON 负载不产生 NaN**、RPC 参数与原因 trim、
  **9 种拒绝码逐一翻译且不泄漏原文**、角色标签）与 `admin-users.test.ts`
  （9 例：五个端点都要认证、目录与筛选、坏分页/uuid/limit 一律 400、
  201/200 的成功形状、**owner 角色在新增与改角色两条路径都被拒**、坏 id/角色/原因、
  拒绝码映射、500 不泄漏内部消息）。
- Web 新增 `admin-users-section.test.tsx`（11 例：列表与活跃度、提交式搜索、默认选中与详情、
  所有者行无操作按钮、加入工作区（原因必填 + 已加入工作区不再出现在下拉）、
  服务端拒绝原话展示、改角色行内确认、移出行内确认与失败后保留行、成功移出、
  取消不调用服务端、加载失败重试、空态与标签/时间格式化），并扩展 `admin-page.test.tsx`。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs`）：
  目录 `total=37` 且每行带工作区名单 → 按邮箱搜索命中 1 个账号 → 选择一个该账号尚未加入的工作区
  → **加入 201** → **改角色 200 且目录立即显示 admin** → **移出 200 且目录不再有该工作区**
  → 审计含 `workspace.member.add/role/remove` 三条且都带工作区名 →
  **后台授予 owner 被拒（400）** → **移除工作区所有者被拒（409 `admin_owner_immutable`）**。
  结束时该临时成员关系已被移除，副本状态回到原样（只留下审计记录）。
- 全量：服务端 / Web 测试与两端 typecheck 全绿，编码审计干净（见提交信息）。

## 三、有意不做（避免后续重复讨论）

- **所有权移交**：后台不提供把工作区 owner 换成别人。它涉及 `workspaces.owner_user_id`、
  计费归属与旧 owner 的资产可见性，需要单独设计（B3 之后可单列一批）。
- **停用/封禁账号**：会动 `auth.users`（登录层），与"不自研 auth"的边界相关，等单独决策。
- **用户详情里的活动明细**（最近任务/运行列表）：本批只给聚合数字与工作区名单；
  需要时在 B5（任务与渠道）里用现成的任务筛选接口按用户过滤。
- **把成员变更同步踢掉在线连接**：工作区级服务会调 `onMembershipInvalidated` 让本实例的 socket 立刻失效；
  后台路径目前依赖数据库触发器那条既有链路。若实测发现后台移出成员后对方仍在线，再补这一句。
