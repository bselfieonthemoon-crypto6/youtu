/**
 * Real-provider, two-tenant browser acceptance.  This is intentionally a
 * separate driver: it neither changes existing dialogue drivers nor reuses a
 * user's project/canvas/configuration.  The second QA workspace receives a
 * new config row referring to the already-vaulted QA secret; the secret value
 * is never read or printed.
 *
 * Usage: node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/test-two-tenant-paid-image-browser.ts --submit
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

assert(process.argv.includes("--submit"), "Explicit --submit required: two real provider image requests may occur");
assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");
const exec = promisify(execFile);
const api = "http://127.0.0.1:3002";
const sourceOwnerId = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const sourceWorkspaceId = "25eb32ef-ff55-4de7-8c10-9390a51ece06";
const sourceConfigId = "95e5b26e-b906-4dce-8745-ad0c1638b6f6";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts);
const stamp = randomUUID();
const outDir = resolve("../../../artifacts/two-tenant-paid-image", stamp);
type Actor = { label: string; userId: string; workspaceId: string; token: string; projectId: string; canvasId: string; sessionId: string; imageModel: string; textModel: string };
const report: any = { schemaVersion: 1, fixtureId: stamp, createdAt: new Date().toISOString(), kind: "two-tenant-real-browser-image", providerRequestsExpected: 2, checks: [] as any[] };
function check(name: string, passed: boolean, extra: Record<string, unknown> = {}) { report.checks.push({ name, passed, ...extra }); if (!passed) throw new Error(`CHECK_FAILED ${name}`); }
async function request<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(api + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  return { status: res.status, data: await res.json().catch(() => null) as T };
}
async function magicToken(userId: string) {
  const account = await admin.auth.admin.getUserById(userId); assert.ifError(account.error); assert(account.data.user?.email);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email }); assert.ifError(link.error);
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, opts);
  const login = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }); assert.ifError(login.error); assert(login.data.session);
  return login.data.session.access_token;
}
async function provision(label: string, token: string, userId: string): Promise<Omit<Actor, "imageModel" | "textModel">> {
  const viewer = await request<{ workspace: { id: string } }>(token, "GET", "/api/viewer"); assert.equal(viewer.status, 200);
  const project = await request<{ project: { id: string; primaryCanvas: { id: string } } }>(token, "POST", "/api/projects", { name: `QA ${label} ${stamp}` }); assert.equal(project.status, 201);
  const canvasId = project.data.project.primaryCanvas.id;
  const session = await request<{ session: { id: string } }>(token, "POST", `/api/canvases/${canvasId}/sessions`, { title: `QA ${label} isolated image dialogue ${stamp}` }); assert.equal(session.status, 201);
  return { label, token, userId, workspaceId: viewer.data.workspace.id, projectId: project.data.project.id, canvasId, sessionId: session.data.session.id };
}
async function cloneOnlyRequiredModels(workspaceId: string, userId: string) {
  // Metadata and the opaque vault-secret id are copied.  There is no vault read,
  // provider connection probe, or update to the source workspace/configuration.
  const source = await admin.from("workspace_provider_configs").select("adapter,display_name,base_url,api_key_secret_id,api_key_last_four,enabled,last_test_status").eq("id", sourceConfigId).eq("workspace_id", sourceWorkspaceId).single();
  assert.ifError(source.error); assert.equal(source.data.enabled, true); assert.equal(source.data.last_test_status, "succeeded");
  const models = await admin.from("workspace_provider_models").select("upstream_model_id,display_name,modality,enabled,capabilities,context_profile").eq("provider_config_id", sourceConfigId).in("upstream_model_id", ["deepseek-v4-flash-vision-exp", "gpt-image-2"]);
  assert.ifError(models.error); assert.equal(models.data?.length, 2, "QA source must provide exact text plus gpt-image-2");
  const configId = randomUUID();
  const inserted = await admin.from("workspace_provider_configs").insert({ id: configId, workspace_id: workspaceId, adapter: source.data.adapter, display_name: `QA isolated BASE ${stamp}`, base_url: source.data.base_url, api_key_secret_id: source.data.api_key_secret_id, api_key_last_four: source.data.api_key_last_four, enabled: true, last_test_status: "succeeded", last_tested_at: new Date().toISOString(), created_by: userId, updated_by: userId }).select("id").single();
  assert.ifError(inserted.error);
  const rows = models.data!.map(model => ({ id: randomUUID(), catalog_key: randomUUID(), provider_config_id: configId, upstream_model_id: model.upstream_model_id, display_name: model.display_name, modality: model.modality, enabled: true, capabilities: model.capabilities, context_profile: model.context_profile }));
  const modelInsert = await admin.from("workspace_provider_models").insert(rows); assert.ifError(modelInsert.error);
  const text = rows.find(row => row.modality === "text")!; const image = rows.find(row => row.upstream_model_id === "gpt-image-2")!;
  return { textModel: `workspace:${text.catalog_key}`, imageModel: `workspace:${image.catalog_key}`, configId };
}
async function makeManifest(actor: Actor) {
  const path = resolve(outDir, `${actor.label}.json`);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, fixtureId: stamp, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerId: actor.userId, workspaceId: actor.workspaceId, fixture: { projectId: actor.projectId, canvasId: actor.canvasId, sessionId: actor.sessionId }, models: { text: { id: actor.textModel, name: "deepseek-v4-flash-vision-exp", provider: "QA" }, image: { id: actor.imageModel, name: "gpt-image-2", provider: "QA" } }, autonomyEnabled: false, turns: [] }, null, 2));
  return path;
}
async function browserTurn(manifest: string, prompt: string) {
  const script = resolve("../web/scripts/run-paid-dialogue-browser.mjs");
  return exec(process.execPath, [script, "--submit", `--fixture=${manifest}`, `--prompt=${prompt}`, "--timeout-minutes=30"], { cwd: resolve(".."), env: process.env, maxBuffer: 2_000_000 });
}
async function waitForDelivery(actor: Actor, since: string) {
  const deadline = Date.now() + 30 * 60_000;
  let job: any;
  while (Date.now() < deadline) {
    const result = await admin.from("background_jobs").select("id,status,workspace_id,created_by,result,completed_at").eq("session_id", actor.sessionId).eq("job_type", "image_generation").gte("created_at", since).order("created_at", { ascending: false }); assert.ifError(result.error);
    const candidate = result.data?.[0];
    if (result.data?.length === 1 && candidate && ["succeeded", "failed", "canceled", "dead_letter"].includes(candidate.status)) { job = candidate; break; }
    await new Promise(done => setTimeout(done, 3000));
  }
  assert(job, `${actor.label} image job did not reach terminal state`); assert.equal(job.status, "succeeded", `${actor.label} provider image did not succeed`);
  const assetId = job.result?.assetId ?? job.result?.asset_id; assert(typeof assetId === "string", `${actor.label} succeeded job has no asset id`);
  const asset = await admin.from("asset_objects").select("id,workspace_id,created_by,bucket,object_path").eq("id", assetId).single(); assert.ifError(asset.error);
  check(`${actor.label} job belongs to actor workspace`, job.workspace_id === actor.workspaceId && job.created_by === actor.userId, { jobId: job.id });
  check(`${actor.label} asset belongs to actor workspace`, asset.data.workspace_id === actor.workspaceId && asset.data.created_by === actor.userId, { assetId });
  return { jobId: job.id, assetId, objectPath: asset.data.object_path };
}
async function decodedInBrowser(actor: Actor, jobId: string) {
  // A signed asset URL is obtained through the normal owner-scoped storage API,
  // then Chromium decodes bytes; this is not a synthetic image assertion.
  const asset = await admin.from("background_jobs").select("result").eq("id", jobId).single(); assert.ifError(asset.error);
  const assetId = asset.data.result?.assetId ?? asset.data.result?.asset_id;
  const object = await admin.from("asset_objects").select("bucket,object_path").eq("id", assetId).single(); assert.ifError(object.error);
  const signed = await admin.storage.from(object.data.bucket).createSignedUrl(object.data.object_path, 120); assert.ifError(signed.error);
  const probe = `const { chromium } = require('@playwright/test'); (async()=>{const b=await chromium.launch({channel:'chrome',headless:true});const p=await b.newPage();await p.goto(process.argv[1],{waitUntil:'domcontentloaded'}); const x=await p.locator('img').evaluate(i=>({complete:i.complete,width:i.naturalWidth,height:i.naturalHeight})); console.log(JSON.stringify(x)); await b.close()})().catch(e=>{console.error(e.message);process.exit(1)})`;
  const { stdout } = await exec(process.execPath, ["-e", probe, signed.data.signedUrl], { cwd: resolve("../web"), env: process.env });
  const decoded = JSON.parse(stdout.trim()); check(`${actor.label} actual image bytes decode in Chromium`, decoded.complete && decoded.width > 0 && decoded.height > 0, decoded);
  return decoded;
}
try {
  await mkdir(outDir, { recursive: true });
  const tokenA = await magicToken(sourceOwnerId);
  const baseA = await provision("A", tokenA, sourceOwnerId); check("A uses supplied dedicated QA workspace", baseA.workspaceId === sourceWorkspaceId, { workspaceId: baseA.workspaceId });
  const emailB = `two-tenant-image-${stamp}@example.invalid`; const passwordB = `${randomUUID()}Qa9!`;
  const createdB = await admin.auth.admin.createUser({ email: emailB, password: passwordB, email_confirm: true }); assert.ifError(createdB.error); assert(createdB.data.user);
  const authB = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, opts); const loginB = await authB.auth.signInWithPassword({ email: emailB, password: passwordB }); assert.ifError(loginB.error); assert(loginB.data.session);
  const baseB = await provision("B", loginB.data.session.access_token, createdB.data.user.id); check("two owners differ", baseA.userId !== baseB.userId && baseA.workspaceId !== baseB.workspaceId);
  const cloned = await cloneOnlyRequiredModels(baseB.workspaceId, baseB.userId);
  const actorA: Actor = { ...baseA, textModel: "workspace:b1b94c9a-cec3-4321-8eb4-898a6a5a41d6", imageModel: "workspace:29a0cb35-0794-4239-9a95-948c8cf93705" };
  const actorB: Actor = { ...baseB, ...cloned };
  report.actors = [actorA, actorB].map(({ token, ...safe }) => safe);
  const [manifestA, manifestB] = await Promise.all([makeManifest(actorA), makeManifest(actorB)]);
  await Promise.all([
    browserTurn(manifestA, "请为品牌「北岸烘焙」制定一张 4:5 竖版秋日酸面包海报方案：赤陶红和奶油白，标题逐字为 北岸烘焙，不要人物。先保存方案，等待我确认后再生成。"),
    browserTurn(manifestB, "请为品牌「星野天文馆」制定一张 1:1 方形深夜观星活动海报方案：靛蓝与银白，标题逐字为 星野天文馆，不要人物或食物。先保存方案，等待我确认后再生成。"),
  ]);
  const confirmAt = new Date().toISOString();
  // This is the natural brand-qualified acknowledgement a user actually gave.
  // It must remain a confirmation of the frozen proposal, not create a new
  // requirement or silently fall back to a bare keyword.
  await Promise.all([browserTurn(manifestA, "确认生成北岸烘焙这张海报。"), browserTurn(manifestB, "确认生成星野天文馆这张海报。")] );
  const [deliveryA, deliveryB] = await Promise.all([waitForDelivery(actorA, confirmAt), waitForDelivery(actorB, confirmAt)]);
  const denyOrEmpty = (response: { status: number; data: any }) => [403, 404].includes(response.status) ||
    (response.status === 200 && Array.isArray(response.data?.messages) && response.data.messages.length === 0);
  const foreign = await request(actorB.token, "GET", `/api/jobs/${deliveryA.jobId}`); check("B reverse JWT cannot read A image task", [403, 404].includes(foreign.status), { status: foreign.status });
  const reverse = await request(actorA.token, "GET", `/api/jobs/${deliveryB.jobId}`); check("A reverse JWT cannot read B image task", [403, 404].includes(reverse.status), { status: reverse.status });
  for (const [viewer, other, name] of [[actorA, actorB, "A cannot read B"], [actorB, actorA, "B cannot read A"]] as const) {
    const [canvas, messages] = await Promise.all([
      request(viewer.token, "GET", `/api/canvases/${other.canvasId}`),
      request(viewer.token, "GET", `/api/sessions/${other.sessionId}/messages`),
    ]);
    check(`${name} canvas`, [403, 404].includes(canvas.status), { status: canvas.status });
    check(`${name} session messages`, denyOrEmpty(messages), { status: messages.status });
  }
  const ownA = await request(actorA.token, "GET", `/api/jobs/${deliveryA.jobId}`); const ownB = await request(actorB.token, "GET", `/api/jobs/${deliveryB.jobId}`); check("each owner reads own task", ownA.status === 200 && ownB.status === 200, { a: ownA.status, b: ownB.status });
  const [decodedA, decodedB] = await Promise.all([decodedInBrowser(actorA, deliveryA.jobId), decodedInBrowser(actorB, deliveryB.jobId)]);
  const [assetAFromB, assetBFromA] = await Promise.all([
    request(actorB.token, "GET", `/api/uploads/${deliveryA.assetId}/content`),
    request(actorA.token, "GET", `/api/uploads/${deliveryB.assetId}/content`),
  ]);
  check("B cannot read A generated asset content", [403, 404].includes(assetAFromB.status), { status: assetAFromB.status });
  check("A cannot read B generated asset content", [403, 404].includes(assetBFromA.status), { status: assetBFromA.status });
  report.deliveries = { A: { ...deliveryA, decoded: decodedA }, B: { ...deliveryB, decoded: decodedB } };
  report.finishedAt = new Date().toISOString(); report.passed = true;
} catch (error) { report.finishedAt = new Date().toISOString(); report.passed = false; report.error = String(error instanceof Error ? error.message : error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); process.exitCode = 1; }
finally { await mkdir(outDir, { recursive: true }); await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: resolve(outDir, "report.json"), passed: report.passed, checks: report.checks.length })); }
