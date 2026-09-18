// Opt-in, one paid call. Does not change the catalog, jobs or tool defaults.
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { loadServerEnv } from "../src/config/env.js";
import { createAdminSupabaseClient } from "../src/supabase/admin.js";
import { OpenAIImageProvider } from "../src/generation/providers/openai-image.js";
import { runWithGenerationProviderScope } from "../src/generation/providers/registry.js";
import { removeBackgroundWithApi } from "../src/features/images/api-background-removal.js";

if (!process.argv.includes("--submit")) throw new Error("Requires --submit: one paid request");
const env = loadServerEnv();
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(env.supabaseUrl ?? "")) throw new Error("Local database only");
const admin = createAdminSupabaseClient(env);
const { data: row, error } = await admin.from("workspace_provider_models").select("provider_config_id,upstream_model_id,enabled")
  .eq("id", "748c78b1-29cd-438f-a23c-d6b7367c64f8").single();
if (error || !row?.enabled || row.upstream_model_id !== "gpt-image-2.5-flare") throw new Error("Configured flare model unavailable");
const { data: config } = await admin.from("workspace_provider_configs").select("base_url,api_key_secret_id,enabled")
  .eq("id", row.provider_config_id).single();
if (!config?.enabled) throw new Error("Provider disabled");
const secret = await admin.rpc("loomic_provider_secret_read", { p_secret_id: config.api_key_secret_id });
if (secret.error || !secret.data) throw new Error("Credentials unavailable");
const upstream = new OpenAIImageProvider(String(secret.data), config.base_url);
const model = "workspace:flare-background-probe";
let calls = 0;
const provider = { name: "flare-background-probe", models: [{ id: model, displayName: "Flare probe", description: "" }],
  generate: async (params: Parameters<typeof upstream.generate>[0]) => {
    if (++calls > 1) throw new Error("No repeat paid calls");
    return upstream.generate({ ...params, model: row.upstream_model_id });
  } };
const dir = `../../artifacts/flare-background-${Date.now()}`;
await mkdir(dir, { recursive: true });
const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="768" height="768" fill="#58bccc"/><ellipse cx="380" cy="600" rx="200" ry="45" fill="#438e9a"/><path d="M250 230 H470 V500 Q470 580 390 580 H330 Q250 580 250 500Z" fill="#e53935"/><path d="M470 280 H525 Q585 280 585 355 Q585 430 525 430 H470" fill="none" stroke="#e53935" stroke-width="40"/><text x="280" y="415" font-family="sans-serif" font-size="56" fill="white">TEST</text></svg>')).png().toBuffer();
await writeFile(`${dir}/source.png`, source);
console.log(JSON.stringify({ event: "submitting", model: row.upstream_model_id, dir, maxCalls: 1 }));
try {
  const result = await runWithGenerationProviderScope({ imageProvider: provider }, () => removeBackgroundWithApi(source, model));
  const buffer = result.layers[0]!.buffer;
  await writeFile(`${dir}/result.png`, buffer);
  const alpha = await sharp(buffer).extractChannel("alpha").raw().toBuffer();
  const report = { success: true, calls, model: row.upstream_model_id, width: result.width, height: result.height,
    transparentFraction: alpha.filter(v => v === 0).length / alpha.length };
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (err) {
  const report = { success: false, calls, code: (err as any).code, message: err instanceof Error ? err.message : String(err) };
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = 1;
}
