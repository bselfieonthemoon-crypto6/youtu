import type { AdminSupabaseClient } from "../../supabase/admin.js";

/**
 * Platform admin bootstrap.
 *
 * A fresh install has an empty `platform_admins`, so the operations console is
 * unreachable by design — there is no one to grant the first admin. Two things
 * exist here and deliberately NOT in a migration:
 *
 *   1. `warnIfNoPlatformAdmin`: a loud boot warning naming the exact command to
 *      run. Deployment must never silently promote someone.
 *   2. `bootstrapPlatformAdmin`: the explicit, idempotent action an operator runs
 *      once. It writes the grant and an audit row attributed to no actor (the
 *      system), and it refuses to run when an active admin already exists unless
 *      forced.
 *
 * Deliberately not a migration: a migration that promotes "the first workspace
 * owner" turns a deployment into a privilege escalation, and the same script would
 * then run against every environment.
 */

export type BootstrapOutcome =
  | { status: "already_bootstrapped"; platformAdmins: number }
  | { status: "granted"; userId: string; email: string | null }
  | { status: "unknown_user"; email: string }
  | { status: "no_candidate" };

type LooseAdmin = {
  from: (table: string) => any;
};

const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

/** How many active platform admins exist right now (0 means nobody can enter the console). */
export async function countActivePlatformAdmins(client: AdminSupabaseClient): Promise<number> {
  try {
    const { count, error } = await loose(client).from("platform_admins")
      .select("user_id", { count: "exact", head: true })
      .eq("is_active", true).is("revoked_at", null);
    if (error) throw new Error("platform_admin_count_failed");
    return Number(count ?? 0);
  } catch {
    // One error shape for callers: a driver failure must not escape raw.
    throw new Error("platform_admin_count_failed");
  }
}

/**
 * The line an operator needs to see. Kept as a pure function so the wording is
 * testable without a database.
 */
export function noPlatformAdminWarning(): string {
  return "[admin-bootstrap] 没有任何平台管理员：管理后台（平台总览/权限与审计/用户目录/套餐与额度/技能与图片）目前无人可访问。"
    + "请执行 `pnpm --filter @loomic/server bootstrap:platform-admin`；本地副本用 "
    + "`cd apps/server && node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/bootstrap-platform-admin.ts --email <你的账号邮箱>`。";
}

export async function warnIfNoPlatformAdmin(
  client: AdminSupabaseClient,
  logger: { warn: (message: string) => void },
): Promise<number> {
  try {
    const count = await countActivePlatformAdmins(client);
    if (count === 0) logger.warn(noPlatformAdminWarning());
    return count;
  } catch (error) {
    // A boot check must never prevent the server from starting.
    logger.warn(`[admin-bootstrap] 无法确认平台管理员数量，请手动检查 platform_admins：${(error as Error).message}`);
    return -1;
  }
}

/**
 * Grant the first platform admin (or a named account), idempotently.
 *
 * `email` is resolved through `profiles` exactly like the console's own grant
 * path. Without an email the earliest workspace owner is used, which is the
 * natural single-admin choice for a self-hosted install.
 */
export async function bootstrapPlatformAdmin(
  client: AdminSupabaseClient,
  options: { email?: string } = {},
): Promise<BootstrapOutcome> {
  try {
    return await runBootstrap(client, options);
  } catch (error) {
    // Keep the contract: only typed bootstrap errors escape, never a raw driver error.
    if (error instanceof Error && error.message.startsWith("platform_admin_bootstrap_")) throw error;
    if (error instanceof Error && error.message === "platform_admin_count_failed") throw error;
    throw new Error("platform_admin_bootstrap_failed");
  }
}

async function runBootstrap(
  client: AdminSupabaseClient,
  options: { email?: string },
): Promise<BootstrapOutcome> {
  const existing = await countActivePlatformAdmins(client);
  if (existing > 0) return { status: "already_bootstrapped", platformAdmins: existing };

  let target: { id: string; email: string | null } | null = null;
  if (options.email) {
    const normalized = options.email.trim().toLowerCase();
    const { data, error } = await loose(client).from("profiles")
      .select("id,email").ilike("email", normalized).limit(2);
    if (error) throw new Error("platform_admin_bootstrap_lookup_failed");
    const matches = (data ?? []) as Array<{ id: string; email: string | null }>;
    if (matches.length !== 1) return { status: "unknown_user", email: options.email };
    target = matches[0]!;
  } else {
    const { data, error } = await loose(client).from("workspaces")
      .select("owner_user_id,created_at").order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error("platform_admin_bootstrap_lookup_failed");
    const ownerId = (data as { owner_user_id?: string } | null)?.owner_user_id;
    if (!ownerId) return { status: "no_candidate" };
    const { data: profile } = await loose(client).from("profiles")
      .select("email").eq("id", ownerId).maybeSingle();
    target = { id: ownerId, email: (profile as { email?: string } | null)?.email ?? null };
  }

  const { error: grantError } = await loose(client).from("platform_admins")
    .upsert({ user_id: target.id, is_active: true, granted_at: new Date().toISOString(), revoked_at: null },
      { onConflict: "user_id" });
  if (grantError) throw new Error("platform_admin_bootstrap_grant_failed");

  // Audited like every other access change, with no actor: this one is the system.
  await loose(client).from("admin_audit_events").insert({
    actor_user_id: null,
    action: "platform_admin.bootstrap",
    target_kind: "user",
    target_id: target.id,
    reason: "首次初始化：授予第一位平台管理员",
    after: { isActive: true },
  });

  return { status: "granted", userId: target.id, email: target.email };
}
