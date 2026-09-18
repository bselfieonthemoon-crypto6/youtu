/**
 * Isolated live acceptance for the server-owned autonomy loop.
 *
 * This deliberately has no cleanup path: QA projects, canvas, session, design,
 * job and assets remain available for investigation. It only starts one
 * foreground agent run when --submit is present; that is not a provider-call
 * counter. Secrets are loaded from the existing local
 * replica environment and never included in stdout or the report.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
const { Client } = require("pg") as typeof import("pg");
const { WebSocket } = require("ws") as typeof import("ws");

const API = "http://127.0.0.1:3002";
const DB_NAME = "loomic_replica_light_20260907";
const VERIFIED_IMAGE_PROVIDER_CONFIG_ID = "95e5b26e-b906-4dce-8745-ad0c1638b6f6";
const submit = process.argv.includes("--submit");
type LiveReport = {
  suite: string; startedAt: string; mode: string;
  testExpectations: { desiredImageSubmissions: number; clientImageConfirmationCommands: number };
  enforcedAutonomyGrant: { maxRounds: number; maxImages: number; expiresAfterHours: number };
  assertions: Array<{ name: string; passed: boolean; detail?: string }>;
  fixture: Record<string, string>; observations: Record<string, unknown>; result: Record<string, unknown>; finishedAt?: string;
};
const report: LiveReport = {
  suite: "agent-autonomy-live-delivery",
  startedAt: new Date().toISOString(),
  mode: submit ? "live-submit" : "readonly-preflight",
  testExpectations: { desiredImageSubmissions: 1, clientImageConfirmationCommands: 0 },
  enforcedAutonomyGrant: { maxRounds: 24, maxImages: 8, expiresAfterHours: 2 },
  assertions: [] as Array<{ name: string; passed: boolean; detail?: string }>,
  fixture: {} as Record<string, string>,
  observations: {} as Record<string, unknown>,
  result: {} as Record<string, unknown>,
};

function assertLocal() {
  const db = new URL(process.env.SUPABASE_DB_URL ?? "postgres://invalid/invalid");
  assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421", "fixed local Supabase URL required");
  assert.equal(db.hostname, "127.0.0.1", "local database host required");
  assert.equal(db.pathname, `/${DB_NAME}`, "fixed replica database required");
}

function pass(name: string, detail?: string) {
  report.assertions.push({ name, passed: true, ...(detail ? { detail } : {}) });
  console.log(`PASS ${name}`);
}

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=?[^\s,;]+/gi, "$1=[redacted]");
}

function publicText(value: unknown, maxLength = 4_000) {
  const text = safeError(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…[truncated]`;
}

function publicToolSummary(blocks: unknown): Array<{ toolName: string; status: string; resultStatus?: string; errorCode?: string }> {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: any) => {
    if (block?.type !== "tool" || typeof block.toolName !== "string") return [];
    const output = block.output && typeof block.output === "object" ? block.output : {};
    const errorCode = typeof output.error_code === "string" ? output.error_code
      : typeof output.error === "string" ? output.error : undefined;
    return [{ toolName: block.toolName, status: typeof block.status === "string" ? block.status : "unknown",
      ...(typeof output.status === "string" ? { resultStatus: output.status } : {}),
      ...(errorCode ? { errorCode: publicText(errorCode, 200) } : {}) }];
  });
}

async function captureFailureEvidence() {
  if (!database || !isolatedSessionId) return;
  try {
    const [assistantMessage, runs, jobs, confirmations] = await Promise.all([
      database.query(
        "select content,content_blocks from chat_messages where session_id=$1 and role='assistant' order by created_at desc limit 1",
        [isolatedSessionId],
      ),
      database.query(
        "select id,status,model,error_code,error_message,created_at,started_at,completed_at from agent_runs where session_id=$1 order by created_at desc",
        [isolatedSessionId],
      ),
      database.query(
        "select id,status,error_code,error_message,created_at,started_at,completed_at from background_jobs where session_id=$1 order by created_at desc",
        [isolatedSessionId],
      ),
      database.query(
        "select confirmation_id,kind,status,origin_run_id,created_at,expires_at from agent_action_confirmations where session_id=$1 order by created_at desc",
        [isolatedSessionId],
      ),
    ]);
    const message = assistantMessage.rows[0];
    report.observations.failure = {
      foregroundRunId: lastForegroundRunId ?? null,
      ...(message ? {
        persistedTools: publicToolSummary(message.content_blocks),
        finalAssistantText: publicText(message.content),
      } : {}),
      agentRuns: runs.rows.map(row => ({
        id: row.id, status: row.status, model: row.model ?? null,
        errorCode: row.error_code ?? null,
        errorMessage: row.error_message ? publicText(row.error_message, 500) : null,
        createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
      })),
      backgroundJobs: jobs.rows.map(row => ({
        id: row.id, status: row.status, errorCode: row.error_code ?? null,
        errorMessage: row.error_message ? publicText(row.error_message, 500) : null,
        createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
      })),
      durableConfirmations: confirmations.rows.map(row => ({
        confirmationId: row.confirmation_id, kind: row.kind, status: row.status,
        originRunId: row.origin_run_id, createdAt: row.created_at, expiresAt: row.expires_at,
      })),
    };
  } catch (evidenceError) {
    report.observations.failureEvidenceError = publicText(evidenceError, 500);
  }
}

let token = "";
let ws: import("ws").WebSocket | undefined;
let database: import("pg").Client | undefined;
let isolatedSessionId: string | undefined;
let autonomyDisabled = false;
let lastForegroundRunId: string | undefined;
const outboundWsCommands: Array<{ action: string; hasImageConfirmation: boolean }> = [];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function api<T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> {
  const response = await fetch(API + path, {
    method, headers: body === undefined ? { Authorization: `Bearer ${token}` } : headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${safeError(JSON.stringify(data))}`);
  return data as T;
}

async function connect() {
  ws?.close();
  ws = new WebSocket(`ws://127.0.0.1:3002/api/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
}

/** One foreground browser run.  It must finish before the confirmation is
 * supplied; the autonomy scheduler then owns the background continuation. */
