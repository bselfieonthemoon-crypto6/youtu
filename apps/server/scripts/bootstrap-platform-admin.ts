// One-time platform admin bootstrap.
//
//   pnpm --filter @loomic/server bootstrap:platform-admin                 (earliest workspace owner)
//   cd apps/server
//   node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx \
//     scripts/bootstrap-platform-admin.ts --email you@example.com
//
// Run it from apps/server: `tsx` is a dependency of that package, so the loader
// cannot be resolved from the repository root.
//
// The service refuses to touch an install that already has an active platform
// admin, so this is safe to run twice: to grant someone else afterwards use the
// console's 权限与审计 tab, which is audited with a real actor.
import { bootstrapPlatformAdmin, countActivePlatformAdmins } from "../src/features/admin/platform-admin-bootstrap.js";
import { createAdminSupabaseClient } from "../src/supabase/admin.js";
import { loadServerEnv } from "../src/config/env.js";

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("--")) return argv[index + 1];
  const inline = argv.find(argument => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

const env = loadServerEnv();
const client = createAdminSupabaseClient(env);

const before = await countActivePlatformAdmins(client);
console.log(`[bootstrap] 当前活跃平台管理员：${before}`);

const email = flag("email");
const outcome = await bootstrapPlatformAdmin(client, { ...(email ? { email } : {}) });
if (outcome.status === "already_bootstrapped") {
  console.log(`[bootstrap] 已存在 ${outcome.platformAdmins} 位平台管理员，无需初始化；如需再授予请用管理后台的「权限与审计」。`);
} else if (outcome.status === "unknown_user") {
  console.error(`[bootstrap] 找不到邮箱对应的账号：${outcome.email}`);
  process.exitCode = 1;
} else if (outcome.status === "no_candidate") {
  console.error("[bootstrap] 没有可用于初始化的账号：请先用 --email 指定，或先注册一个账号。");
  process.exitCode = 1;
} else {
  console.log(`[bootstrap] 已授予平台管理员：${outcome.email ?? outcome.userId}（审计动作 platform_admin.bootstrap）`);
  console.log("[bootstrap] 现在可以登录管理后台的「权限与审计」继续授权其他人。");
}
// Set exitCode rather than calling process.exit(): exiting with the client's open
// handles still pending trips a libuv assertion on Windows.
