# 管理后台运维前置：首次初始化与 schema cache 检查（2026-09-20）

这两件事不是"新功能"，而是"装完能不能用 / 改完是不是真的生效"。都是 B3 踩坑后补的收尾。

## 一、平台管理员首次初始化（fresh install 的锁死问题）

**问题**：`platform_admins` 在新装里是空的 —— 没有人能进管理后台，而管理后台正是授权入口（鸡生蛋问题）。
本地副本当初就是手工 SQL 授的权，一次实测中我把唯一管理员改为停用，服务端日志立刻出现告警、`/api/admin/access`
返回 `platformAdmin=false`，验证了这个状态确实存在。

**做法（故意不写成迁移）**：把"第一个 workspace 所有者提升为平台管理员"写进迁移，等于把权限提升固化进部署流程，
而且会在每个环境自动执行。所以拆成两半：

1. **启动告警**（`apps/server/src/server.ts` → `warnIfNoPlatformAdmin`）：
   监听成功后检查活跃平台管理员数量，为 0 就 `WARN` 一条，里面**直接给出修复命令**；
   检查本身失败也只告警、不影响启动。
2. **显式一次性命令**（`apps/server/src/features/admin/platform-admin-bootstrap.ts` + CLI）：
   - `pnpm --filter @loomic/server bootstrap:platform-admin`（默认取**最早的 workspace 所有者**）
   - 或指定账号：`cd apps/server && node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/bootstrap-platform-admin.ts --email <邮箱>`
   - 幂等：**已存在活跃管理员时拒绝执行**（要再授予请走后台「权限与审计」，那里的审计有真实操作者）
   - 授予时写一条审计：`action=platform_admin.bootstrap`、`actor_user_id=null`（系统）、原因"首次初始化…"
   - 邮箱找不到或匹配到多个账号时**拒绝并退出 1**，不猜账号

**实测（本地副本）**：把唯一管理员停用 → 0 位 → 重启 API → 日志出现
`[admin-bootstrap] 没有任何平台管理员…`（含修复命令）→ 执行 CLI `--email 765966283@qq.com`
→ `已授予平台管理员` + 审计行 `platform_admin.bootstrap`（系统操作者）→ 管理后台恢复可访问
（`access: platformAdmin=true`），随后整套管理后台冒烟脚本重新全绿。

## 二、PostgREST schema cache 检查（"迁移生效了但接口 500"）

**问题**：新增/替换函数后，PostgREST 只有在 reload 之后才认得它。迁移里写 `NOTIFY pgrst, 'reload schema'`
**也可能没生效**（B3 就是这样：接口 500，底层 `PGRST202 Could not find the function ... in the schema cache`，
看起来像产品 bug）。补发一次 NOTIFY 并等几秒即恢复。

**做法**：`apps/server/scripts/check-postgrest-schema-cache.mjs`
- 不需要任何参数：读取 PostgREST 的 OpenAPI 文档（`GET /rest/v1/`）并检查 16 个管理后台函数是否都在
  `/rpc/<name>` 路径里——纯粹是"服务端是否认得这个函数"，不依赖试调用
- 缺失时打印缺哪几个 + 修复命令（`NOTIFY pgrst, 'reload schema';`）+ 报错底层码，**退出 1**
- `pnpm --filter @loomic/server check:postgrest-schema`
- 实测：本地副本 16 个函数全部可见（`[postgrest-schema] 16 个函数在 schema cache 中可见。`）

**迁移应用流程（以后照这个走）**：
1. 应用迁移（`psql -f` 或既有 apply 脚本）
2. **单独**执行一次 `NOTIFY pgrst, 'reload schema';`
3. 跑 `check:postgrest-schema` 确认函数可见
4. 再跑接口冒烟（`artifacts/admin-console-smoke.mjs`）与全量测试

## 三、两个踩坑记录（避免重复调试）

- **不要在仓库根目录用 `--import tsx`**：`tsx` 是 `apps/server` 的依赖，根目录解析不到，会报
  `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`。要么用 pnpm 脚本，要么 `cd apps/server` 再跑。
- **CLI 里不要 `process.exit()`**：supabase-js 还有未关闭句柄时退出会触发 Windows 上的
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（退出码 `-1073740791`，看起来像崩溃）。
  统一改成 `process.exitCode = N`，让 Node 自然退出。