async function foregroundRun(input: Record<string, unknown>) {
  const requestId = randomUUID();
  return await new Promise<{ events: any[]; runId?: string }>((resolve, reject) => {
    const events: any[] = []; let runId: string | undefined;
    const timer = setTimeout(() => done(new Error("foreground run timeout")), 180_000);
    const done = (error?: Error) => {
      clearTimeout(timer); ws?.off("message", onMessage);
      if (error) reject(error); else if (runId) resolve({ events, runId }); else resolve({ events });
    };
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "rpc.request") {
        ws?.send(JSON.stringify({ type: "rpc.response", id: message.id, error: "Live QA has no browser screenshot; use persisted target state." }));
        return;
      }
      if (message.type === "error" && message.requestId === requestId) return done(new Error(message.code ?? message.message));
      if (message.type === "command.ack" && message.requestId === requestId) {
        runId = message.payload?.runId;
        lastForegroundRunId = runId;
      }
      if (message.type !== "event" || (runId && message.event?.runId !== runId)) return;
      events.push(message.event);
      if (["run.completed", "run.failed", "run.canceled"].includes(message.event?.type))
        return message.event.type === "run.completed" ? done() : done(new Error(message.event?.error?.message ?? message.event.type));
    };
    ws!.on("message", onMessage);
    outboundWsCommands.push({ action: "agent.run", hasImageConfirmation: "imageConfirmation" in input });
    ws!.send(JSON.stringify({ type: "command", action: "agent.run", accessToken: token, requestId, payload: input }));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, timeoutMs = 360_000) {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 2_000)); }
  throw new Error(`${label} timed out`);
}

