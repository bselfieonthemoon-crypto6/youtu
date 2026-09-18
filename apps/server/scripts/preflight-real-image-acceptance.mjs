// Read-only preflight. Does not create fixtures, submit jobs, or call models.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createTierGuard } from "../src/features/credits/tier-guard.js";

assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421", "Only the isolated local replica is supported");
assert(process.env.SUPABASE_SERVICE_ROLE_KEY, "Missing local admin configuration");
const workspaceId = "25eb32ef-ff55-4de7-8c10-9390a51ece06";
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const report = { createdAt: new Date().toISOString(), kind: "read_only_real_image_preflight",
  workspaceId, health: {}, activeImageJobs: null, imageModels: [], actualCreditsCost: null,
  proposedImages: 1, quality: "standard", resolution: "1k", providerMoneyCost: "not available from local credit pricing" };
for (const [name, url] of Object.entries({ web: "http://localhost:3020", api: "http://127.0.0.1:3002/api/health" })) {
  try {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  report.health[name] = response.status;
  } catch { report.health[name] = "unreachable"; }
}
const jobs = await client.from("background_jobs").select("id", { count: "exact", head: true })
  .eq("workspace_id", workspaceId).eq("job_type", "image_generation").in("status", ["queued", "running"]);
assert.ifError(jobs.error); report.activeImageJobs = jobs.count;
const configs = await client.from("workspace_provider_configs").select("id").eq("workspace_id", workspaceId).eq("enabled", true);
assert.ifError(configs.error);
assert(configs.data?.length, "No enabled local provider configuration");
const models = await client.from("workspace_provider_models").select("catalog_key,upstream_model_id,modality")
  .in("provider_config_id", configs.data.map(row => row.id)).eq("enabled", true).eq("modality", "image");
assert.ifError(models.error);
report.imageModels = models.data ?? [];
assert(report.imageModels.length, "No enabled image model");
report.actualCreditsCost = createTierGuard({ getAdminClient: () => client })
  .calculateCreditCost(report.imageModels[0].upstream_model_id, "image_generation", { quality: "standard", imageResolution: "1k" });
const directory = fileURLToPath(new URL("../../../artifacts/real-image-acceptance/", import.meta.url));
await mkdir(directory, { recursive: true });
const output = new URL(`../../../artifacts/real-image-acceptance/preflight-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Read-only report: ${fileURLToPath(output)}`);
assert(Object.values(report.health).every(status => status === 200), "Local services must be healthy before paid acceptance");
