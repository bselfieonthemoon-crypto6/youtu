/** Real local DB + two API processes. Uses only retained isolation QA actors.
 * Adds then removes B's membership in A's QA workspace, creates a tiny QA board
 * and renames it. No agent/provider/job requests. Test board remains for audit.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");
const fixture = JSON.parse(await readFile(resolve("../../artifacts/saas-boundary/isolation-29cda1c6-7ebb-4807-aad6-0f1a8a1fb5b6.json"), "utf8"));
const a = fixture.actors.find((actor: any) => actor.label === "A");
const b = fixture.actors.find((actor: any) => actor.label === "B");
assert.equal(a.canvasId, "f65f97ff-a148-44ad-941a-4d9c3a2ea225");
assert.notEqual(a.userId, b.userId);
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const runId = randomUUID();
const checks: Array<{ name: string; passed: boolean }> = [];
const sockets: WebSocket[] = [];
const observed = new Map<WebSocket, any[]>();
let added = false;
let designId: string | undefined;
let revision = 0;
let failure: string | undefined;
const check = (name: string, passed: boolean) => { checks.push({ name, passed }); console.log(`${passed ? "PASS" : "FAIL"} ${name}`); };
async function credentials(userId: string) {
  const user = await admin.auth.admin.getUserById(userId);
  assert.ifError(user.error); const email = user.data.user?.email; assert(email);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email }); assert.ifError(link.error);
  const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await anon.auth.verifyOtp({ type: "email", token_hash: link.data.properties!.hashed_token });
  assert.ifError(login.error); assert.equal(login.data.user?.id, userId); assert(login.data.session);
  return { email, token: login.data.session.access_token };
}
async function api(token: string, method: string, path: string, body?: unknown, expected = 200): Promise<any> {
  const response = await fetch(`http://127.0.0.1:3002${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function until(predicate: () => boolean, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  return predicate();
}
async function connect(token: string, port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}&connectionId=qa-${runId}-${sockets.length}`);
  sockets.push(ws); const frames: any[] = []; observed.set(ws, frames);
  ws.on("message", raw => { try { frames.push(JSON.parse(raw.toString())); } catch {} });
  await new Promise<void>((resolveOpen, reject) => { ws.once("open", resolveOpen); ws.once("error", reject); });
  return ws;
}
async function resume(ws: WebSocket, allowed: boolean) {
  const frames = observed.get(ws)!; const offset = frames.length;
  ws.send(JSON.stringify({ type: "command", action: "canvas.resume", payload: { canvasId: a.canvasId, lastSeq: 0 } }));
  return until(() => frames.slice(offset).some(frame => allowed ? frame.type === "command.ack" && frame.action === "canvas.resume" : frame.type === "error"));
}
const ca = await credentials(a.userId); const cb = await credentials(b.userId);
try {
  const viewer = await api(ca.token, "GET", "/api/viewer");
  assert.equal(viewer.workspace.id, a.workspaceId, "QA owner workspace mismatch");
  const existing = await admin.from("workspace_members").select("role").eq("workspace_id", a.workspaceId).eq("user_id", b.userId).maybeSingle();
  assert.ifError(existing.error); assert.equal(existing.data, null, "Do not remove a pre-existing membership");
  await api(ca.token, "POST", "/api/workspace/members", { email: cb.email, role: "member" }, 201); added = true;
  const wsA = await connect(ca.token, 3002); const wsPeer = await connect(ca.token, 3003); const wsB = await connect(cb.token, 3003);
  check("owner subscribes on primary", await resume(wsA, true));
  check("owner subscribes on peer", await resume(wsPeer, true));
  check("QA member subscribes on peer before removal", await resume(wsB, true));
  await new Promise(resolveDelay => setTimeout(resolveDelay, 16000));
  check("authenticated sockets remain open beyond the authentication deadline", [wsA, wsPeer, wsB].every(ws => ws.readyState === WebSocket.OPEN));
  const canvas = await admin.from("canvases").select("revision").eq("id", a.canvasId).single(); assert.ifError(canvas.error);
  const created = await api(ca.token, "POST", "/api/designs", { request_id: randomUUID(), canvas_id: a.canvasId, expected_canvas_revision: canvas.data!.revision,
    canvas_element_id: `qa-fanout-${runId}`, name: "QA realtime fanout", width: 64, height: 64, background: "#ffffff", node: { x: 0, y: 0, width: 64, height: 64 } }, 201);
  designId = created.design_id; revision = created.design_revision;
  const rename = async () => {
    const result = await api(ca.token, "PATCH", `/api/designs/${designId}/name`, { design_id: designId, expected_revision: revision, idempotency_key: randomUUID(), name: `QA fanout ${randomUUID()}` });
    revision = result.revision; return revision;
  };
  const received = (ws: WebSocket, target: number) => observed.get(ws)!.some(frame => frame.type === "design.sync" && frame.designId === designId && frame.revision === target);
  const before = await rename();
  check("both API instances receive the same revision", await until(() => received(wsA, before) && received(wsPeer, before)));
  check("authorized member receives revision", await until(() => received(wsB, before)));
  await api(ca.token, "DELETE", `/api/workspace/members/${b.userId}`, undefined, 204); added = false;
  const after = await rename();
  check("owner still receives post-removal revision on both instances", await until(() => received(wsA, after) && received(wsPeer, after)));
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1500));
  check("old member connection receives no post-removal revision", !received(wsB, after));
  check("peer closes the revoked member's old connection", await until(() => wsB.readyState === WebSocket.CLOSED));
  const wsBNew = await connect(cb.token, 3003);
  check("new member connection cannot resume after removal", await resume(wsBNew, false));
  wsA.terminate();
  const remoteOnly = await rename();
  check("peer receives revision when publisher has no local QA viewer", await until(() => received(wsPeer, remoteOnly)));
} catch (error) {
  failure = error instanceof Error ? error.message : "QA failed";
  console.log(`QA_FAILED ${failure}`);
} finally {
  if (added) {
    try { await api(ca.token, "DELETE", `/api/workspace/members/${b.userId}`, undefined, 204); added = false; }
    catch { failure = `${failure ?? ""}; temporary QA membership cleanup failed`; }
  }
  sockets.forEach(socket => socket.terminate());
  const reportPath = resolve(`../../artifacts/saas-boundary/realtime-fanout-membership-${runId}.json`);
  await writeFile(reportPath, JSON.stringify({ runId, designId, canvasId: a.canvasId, realDatabase: true, apiPorts: [3002, 3003], providerRequests: 0, businessWrites: "QA membership added/removed; QA design created/renamed and retained", membershipRetained: added, checks, failure }, null, 2));
  console.log(JSON.stringify({ reportPath, checks: checks.length, failed: checks.filter(check => !check.passed).length, failure }));
}
if (failure || checks.some(check => !check.passed)) process.exitCode = 1;