try {
  assertLocal();
  database = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await database.connect();
  const db = database;
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

  // This existing local QA owner is used only to reuse its published provider
  // configuration.  All application data created below is new and isolated.
  const ownerId = process.env.LOOMIC_LIVE_QA_OWNER_ID ?? "541006fa-d2a1-4305-be55-b6263c27a1e3";
  const account = await admin.auth.admin.getUserById(ownerId);
  assert(!account.error && account.data.user?.email, "local QA owner unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email! });
  assert(!link.error && link.data.properties.hashed_token, "local magic-link unavailable");
  const login = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  assert(!login.error && login.data.session?.access_token, "local login unavailable");
  token = login.data.session.access_token;

  const health = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(10_000) });
  assert(health.ok, "API health unavailable"); pass("API reachable");
  const viewer = await api<{ workspace: { id: string } }>("GET", "/api/viewer");
  assert(viewer.workspace.id, "authenticated viewer workspace missing"); pass("authenticated application session");
  const autonomy = await api<{ available: boolean; defaultEnabled: boolean }>("GET", "/api/chat/sessions/00000000-0000-4000-8000-000000000000/autonomy").catch(() => null);
  // A fake owned session must not be considered a capability result.  The real
  // session below is the authoritative readiness check.
  void autonomy;
  // This mirrors WorkspaceModelCatalogService.listPublished: an enabled row is
  // not published until its provider connection last tested successfully.
    const exactModel = await db.query(
    `select m.catalog_key from workspace_members member
      join workspace_provider_configs c on c.workspace_id=member.workspace_id
      join workspace_provider_models m on m.provider_config_id=c.id
      where member.user_id=$1 and member.workspace_id=$2 and c.id=$3 and c.enabled and c.last_test_status='succeeded'
        and m.enabled and m.upstream_model_id='gpt-image-2' and m.modality='image'
        and m.capabilities ? 'image_generation' limit 1`, [ownerId, viewer.workspace.id, VERIFIED_IMAGE_PROVIDER_CONFIG_ID]);
    assert.equal(exactModel.rowCount, 1, "published exact gpt-image-2 image model is required; gpt-image-2-all is not substituted");
    const exactModelRef = `workspace:${exactModel.rows[0].catalog_key}`;
    pass("published exact gpt-image-2 available");
  if (!submit) { report.result = { note: "Preflight only. Re-run with --submit after coordinator approval; no model or image request was submitted." }; await db.end(); }
  else {
    const project = await api<{ project: { id: string; primaryCanvas: { id: string } } }>("POST", "/api/projects", { name: `QA autonomy live delivery ${report.startedAt}` }, 201);
    const canvas = await api<{ canvas: { revision: number } }>("GET", `/api/canvases/${project.project.primaryCanvas.id}`);
    const design = await api<{ design_id: string }>("POST", "/api/designs", {
      request_id: randomUUID(), canvas_id: project.project.primaryCanvas.id, expected_canvas_revision: canvas.canvas.revision,
      canvas_element_id: `qa-live-${randomUUID()}`, name: "QA isolated delivery board", width: 512, height: 512,
      background: "#f8fafc", node: { x: 120, y: 120, width: 512, height: 512 },
    }, 201);
    const session = await api<{ session: { id: string } }>("POST", `/api/canvases/${project.project.primaryCanvas.id}/sessions`, { title: "QA autonomy foreground to background delivery" }, 201);
    isolatedSessionId = session.session.id;
    Object.assign(report.fixture, { projectId: project.project.id, canvasId: project.project.primaryCanvas.id, designId: design.design_id, sessionId: session.session.id, providerConfigId: VERIFIED_IMAGE_PROVIDER_CONFIG_ID });
    const policy = await api<{ available: boolean; enabled: boolean }>("GET", `/api/chat/sessions/${session.session.id}/autonomy`);
    assert(policy.available, "autonomy signing capability unavailable");
    // The local-autonomy server is deliberately started with its default enabled.
    // Do not turn this on by hand: this acceptance specifically verifies the
    // task-activation default which queues its own server continuation.
    assert(policy.enabled, "local autonomy default is not enabled for this session");
    pass("server autonomy default enabled for isolated session");
    await connect();
    const prompt = "请直接在当前画板中央生成一只简洁的橙色纸艺小狐狸，透明背景，单张 PNG，不要文字。使用已选 gpt-image-2，只生成一张；无需等待我再次确认，完成后自动检查结果并保存到当前画板。";
    await api("POST", `/api/sessions/${session.session.id}/messages`, { role: "user", content: prompt, contentBlocks: [{ type: "text", text: prompt }] }, 201);
    const first = await foregroundRun({
      sessionId: session.session.id,
      conversationId: project.project.primaryCanvas.id,
      canvasId: project.project.primaryCanvas.id,
      activeDesignId: design.design_id,
      designTask: { target: { kind: "design", designId: design.design_id } },
      imageGenerationPreference: { mode: "manual", models: [exactModelRef] },
      prompt,
    });
    // Persist only a compact, redacted public trace before any assertion can
    // fail. This distinguishes a missing durable proposal from a model run
    // that never completed, without retaining arbitrary tool inputs/outputs.
    const assistantMessage = await waitFor(async () => {
      const messages = await db.query(
        "select content,content_blocks from chat_messages where session_id=$1 and role='assistant' order by created_at desc limit 1",
        [session.session.id],
      );
      return messages.rows[0];
    }, "persisted foreground assistant message", 30_000);
    report.observations.foreground = {
      runId: first.runId ?? null,
      websocketTools: first.events.filter(event => event.type === "tool.completed").map(event => ({
        toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
        status: typeof event.output?.error === "string" ? "error" : "completed",
        ...(typeof event.output?.error === "string" ? { errorCode: publicText(event.output.error, 200) } : {}),
      })),
      persistedTools: publicToolSummary(assistantMessage.content_blocks),
      finalAssistantText: publicText(assistantMessage.content),
    };
    const proposal = first.events.find(event => event.type === "tool.completed" && event.toolName === "generate_image" && event.output?.status === "awaiting_confirmation")?.output;
    assert(proposal?.confirmation?.confirmationId, "foreground run did not produce a durable image proposal");
    assert.equal(proposal.confirmation.details?.target?.design_id, design.design_id, "proposal target must be the isolated design");
    pass("foreground proposal completed before confirmation");
    assert.equal(outboundWsCommands.filter(command => command.hasImageConfirmation).length,
      report.testExpectations.clientImageConfirmationCommands,
      "live harness must not send an imageConfirmation command");
    pass("no client image confirmation command was sent");
    // Critical boundary: do not send an imageConfirmation from the foreground
    // client. The server scheduler may have legally confirmed and queued the
    // durable proposal already, so do not race it by asserting an empty queue.
    ws?.close(); ws = undefined;
    pass("foreground client disconnected before background confirmation");
    const immediateTrace = await db.query(
      "select id,status,created_at from background_jobs where session_id=$1 order by created_at desc", [session.session.id]);
    assert((immediateTrace.rowCount ?? 0) <= 1, "duplicate image job detected immediately after client disconnect");
    const immediateAutonomy = await api<{ state: string; imagesReserved: number }>("GET", `/api/chat/sessions/${session.session.id}/autonomy`);
    report.observations.afterClientDisconnect = {
      backgroundJobs: immediateTrace.rows.map(row => ({ id: row.id, status: row.status, createdAt: row.created_at })),
      autonomyState: immediateAutonomy.state,
      imagesReserved: immediateAutonomy.imagesReserved,
    };
    pass("server-owned continuation trace observed after client disconnect", `${immediateTrace.rowCount ?? 0} job(s), autonomy=${immediateAutonomy.state}`);
    const job = await waitFor(async () => {
      const rows = await db.query("select id,status,result,error_code,payload from background_jobs where session_id=$1 order by created_at desc", [session.session.id]);
      if ((rows.rowCount ?? 0) > 1) throw new Error("duplicate image job detected; stopping isolated autonomy grant");
      const autonomy = await api<{ state: string; imagesReserved: number }>("GET", `/api/chat/sessions/${session.session.id}/autonomy`);
      if (autonomy.state === "needs_attention" || autonomy.state === "stopped")
        throw new Error(`server autonomy ended before image delivery: state=${autonomy.state}`);
      if (autonomy.imagesReserved >= 3)
        throw new Error("three image proposals were reserved without delivery; stopping isolated autonomy grant");
      const candidate = rows.rows[0]; return candidate && ["succeeded", "failed", "canceled", "dead_letter"].includes(candidate.status) ? candidate : undefined;
    }, "server-owned confirmation and real image worker");
    assert.equal(job.status, "succeeded", `worker did not deliver: ${job.error_code ?? job.status}`);
    assert.equal(job.payload?.model, exactModelRef, "worker must retain the selected exact gpt-image-2 catalog model");
    assert(typeof job.result?.asset_id === "string", "delivered job missing persisted asset"); pass("one real worker image succeeded");
    const visual = await waitFor(async () => {
      const task = await api<{ task: any }>("GET", `/api/chat/sessions/${session.session.id}/design-task`);
      const verification = task.task?.brief?.verification;
      const autonomy = await api<{ state: string; outcome: unknown }>("GET", `/api/chat/sessions/${session.session.id}/autonomy`);
      const verificationPassed = verification?.visualStatus === "passed" && verification?.savedStatus === "synced";
      if (verification && (verification.visualStatus === "failed" || verification.visualStatus === "unavailable" ||
        verification.savedStatus === "invalidated")) {
        throw new Error(`server verification did not pass: visual=${verification.visualStatus}, saved=${verification.savedStatus}`);
      }
      if (autonomy.state === "needs_attention" || autonomy.state === "stopped") {
        throw new Error(`server autonomy did not complete: state=${autonomy.state}`);
      }
      if (autonomy.state === "completed" && !verificationPassed) {
        throw new Error("server autonomy completed without passed visual and saved verification");
      }
      return verificationPassed && autonomy.state === "completed"
        ? { task, verification, autonomy }
        : undefined;
    }, "server visual verification and completed autonomy", 300_000);
    const doc = await db.query("select revision,preview_revision,preview_asset_object_id,scene from design_documents where id=$1", [design.design_id]);
    assert.equal(doc.rowCount, 1, "isolated design missing after delivery");
    assert(doc.rows[0].preview_asset_object_id, "design has no persisted preview asset");
    assert(Array.isArray(doc.rows[0].scene?.objects) && doc.rows[0].scene.objects.length > 0, "design scene has no delivered object");
    pass("server visual verification, saved design asset, and autonomy completion passed");
    const runs = await db.query("select count(*)::int as n from agent_runs where session_id=$1", [session.session.id]).catch(() => ({ rows: [{ n: null }] }));
    const jobCount = await db.query("select count(*)::int as n from background_jobs where session_id=$1", [session.session.id]);
    assert.equal(jobCount.rows[0].n, report.testExpectations.desiredImageSubmissions,
      "live acceptance must not submit a second image job");
    report.result = { jobId: job.id, assetId: job.result.asset_id, verification: visual.verification, autonomy: visual.autonomy, designRevision: doc.rows[0].revision, previewAssetId: doc.rows[0].preview_asset_object_id,
      imageSubmissionCount: jobCount.rows[0].n, agentRunRecordCount: runs.rows[0].n,
      textCallCounting: "agent_runs records are a lower-fidelity execution proxy, not an exact provider-request counter; this run does not claim the 20-call ceiling is independently verified." };
    // Bound any further unattended work after the exact checked result is recorded.
    await api("PUT", `/api/chat/sessions/${session.session.id}/autonomy`, { enabled: false });
    autonomyDisabled = true;
    await db.end();
  }
} catch (error) {
  await captureFailureEvidence();
  report.result = { error: safeError(error) };
  if (isolatedSessionId && token && !autonomyDisabled) {
    try {
      await api("PUT", `/api/chat/sessions/${isolatedSessionId}/autonomy`, { enabled: false });
      autonomyDisabled = true;
      report.result = { ...report.result, autonomyDisabledAfterFailure: true };
    } catch (disableError) {
      report.result = { ...report.result, autonomyDisableError: safeError(disableError) };
    }
  }
  process.exitCode = 1;
} finally {
  ws?.close();
  await database?.end().catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  const evidenceDirectory = new URL("../../../artifacts/agent-autonomy-live/", import.meta.url);
  const timestamp = report.startedAt.replace(/[:.]/g, "-");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(new URL("../../../artifacts/agent-autonomy-live/latest.json", import.meta.url), JSON.stringify(report, null, 2));
  await writeFile(new URL(`../../../artifacts/agent-autonomy-live/live-attempt-${timestamp}.json`, import.meta.url), JSON.stringify(report, null, 2));
  console.log(`REPORT artifacts/agent-autonomy-live/latest.json`);
}
