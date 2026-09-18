/**
 * Read-only live WebSocket authorization probe against the retained two-user
 * fixture. It never submits an agent run or provider request.
 *
 * Usage (from apps/server):
 * node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/test-ws-isolation-live.ts
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const fixturePath = resolve("../../artifacts/saas-boundary/isolation-00639b8f-3ee2-4e46-9c91-df007b8647a6.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  fixtureId: string;
  actors: Array<{ label: string; userId: string; canvasId: string; sessionId: string; jobId: string }>;
};
assert.equal(fixture.actors.length, 2);
assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const actors = new Map(fixture.actors.map((actor) => [actor.label, actor]));
const results: Array<{ name: string; passed: boolean; detail?: string }> = [];
const check = (name: string, passed: boolean, detail?: string) => {
  results.push({ name, passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function freshToken(userId: string) {
  const user = await admin.auth.admin.getUserById(userId);
  assert.ifError(user.error);
  assert(user.data.user?.email);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: user.data.user.email });
  assert.ifError(link.error);
  const tokenHash = link.data.properties?.hashed_token;
  assert(tokenHash);
  const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const verified = await anon.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  assert.ifError(verified.error);
  assert.equal(verified.data.user?.id, userId);
  assert(verified.data.session?.access_token);
  return verified.data.session.access_token;
}

function open(token: string, connectionId: string) {
  return new Promise<WebSocket>((resolveSocket, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:3002/api/ws?token=${encodeURIComponent(token)}&connectionId=${connectionId}`);
    socket.once("open", () => setTimeout(() => resolveSocket(socket), 300));
    socket.once("error", reject);
  });
}

function command(socket: WebSocket, action: string, payload: Record<string, unknown>, accept: (message: Record<string, unknown>) => boolean, credentials: Record<string, unknown> = {}) {
  const requestId = `ws-boundary-${Math.random().toString(36).slice(2)}`;
  const message = { type: "command", action, requestId, ...credentials, payload };
  return new Promise<Record<string, unknown>>((resolveMessage, reject) => {
    const observed: string[] = [];
    const timer = setTimeout(() => reject(new Error(`websocket response timeout action=${action} observed=${observed.join(",")}`)), 5000);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      socket.off("message", listener);
      reject(new Error(`websocket closed code=${code} reason=${reason.toString()}`));
    };
    const listener = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
      observed.push(`${String(parsed.type)}/${String(parsed.action ?? parsed.code ?? parsed.message)}/rid=${String(parsed.requestId ?? "none")}`);
      // Stream events may precede a command response. Never treat an arbitrary
      // first message as the command result; require the caller's predicate.
      if (parsed.requestId !== undefined && parsed.requestId !== requestId) return;
      if (!accept(parsed)) return;
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("message", listener);
      resolveMessage(parsed);
    };
    socket.on("message", listener);
    socket.once("close", onClose);
    socket.send(JSON.stringify(message));
  });
}

const tokenA = await freshToken(actors.get("A")!.userId);
const tokenB = await freshToken(actors.get("B")!.userId);
const socketA = await open(tokenA, `ws-boundary-A-${fixture.fixtureId}`);
const socketB = await open(tokenB, `ws-boundary-B-${fixture.fixtureId}`);
try {
  const ownA = await command(socketA, "canvas.resume", { canvasId: actors.get("A")!.canvasId, lastSeq: 0 }, (message) => message.type === "command.ack" && message.action === "canvas.resume");
  check("A can resume A canvas", ownA.type === "command.ack" && ownA.action === "canvas.resume");
  const foreignA = await command(socketA, "canvas.resume", { canvasId: actors.get("B")!.canvasId, lastSeq: 0 }, (message) => message.type === "error" && message.message === "Canvas not found or access denied");
  check("A cannot subscribe to B canvas/session events", foreignA.type === "error" && foreignA.message === "Canvas not found or access denied", String(foreignA.message));

  const cancelForeign = await command(socketA, "agent.cancel", { runId: actors.get("B")!.jobId }, (message) => message.type === "error" && String(message.message).includes("Run not found"));
  check("invalid/nonexistent run ID is rejected (not cross-tenant cancellation evidence)", cancelForeign.type === "error" && String(cancelForeign.message).includes("Run not found"), String(cancelForeign.message));

  const switchAttempt = await command(socketA, "canvas.resume", { canvasId: actors.get("A")!.canvasId, lastSeq: 0 }, (message) => message.type === "error" && message.code === "authentication_required", { accessToken: tokenB });
  check("A socket rejects an attempted B identity switch", switchAttempt.type === "error" && switchAttempt.code === "authentication_required", String(switchAttempt.code));
  const afterSwitch = await command(socketA, "canvas.resume", { canvasId: actors.get("A")!.canvasId, lastSeq: 0 }, (message) => message.type === "command.ack" && message.action === "canvas.resume");
  check("A socket remains bound to A after rejected switch", afterSwitch.type === "command.ack" && afterSwitch.action === "canvas.resume");

  const ownB = await command(socketB, "canvas.resume", { canvasId: actors.get("B")!.canvasId, lastSeq: 0 }, (message) => message.type === "command.ack" && message.action === "canvas.resume");
  check("B can resume B canvas", ownB.type === "command.ack" && ownB.action === "canvas.resume");
  const foreignB = await command(socketB, "canvas.resume", { canvasId: actors.get("A")!.canvasId, lastSeq: 0 }, (message) => message.type === "error" && message.message === "Canvas not found or access denied");
  check("B cannot subscribe to A canvas/session events", foreignB.type === "error" && foreignB.message === "Canvas not found or access denied", String(foreignB.message));
} finally {
  socketA.close();
  socketB.close();
}

const reportPath = resolve(`../../artifacts/saas-boundary/ws-isolation-${fixture.fixtureId}-retest.json`);
await writeFile(reportPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  fixtureId: fixture.fixtureId,
  kind: "real-local-api-websocket-authz",
  providerRequests: 0,
  applicationDataWrites: 0,
  authSideEffect: "admin auth link/verify used to mint fresh JWTs; not counted as application-data writes",
  tokensPrinted: false,
  checks: results,
}, null, 2));
console.log(JSON.stringify({ report: reportPath, checks: results.length, isolationChecks: 6, invalidRunIdChecks: 1, failed: results.filter((result) => !result.passed).length, providerRequests: 0, applicationDataWrites: 0 }));
if (results.some((result) => !result.passed)) process.exitCode = 1;
