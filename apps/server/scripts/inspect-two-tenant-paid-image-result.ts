/** Read-only completion/isolation inspection for a prior two-tenant browser run. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = requireWeb("@playwright/test") as { chromium: { launch(options: { channel: string; headless: boolean }): Promise<{ newPage(): Promise<{ goto(url: string, options: { waitUntil: string }): Promise<void>; locator(selector: string): { evaluate<T>(callback: (image: { complete: boolean; naturalWidth: number; naturalHeight: number }) => T): Promise<T> } }>; close(): Promise<void> }> } };

const fixtureDir = process.argv.find(arg => arg.startsWith("--fixture-dir="))?.slice(14);
assert(fixtureDir, "--fixture-dir is required");
assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts);
const report: any = { kind: "two-tenant-paid-image-read-only-completion", fixtureDir, checks: [] as any[], startedAt: new Date().toISOString() };
function check(name: string, passed: boolean, extra: Record<string, unknown> = {}) { report.checks.push({ name, passed, ...extra }); assert(passed, name); }
async function token(userId: string) {
  const user = await admin.auth.admin.getUserById(userId); assert.ifError(user.error); assert(user.data.user?.email);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: user.data.user.email }); assert.ifError(link.error);
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, opts);
  const login = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }); assert.ifError(login.error); assert(login.data.session);
  return login.data.session.access_token;
}
async function get<T = any>(jwt: string, path: string): Promise<{ status: number; data: T }> { const response = await fetch(`http://127.0.0.1:3002${path}`, { headers: { Authorization: `Bearer ${jwt}` } }); return { status: response.status, data: await response.json().catch(() => null) as T }; }
async function decode(bucket: string, objectPath: string) {
  const signed = await admin.storage.from(bucket).createSignedUrl(objectPath, 120); assert.ifError(signed.error);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try { const page = await browser.newPage(); await page.goto(signed.data.signedUrl, { waitUntil: "domcontentloaded" }); return await page.locator("img").evaluate(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })); }
  finally { await browser.close(); }
}
try {
  const [a, b] = await Promise.all(["A.json", "B.json"].map(async name => JSON.parse(await readFile(resolve(fixtureDir!, name), "utf8"))));
  check("two distinct QA users and workspaces", a.ownerId !== b.ownerId && a.workspaceId !== b.workspaceId);
  const [tokenA, tokenB] = await Promise.all([token(a.ownerId), token(b.ownerId)]);
  const load = async (actor: any) => { const job = await admin.from("background_jobs").select("id,status,workspace_id,created_by,result").eq("session_id", actor.fixture.sessionId).eq("job_type", "image_generation").single(); assert.ifError(job.error); assert.equal(job.data.status, "succeeded"); const assetId = job.data.result?.asset_id ?? job.data.result?.assetId; assert(typeof assetId === "string"); const asset = await admin.from("asset_objects").select("id,workspace_id,created_by,bucket,object_path").eq("id", assetId).single(); assert.ifError(asset.error); check(`${actor === a ? "A" : "B"} job/asset owner alignment`, job.data.workspace_id === actor.workspaceId && job.data.created_by === actor.ownerId && asset.data.workspace_id === actor.workspaceId && asset.data.created_by === actor.ownerId, { jobId: job.data.id, assetId }); return { job: job.data, asset: asset.data }; };
  const [resultA, resultB] = await Promise.all([load(a), load(b)]);
  const [decodedA, decodedB] = await Promise.all([decode(resultA.asset.bucket, resultA.asset.object_path), decode(resultB.asset.bucket, resultB.asset.object_path)]);
  check("A image decodes in Chromium", decodedA.complete && decodedA.width > 0 && decodedA.height > 0, decodedA);
  check("B image decodes in Chromium", decodedB.complete && decodedB.width > 0 && decodedB.height > 0, decodedB);
  for (const [jwt, other, otherResult, label] of [[tokenA, b, resultB, "A->B"], [tokenB, a, resultA, "B->A"]] as const) {
    const [job, canvas, messages, content] = await Promise.all([get(jwt, `/api/jobs/${otherResult.job.id}`), get(jwt, `/api/canvases/${other.fixture.canvasId}`), get<{ messages?: unknown[] }>(jwt, `/api/sessions/${other.fixture.sessionId}/messages`), get(jwt, `/api/uploads/${otherResult.asset.id}/content`)]);
    check(`${label} job rejected`, [403, 404].includes(job.status), { status: job.status });
    check(`${label} canvas rejected`, [403, 404].includes(canvas.status), { status: canvas.status });
    check(`${label} messages rejected or empty`, [403, 404].includes(messages.status) || (messages.status === 200 && Array.isArray(messages.data?.messages) && messages.data.messages.length === 0), { status: messages.status });
    check(`${label} asset content rejected`, [403, 404].includes(content.status), { status: content.status });
  }
  report.passed = true; report.jobs = { A: resultA.job.id, B: resultB.job.id };
} catch (error) { report.passed = false; report.error = String(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(resolve(fixtureDir!, "read-only-completion.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: resolve(fixtureDir!, "read-only-completion.json"), passed: report.passed, checks: report.checks.length })); }
