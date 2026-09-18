// Creates an empty local QA project/session. Never submits an agent run.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

assert(process.argv.includes("--prepare"), "Explicit --prepare required for local QA fixture creation");
assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");
const ownerId = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const workspaceId = "25eb32ef-ff55-4de7-8c10-9390a51ece06";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const account = await admin.auth.admin.getUserById(ownerId);
assert.ifError(account.error); assert(account.data.user?.email);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
assert.ifError(link.error);
const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, opts);
const login = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
assert.ifError(login.error); assert(login.data.session);
const token = login.data.session.access_token;
async function request(method, route, body) {
  const response = await fetch(`http://127.0.0.1:3002${route}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `${method} ${route} failed with HTTP ${response.status}`);
  return response.json();
}
const configs = await admin.from("workspace_provider_configs").select("id").eq("workspace_id", workspaceId).eq("enabled", true);
assert.ifError(configs.error); assert(configs.data?.length);
const models = await admin.from("workspace_provider_models").select("catalog_key,upstream_model_id,modality")
  .in("provider_config_id", configs.data.map(row => row.id)).eq("enabled", true);
assert.ifError(models.error);
const image = models.data?.find(row => row.upstream_model_id === "gpt-image-2.5-flare");
const text = models.data?.find(row => row.modality === "text");
assert(image && text, "Required QA text/image catalogs unavailable; nothing was created");
const project = (await request("POST", "/api/projects", { name: `QA 类型护栏验收 ${Date.now()}` })).project;
assert.equal(project.workspace.id, workspaceId);
const canvasId = project.primaryCanvas.id;
const session = (await request("POST", `/api/canvases/${canvasId}/sessions`, { title: "真实图片验收（未提交）" })).session;
const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), ownerId, workspaceId,
  fixture: { projectId: project.id, canvasId, sessionId: session.id },
  models: { text: { id: `workspace:${text.catalog_key}`, name: text.upstream_model_id },
    image: { id: `workspace:${image.catalog_key}`, name: image.upstream_model_id } },
  autonomyEnabled: false, turns: [], proposedImages: 1, quality: "standard", resolution: "1k",
  prompt: "只生成一张测试图片，一次提交，不重试、不追加图片。Low 画质、1K 分辨率、1:1 比例。画面为蓝色背景上一个橙色球体和一个白色立方体，无文字。" };
const directory = fileURLToPath(new URL("../../../artifacts/real-image-acceptance/", import.meta.url));
await mkdir(directory, { recursive: true });
const output = new URL(`../../../artifacts/real-image-acceptance/fixture-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify(manifest, null, 2));
console.log(`Prepared empty QA fixture; no model request: ${fileURLToPath(output)}`);
console.log(`http://localhost:3020/canvas?id=${canvasId}&session=${session.id}`);
