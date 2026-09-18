/**
 * Live WebSocket connectionId collision probe.
 *
 * This intentionally uses the retained QA fixture and never starts an agent
 * run, creates a job, calls a provider, or touches the original canvas.
 * It checks whether a client-controlled connectionId can alias two users and
 * whether cleanup of the old socket removes the replacement entry.
 *
 * Usage (from apps/server):
 * node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/test-ws-connection-collision-live.ts
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const fixturePath = resolve("../../artifacts/saas-boundary/isolation-29cda1c6-7ebb-4807-aad6-0f1a8a1fb5b6.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  fixtureId: string;
  actors: Array<{ label: string; userId: string; canvasId: string }>;
};
assert.equal(fixture.actors.length, 2);
assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const actorA = fixture.actors.find((actor) => actor.label === "A")!;
const actorB = fixture.actors.find((actor) => actor.label === "B")!;
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
const check = (name: string, passed: boolean, detail?: string) => {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
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
    socket.once("open", () => setTimeout(() => resolveSocket(socket), 250));
    socket.once("error", reject);
  });
}

function attemptOpen(token: string, connectionId: string) {
  return new Promise<{ socket: WebSocket; opened: boolean; closeCode?: number }>((resolveAttempt, rejectAttempt) => {
    const socket = new WebSocket(`ws://127.0.0.1:3002/api/ws?token=${encodeURIComponent(token)}&connectionId=${connectionId}`);
    const timer = setTimeout(() => { socket.terminate(); rejectAttempt(new Error("websocket open/close timeout")); }, 3000);
    socket.once("open", () => { clearTimeout(timer); setTimeout(() => resolveAttempt({ socket, opened: true }), 250); });
    socket.once("close", (code: number) => { clearTimeout(timer); resolveAttempt({ socket, opened: false, closeCode: code }); });
    socket.once("error", (error) => { if (socket.readyState !== 1) { clearTimeout(timer); rejectAttempt(error); } });
  });
}

function collect(socket: WebSocket, durationMs = 700) {
  return new Promise<Array<Record<string, unknown>>>((resolveMessages) => {
    const messages: Array<Record<string, unknown>> = [];
    const listener = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        // Do not record credentials or arbitrary payloads in the artifact.
        messages.push({ type: parsed.type, action: parsed.action, requestId: parsed.requestId, message: parsed.message, code: parsed.code });
      } catch {
        // Ignore malformed/non-JSON frames for this probe.
      }
    };
    socket.on("message", listener);
    setTimeout(() => {
      socket.off("message", listener);
      resolveMessages(messages);
    }, durationMs);
  });
}

function sendResume(socket: WebSocket, canvasId: string, requestId: string) {
  socket.send(JSON.stringify({
    type: "command",
    action: "canvas.resume",
    requestId,
    payload: { canvasId, lastSeq: 0 },
  }));
}

const tokenA = await freshToken(actorA.userId);
const tokenB = await freshToken(actorB.userId);
const collisionId = `ws-collision-${fixture.fixtureId}`;
const socketA = await open(tokenA, collisionId);
const bAttempt = await attemptOpen(tokenB, collisionId);
const socketB = bAttempt.socket;
try {
  if (bAttempt.opened) {
    // If accepted, both identities must remain isolated and A must stay usable.
    const aMessages = collect(socketA);
    const bMessages = collect(socketB);
    sendResume(socketA, actorA.canvasId, "collision-a-resume");
    const [aObserved, bObserved] = await Promise.all([aMessages, bMessages]);
    const aAck = aObserved.some((message) => message.type === "command.ack" && message.action === "canvas.resume");
    const bAck = bObserved.some((message) => message.type === "command.ack" && message.action === "canvas.resume");
    check("A receives its own resume response", aAck, aAck ? undefined : `A frames=${JSON.stringify(aObserved)}`);
    check("A response is not routed to B", !bAck, bAck ? "A canvas.resume ack observed on B socket" : undefined);

    socketA.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const bAfterClose = collect(socketB);
    sendResume(socketB, actorB.canvasId, "collision-b-resume");
    const bAfterCloseMessages = await bAfterClose;
    const bAckAfterClose = bAfterCloseMessages.some((message) => message.type === "command.ack" && message.action === "canvas.resume");
    check("closing A preserves B replacement connection", bAckAfterClose, bAckAfterClose ? undefined : `B frames=${JSON.stringify(bAfterCloseMessages)}`);
  } else {
    check("cross-tenant collision is explicitly rejected", bAttempt.closeCode !== undefined && bAttempt.closeCode !== 1006, `closeCode=${bAttempt.closeCode}`);
    const survivingA = collect(socketA);
    sendResume(socketA, actorA.canvasId, "surviving-a");
    check("rejected B leaves A usable", (await survivingA).some(message => message.type === "command.ack" && message.action === "canvas.resume"));
  }

  // A same-user reconnect with the same ID is a supported path and must retain
  // the newer socket when the older one closes.
  const sameUserId = `ws-same-user-${fixture.fixtureId}`;
  const sameUserA = await open(tokenA, sameUserId);
  const sameUserA2 = await open(tokenA, sameUserId);
  const newBeforeSend = collect(sameUserA2);
  if (sameUserA.readyState === WebSocket.OPEN) sendResume(sameUserA, actorA.canvasId, "same-user-old");
  const misrouted = await newBeforeSend;
  check("old socket command cannot deliver an ack to new socket", !misrouted.some((message) => message.type === "command.ack"), JSON.stringify(misrouted));
  sameUserA.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const sameUserNew = collect(sameUserA2);
  sendResume(sameUserA2, actorA.canvasId, "same-user-new");
  const newFrames = await sameUserNew;
  check("same-user replacement remains usable after old close", newFrames.some((message) => message.type === "command.ack" && message.action === "canvas.resume"), JSON.stringify(newFrames));
  sameUserA2.close();
} finally {
  socketA.close();
  socketB.close();
}

const reportPath = resolve(`../../artifacts/saas-boundary/ws-connection-collision-${fixture.fixtureId}-retest.json`);
await writeFile(reportPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  fixtureId: fixture.fixtureId,
  kind: "real-local-api-websocket-connection-id-collision",
  connectionIdCollision: true,
  providerRequests: 0,
  applicationDataWrites: 0,
  authSideEffect: "admin auth link/verify used to mint fresh JWTs; not counted as application-data writes",
  tokensPrinted: false,
  checks,
}, null, 2));
console.log(JSON.stringify({ report: reportPath, checks: checks.length, failed: checks.filter((result) => !result.passed).length, providerRequests: 0, applicationDataWrites: 0 }));
if (checks.some((result) => !result.passed)) process.exitCode = 1;
