// PostgREST schema-cache check.
//
//   node --env-file=artifacts/local-replica-20260907/app.env \
//     apps/server/scripts/check-postgrest-schema-cache.mjs [fn ...]
//
// Why this exists: after applying a migration that adds a function, PostgREST only
// calls it once its schema cache has been reloaded. A migration that carries
// `NOTIFY pgrst, 'reload schema'` can still land before the notification is
// processed, and the failure mode is an HTTP 500 with
// `PGRST202 Could not find the function ... in the schema cache` — which looks
// like a product bug. This checks the PostgREST OpenAPI document for the function
// paths (no arguments needed) and tells you exactly what to run when one is
// missing.
//
// With no arguments it checks every function the admin console depends on.
import assert from "node:assert/strict";

const ADMIN_FUNCTIONS = [
  "admin_grant_platform_admin",
  "admin_revoke_platform_admin",
  "admin_user_directory",
  "admin_workspace_directory",
  "admin_add_workspace_member",
  "admin_set_workspace_member_role",
  "admin_remove_workspace_member",
  "admin_set_workspace_plan",
  "admin_adjust_credits",
  "admin_workspace_billing",
  "admin_attach_skill_preview",
  "admin_publish_skill_preview",
  "admin_unpublish_skill_preview",
  "admin_delete_skill_preview",
  "admin_reorder_skill_previews",
  "admin_skill_catalog",
  "admin_job_directory",
  "admin_job_detail",
  "admin_cancel_job",
  "admin_acknowledge_job",
  "admin_channel_directory",
  "admin_channel_detail",
  "admin_channel_failure_rates",
  "admin_home_content_overview",
  "admin_home_content_list",
  "admin_upsert_home_discovery_case",
  "admin_upsert_home_example_example",
  "admin_upsert_home_category",
  "admin_set_home_content_active",
  "admin_reorder_home_content",
  "admin_reorder_home_categories",
  "admin_delete_home_content",
  "admin_asset_overview",
  "admin_asset_orphan_candidates",
  "admin_asset_queue",
  "admin_asset_large_objects",
  "admin_claim_orphan_asset",
  "admin_finalize_orphan_asset",
];

const expected = process.argv.slice(2).filter(argument => !argument.startsWith("--"));
const functions = expected.length ? expected : ADMIN_FUNCTIONS;

const url = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url, "SUPABASE_URL is required (pass --env-file)");
assert(serviceRole, "SUPABASE_SERVICE_ROLE_KEY is required (pass --env-file)");

const response = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
  signal: AbortSignal.timeout(15_000),
});
assert(response.ok, `PostgREST root -> ${response.status}`);
const document = await response.json();
const paths = document?.paths ?? {};
const missing = functions.filter(name => !(`/rpc/${name}` in paths));

if (!missing.length) {
  console.log(`[postgrest-schema] ${functions.length} 个函数在 schema cache 中可见。`);
  // Set the code instead of calling process.exit(): exiting with an in-flight
  // fetch handle trips a libuv assertion on Windows.
  process.exitCode = 0;
} else {
  console.error(`[postgrest-schema] 以下 ${missing.length} 个函数不在 PostgREST schema cache 中：`);
  for (const name of missing) console.error(`  - ${name}`);
  console.error("[postgrest-schema] 修复：对目标数据库执行一次 `NOTIFY pgrst, 'reload schema';`，等几秒后重跑本脚本。");
  console.error("[postgrest-schema] 未处理时接口会返回 500，底层是 PGRST202 Could not find the function ... in the schema cache。");
  process.exitCode = 1;
}
