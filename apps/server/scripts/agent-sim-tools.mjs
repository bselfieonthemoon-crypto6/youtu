// Stateless driver for simulated-user Agent testing.
//
// One process = one operation. Nothing is cached between calls, so several
// personas (and several parallel turns in the same session) can use it at once:
// the fixture file is only ever read, and each turn writes its own report.
//
// Modes:
//   models                                  text/image models, workspace, credits
//   skills [--query text]                   published skills (slug, name, enabled)
//   create [--name label] --out <json>      project + canvas + session fixture
//   upload --file <path> [--project id]     upload an image, print attachment JSON
//   seed-canvas --canvas <id> --source <p>  put an image element on the canvas
//   turn ... --text "..." [--out <json>]    send one user message and record the run
//   state ... [--out <json>]                full evidence for a fixture/session
//   wait-jobs ... [--timeout-minutes n]     wait for image/video jobs to settle
//   check ... [--allow <code>] [--out <j>]   assert structural invariants, exit 1 on violation
//   cancel ...                              cancel in-flight runs and jobs
//
// Session selection: either `--fixture <json>` (from `create`) or explicit
// `--session <id> --canvas <id> --workspace <id>`.
//
// Turn options: --text, --text-file <path>, --skill <slug>, --attach <json file
// or inline JSON>, --aspect <W:H>, --image-model <id>, --text-model <id>,
// --mode thinking|fast, --image-pref manual|auto, --timeout-minutes, --no-wait,
// --out <report>.
//
// Operational notes learned from a 12-persona campaign:
//   * Long prompts with quotes must use --text-file: PowerShell swallows part of
//     a quoted argument, and a mangled prompt looks like an Agent defect.
//   * The local gateway saturates under concurrency (429 "上游负载已饱和",
//     504 "Upstream model timed out"). Those are provider failures, not product
//     ones; do not run many image turns at once and re-run a dead_letter before
//     filing it. `check --allow unfinished_jobs` when a job is deliberately left
//     running.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(new URL("../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js");

const API = process.env.LOOMIC_LIVE_API ?? "http://127.0.0.1:3002";
const DEFAULT_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const RUN_TERMINAL = new Set(["completed", "failed", "canceled"]);
const JOB_TERMINAL = new Set(["succeeded", "failed", "canceled", "dead_letter"]);
const MAX_TEXT = 24_000;

const argv = process.argv.slice(2);
function flag(name) {
  const inline = argv.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}
function allFlags(name) {
  const out = [];
  argv.forEach((argument, index) => {
    if (argument === `--${name}`) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) out.push(next);
    } else if (argument.startsWith(`--${name}=`)) {
      out.push(argument.slice(name.length + 3));
    }
  });
  return out;
}
const has = name => argv.includes(`--${name}`) || argv.some(argument => argument.startsWith(`--${name}=`));
const mode = argv.find(argument => !argument.startsWith("--")) ?? "state";
const minutes = name => {
  const value = Number(flag(name) ?? "20");
  assert(Number.isFinite(value) && value > 0 && value <= 120, `--${name} must be 1..120 minutes`);
  return value * 60_000;
};

const clip = (value, max = MAX_TEXT) => {
  if (typeof value !== "string") return value;
  return value.length <= max ? value : `${value.slice(0, max)}…[clipped ${value.length - max} chars]`;
};
const redact = text => String(text)
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");
const trim = value => {
  if (typeof value === "string") return clip(redact(value), 2_000);
  if (Array.isArray(value)) return value.slice(0, 40).map(trim);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = trim(item);
    return out;
  }
  return value;
};

/** The upload route rejects an unknown MIME type; FormData does not infer it. */
function mimeTypeFor(name) {
  const extension = name.toLowerCase().split(".").pop();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" }[extension]
    ?? "application/octet-stream";
}

async function session() {
  const fixturePath = flag("fixture");
  const fixture = fixturePath ? JSON.parse(await readFile(resolve(fixturePath), "utf8")) : {};
  const sessionId = flag("session") ?? fixture.sessionId;
  const canvasId = flag("canvas") ?? fixture.canvasId;
  const workspaceId = flag("workspace") ?? fixture.workspaceId;
  return { fixturePath, fixture, sessionId, canvasId, workspaceId,
    textModel: flag("text-model") ?? fixture.textModel,
    imageModel: flag("image-model") ?? fixture.imageModel,
    ownerId: flag("owner") ?? fixture.ownerId ?? process.env.LOOMIC_LIVE_QA_OWNER_ID ?? DEFAULT_OWNER };
}

let context;
async function connect() {
  if (context) return context;
  const settings = await session();
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(supabaseUrl?.includes("127.0.0.1") || supabaseUrl?.includes("localhost"), "local Supabase required");
  assert(serviceRole, "SUPABASE_SERVICE_ROLE_KEY required");
  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const account = await admin.auth.admin.getUserById(settings.ownerId);
  assert(!account.error && account.data.user?.email, "local QA owner unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  assert(!link.error, "magic link unavailable");
  const auth = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  assert(!login.error && login.data.session?.access_token, "local login unavailable");
  const token = login.data.session.access_token;
  const api = async (method, path, body, expected = 200) => {
    const response = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: clip(text, 2_000) }; }
    assert.equal(response.status, expected, `${method} ${path} -> ${response.status} ${redact(text).slice(0, 500)}`);
    return data;
  };
  context = { ...settings, admin, token, api,
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRole } };
  return context;
}

const rest = async (path) => {
  const { admin } = await connect();
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert(response.ok, `REST ${path} -> ${response.status} ${redact(text).slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
};

const messageView = (message) => ({
  id: message.id, role: message.role, createdAt: message.createdAt ?? message.created_at,
  content: clip(message.content ?? "", 6_000),
  blocks: (message.contentBlocks ?? message.content_blocks ?? []).map(block => {
    if (block.type === "tool") {
      const output = block.output ?? {};
      const jobIds = [...new Set(JSON.stringify([output.jobId, output.job_id, output.result])
        .match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [])];
      return { type: "tool", toolName: block.toolName, status: block.status,
        outputSummary: clip(block.outputSummary ?? "", 500),
        ...(jobIds.length ? { jobIds } : {}),
        output: trim(output), input: trim(block.input ?? {}),
        ...(block.artifacts?.length ? { artifacts: trim(block.artifacts) } : {}),
        ...(block.retryable !== undefined ? { retryable: block.retryable } : {}) };
    }
    if (block.type === "thinking") return { type: "thinking", chars: (block.thinking ?? "").length };
    if (block.type === "text") return { type: "text", text: clip(block.text ?? "", 6_000) };
    if (block.type === "plan") return { type: "plan", steps: (block.steps ?? []).map(step => ({ title: step.title, status: step.status })) };
    return { type: block.type ?? "unknown" };
  }),
});

const jobView = (row) => ({
  id: row.id, status: row.status, jobType: row.job_type, operation: row.payload?.operation ?? null,
  model: row.payload?.model ?? null, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
  creditsCost: row.credits_cost ?? null, creditsTransactionId: row.credits_transaction_id ?? null,
  // A chat card is written for a Mastra-submitted job; the legacy proposal flow
  // presents results differently, so `check` must not demand a card for it.
  mastraSubmission: Boolean(row.payload?.mastra_submission_key),
  errorCode: row.error_code ?? null, errorMessage: row.error_message ? clip(redact(row.error_message), 1_200) : null,
  result: trim(row.result ?? {}),
});

async function sessionJobs(settings) {
  const rows = await rest(`background_jobs?session_id=eq.${settings.sessionId}&select=id,status,job_type,payload,result,error_code,error_message,credits_cost,credits_transaction_id,created_at,started_at,completed_at&order=created_at.asc`);
  return rows.map(jobView);
}
async function sessionRuns(settings) {
  const rows = await rest(`agent_runs?session_id=eq.${settings.sessionId}&select=id,status,model,execution_mode,request_prompt,created_at,started_at,completed_at,error_code,error_message&order=created_at.asc`);
  return rows.map(row => ({ id: row.id, status: row.status, model: row.model ?? null,
    executionMode: row.execution_mode ?? null, prompt: clip(redact(row.request_prompt ?? ""), 400),
    createdAt: row.created_at, startedAt: row.started_at ?? null, completedAt: row.completed_at,
    errorCode: row.error_code ?? null,
    error: row.error_message ? clip(redact(row.error_message), 1_200) : null }));
}
async function canvasSummary(settings) {
  if (!settings.canvasId) return null;
  const { admin } = await connect();
  const canvas = await admin.from("canvases").select("content,revision").eq("id", settings.canvasId).maybeSingle();
  if (canvas.error) return { error: redact(canvas.error.message) };
  const content = canvas.data?.content ?? {};
  const elements = (content.elements ?? []).filter(element => !element.isDeleted);
  const files = content.files ?? {};
  return {
    revision: canvas.data?.revision ?? null,
    elementCount: elements.length,
    byType: elements.reduce((acc, element) => ({ ...acc, [element.type]: (acc[element.type] ?? 0) + 1 }), {}),
    images: elements.filter(element => element.type === "image").map(element => ({
      id: element.id, x: Math.round(element.x), y: Math.round(element.y),
      width: Math.round(element.width), height: Math.round(element.height),
      assetId: element.customData?.assetId ?? files[element.fileId]?.assetId ?? null,
      operation: element.customData?.operation ?? null,
      status: element.customData?.status ?? null,
      sourceJobId: element.customData?.sourceJobId ?? element.customData?.jobId ?? null,
    })),
    // Both placeholder kinds belong here: the image pipeline creates
    // `image-generator` boxes (and `image-replacement` ones for edit flows), and
    // an invariant that only saw one kind silently checked nothing.
    placeholders: elements.filter(element => ["image-replacement", "image-generator"].includes(element.customData?.type)).map(element => ({
      id: element.id, type: element.customData?.type ?? null,
      operation: element.customData?.operation ?? null, status: element.customData?.status ?? null,
      x: Math.round(element.x), y: Math.round(element.y), jobId: element.customData?.jobId ?? element.customData?.sourceJobId ?? null,
    })),
    fileCount: Object.keys(files).length,
  };
}

/* ---------------------------------------------------------------- models/skills */

async function runModels() {
  const { api, workspaceId } = await connect();
  const viewer = await api("GET", "/api/viewer");
  const [textModels, imageModels, videoModels] = await Promise.all([
    api("GET", "/api/models"), api("GET", "/api/image-models"), api("GET", "/api/video-models").catch(() => ({ models: [] })),
  ]);
  console.log(JSON.stringify({ workspace: viewer.workspace?.id ?? workspaceId, credits: viewer.credits?.balance ?? null,
    textModels: textModels.models, imageModels: imageModels.models, videoModels: videoModels.models }, null, 2));
}

async function runSkills() {
  const query = typeof flag("query") === "string" ? flag("query") : undefined;
  // `skills` has no `enabled` column in this schema: selection is by membership of
  // the run's enabled package set, not a per-row flag.
  const rows = await rest("skills?select=slug,name,category,description,version,metadata&order=slug.asc");
  const filtered = query ? rows.filter(row => `${row.slug} ${row.name} ${row.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) : rows;
  console.log(JSON.stringify({ count: filtered.length, skills: filtered.map(row => ({
    slug: row.slug, name: row.name, category: row.category ?? null, version: row.version ?? null,
    outputKinds: row.metadata?.loomic?.outputKinds ?? [],
    role: row.metadata?.loomic?.composition?.role ?? null,
    execution: row.metadata?.loomic?.execution ?? null,
    description: clip(row.description ?? "", 240),
  })) }, null, 2));
}

/* ------------------------------------------------------------------- fixtures */

async function runCreate() {
  const { api, workspaceId, ownerId } = await connect();
  const label = typeof flag("name") === "string" ? flag("name") : `sim ${new Date().toISOString()}`;
  const project = await api("POST", "/api/projects", { name: label }, 201);
  const canvasId = project.project.primaryCanvas.id;
  const created = await api("POST", `/api/canvases/${canvasId}/sessions`, { title: label }, 201);
  const [texts, images] = await Promise.all([api("GET", "/api/models"), api("GET", "/api/image-models")]);
  const textModel = flag("text-model") ?? texts.models.find(model => model.accessible !== false)?.id;
  const imageModel = flag("image-model") ?? images.models.find(model => model.accessible !== false)?.id;
  const fixture = { createdAt: new Date().toISOString(), label, ownerId, workspaceId,
    projectId: project.project.id, canvasId, sessionId: created.session.id, textModel, imageModel,
    availableTextModels: texts.models.map(model => model.id),
    availableImageModels: images.models.map(model => ({ id: model.id, name: model.displayName ?? model.name })) };
  if (typeof flag("out") === "string") {
    const path = resolve(flag("out"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  console.log(JSON.stringify(fixture, null, 2));
}

async function runUpload() {
  const { token, api } = await connect();
  const file = flag("file");
  assert(typeof file === "string", "--file <path> required");
  const bytes = await readFile(resolve(file));
  const name = file.split(/[\\/]/).pop();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeTypeFor(name) }), name);
  if (typeof flag("project") === "string") form.append("projectId", flag("project"));
  const response = await fetch(`${API}/api/uploads`, { method: "POST",
    headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  assert(response.ok, `upload -> ${response.status} ${redact(text).slice(0, 300)}`);
  const payload = JSON.parse(text);
  const attachment = { assetId: payload.asset.id, url: payload.url,
    mimeType: payload.asset.mime_type ?? payload.asset.mimeType ?? "image/png", name };
  const out = resolve(flag("out") ?? `artifacts/agent-sim/attachments/${Date.now()}-${name}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(attachment, null, 2)}\n`);
  console.log(JSON.stringify({ ...attachment, bytes: bytes.length, savedTo: out }, null, 2));
  void api;
}

async function runSeedCanvas() {
  const settings = await session();
  assert(settings.canvasId, "--canvas or --fixture required");
  const source = flag("source");
  assert(typeof source === "string", "--source <image path> required");
  const { admin, api, token } = await connect();
  const bytes = await readFile(resolve(source));
  const form = new FormData();
  const sourceName = source.split(/[\\/]/).pop();
  const sourceMime = mimeTypeFor(sourceName);
  form.append("file", new Blob([bytes], { type: sourceMime }), sourceName);
  const uploadResponse = await fetch(`${API}/api/uploads`, { method: "POST",
    headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(120_000) });
  const uploadText = await uploadResponse.text();
  assert(uploadResponse.ok, `upload -> ${uploadResponse.status} ${redact(uploadText).slice(0, 300)}`);
  const uploaded = JSON.parse(uploadText);
  const canvas = await admin.from("canvases").select("content").eq("id", settings.canvasId).single();
  assert(!canvas.error, `canvas read failed: ${canvas.error?.message}`);
  const content = canvas.data.content ?? { elements: [], appState: {}, files: {} };
  const elementId = `sim-image-${Date.now()}`;
  const fileId = `sim-file-${Date.now()}`;
  const width = Number(flag("width") ?? 900);
  const height = Number(flag("height") ?? 1200);
  const element = { type: "image", id: elementId, x: Number(flag("x") ?? 0), y: Number(flag("y") ?? 0),
    width, height, angle: 0, fileId, status: "saved", scale: [1, 1], crop: null, groupIds: [], boundElements: null,
    frameId: null, index: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(),
    link: null, locked: false, opacity: 100, roundness: null, strokeColor: "transparent",
    backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0,
    customData: { assetId: uploaded.asset.id } };
  const saved = await api("PUT", `/api/canvases/${settings.canvasId}`, { content: {
    ...content,
    elements: [...(content.elements ?? []), element],
    files: { ...(content.files ?? {}), [fileId]: { id: fileId, dataURL: `data:image/png;base64,${bytes.toString("base64")}`,
      mimeType: "image/png", created: Date.now(), assetId: uploaded.asset.id } },
  } });
  console.log(JSON.stringify({ canvasId: settings.canvasId, elementId, fileId, width, height,
    assetId: uploaded.asset.id, revision: saved.revision }, null, 2));
}

/* ----------------------------------------------------------------------- turn */

async function runTurn() {
  const settings = await session();
  const textFile = flag("text-file");
  const text = typeof textFile === "string"
    ? (await readFile(resolve(textFile), "utf8")).trim()
    : flag("text");
  assert(typeof text === "string" && text.trim(), "--text or --text-file required");
  // PowerShell mangles an argument that mixes quoting with inner double quotes:
  // a persona asked for `在图上写 "OPEN 9-18"` and the product received
  // `在图上写 OPEN`, which produced a false "the agent dropped the user's text"
  // finding. Never let a mangled prompt look like a real user message.
  const quoteCount = (text.match(/"/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    console.warn(`WARNING: --text contains an odd number of double quotes (${quoteCount}); ` +
      `the shell may have swallowed part of it. Prefer --text-file for text with quotes.`);
  }
  if (typeof textFile === "string") console.log(`TEXT-FILE ${resolve(textFile)} chars=${text.length}`);
  assert(settings.sessionId && settings.canvasId, "session and canvas required");
  const { api, token, admin } = await connect();
  const attachments = [];
  for (const path of allFlags("attach")) {
    const raw = path.trim().startsWith("{") ? path : await readFile(resolve(path), "utf8");
    attachments.push(JSON.parse(raw));
  }
  const skillSlug = typeof flag("skill") === "string" ? flag("skill") : undefined;
  let mention;
  if (skillSlug) {
    const rows = await rest(`skills?slug=eq.${encodeURIComponent(skillSlug)}&select=id,name,slug`);
    assert(rows.length === 1, `skill not found: ${skillSlug}`);
    mention = { mentionType: "skill", id: rows[0].id, label: rows[0].name, slug: rows[0].slug };
  }
  const startedAt = new Date().toISOString();
  const created = await api("POST", `/api/sessions/${settings.sessionId}/messages`, {
    role: "user", content: text,
    contentBlocks: [{ type: "text", text },
      ...(mention ? [{ type: "mention", ...mention }] : []),
      ...attachments.map(item => ({ type: "image", source: "upload", ...item }))],
  }, 201);
  const report = { kind: "agent-sim-turn", at: startedAt, fixture: settings.fixturePath ?? null,
    sessionId: settings.sessionId, canvasId: settings.canvasId, prompt: text,
    userMessageId: created.message.id, skillMention: mention ?? null,
    attachments: attachments.map(item => ({ assetId: item.assetId, name: item.name, mimeType: item.mimeType })),
    events: [], tools: [], routing: [], billingErrors: [], text: "", thinkingChars: 0,
    runId: null, runStatus: null, runError: null, assistantMessages: [], jobs: [] };
  const { WebSocket } = require("ws");
  const socket = new WebSocket(`${API.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolveOpen, reject) => { socket.once("open", resolveOpen); socket.once("error", reject); });
  const requestId = randomUUID();
  const collect = (event) => {
    report.events.push({ at: new Date().toISOString(), type: event.type, ...trim(event) });
    if (event.type === "message.delta") report.text += event.delta ?? "";
    if (event.type === "thinking.delta") report.thinkingChars += (event.delta ?? "").length;
    if (event.type === "design.routing") report.routing.push(trim(event));
    if (event.type === "billing.error") report.billingErrors.push(trim(event));
    if (event.type === "tool.started") report.tools.push({ toolName: event.toolName, status: "started",
      toolCallId: event.toolCallId, at: new Date().toISOString(), input: trim(event.input ?? {}) });
    if (event.type === "tool.completed") report.tools.push({ toolName: event.toolName, status: "completed",
      toolCallId: event.toolCallId, at: new Date().toISOString(), outputSummary: clip(event.outputSummary ?? "", 600),
      output: trim(event.output ?? {}), artifacts: trim(event.artifacts ?? []) });
    if (event.type === "tool.failed") report.tools.push({ toolName: event.toolName, status: "failed",
      toolCallId: event.toolCallId, at: new Date().toISOString(), error: trim(event.error ?? {}) });
  };
  const waitForRun = new Promise((resolveRun, reject) => {
    const timer = setTimeout(() => finish(new Error("agent run timed out")), minutes("timeout-minutes"));
    const finish = (error) => { clearTimeout(timer); socket.off("message", onMessage);
      error ? reject(error) : resolveRun(); };
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "rpc.request") { socket.send(JSON.stringify({ type: "rpc.response", id: message.id,
        error: "Simulated user CLI has no browser context." })); return; }
      if (message.type === "error" && message.requestId === requestId) return finish(new Error(message.code ?? message.message));
      if (message.type === "command.ack" && message.requestId === requestId) { report.runId = message.payload?.runId ?? null;
        if (has("no-wait")) return finish(); return; }
      const event = message.type === "event" ? message.event : undefined;
      if (!event || (report.runId && event.runId !== report.runId)) return;
      collect(event);
      if (RUN_TERMINAL.has(String(event.type).slice(4)) && ["run.completed", "run.failed", "run.canceled"].includes(event.type)) {
        report.runStatus = event.type.slice(4);
        if (event.error) report.runError = trim(event.error);
        finish();
      }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "command", action: "agent.run", accessToken: token, requestId,
      payload: { sessionId: settings.sessionId, conversationId: settings.canvasId, canvasId: settings.canvasId,
        userMessageId: created.message.id, prompt: text,
        ...(attachments.length ? { attachments } : {}), ...(mention ? { mentions: [mention] } : {}),
        model: settings.textModel,
        executionMode: typeof flag("mode") === "string" ? flag("mode") : "thinking",
        imageGenerationPreference: { mode: typeof flag("image-pref") === "string" ? flag("image-pref") : "manual",
          models: [settings.imageModel],
          ...(typeof flag("aspect") === "string" ? { aspectRatio: flag("aspect") } : {}) } } }));
  });
  try {
    await waitForRun;
  } catch (error) {
    report.runTimedOut = true;
    report.runError = report.runError ?? { message: redact(error.message) };
  }
  socket.close();
  // The transcript is the authority: read it back instead of trusting deltas.
  const messages = await api("GET", `/api/sessions/${settings.sessionId}/messages`);
  report.assistantMessages = (messages.messages ?? []).filter(message => message.role === "assistant")
    .filter(message => !message.createdAt || Date.parse(message.createdAt) >= Date.parse(startedAt))
    .map(messageView);
  report.jobs = await sessionJobs(settings);
  report.workspaceCredits = (await api("GET", "/api/viewer")).credits?.balance ?? null;
  report.canvas = await canvasSummary(settings);
  if (typeof flag("out") === "string") {
    const path = resolve(flag("out"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT ${path}`);
  }
  const settled = report.jobs.filter(job => !JOB_TERMINAL.has(job.status));
  console.log(`TURN run=${report.runId ?? "none"} status=${report.runStatus ?? "unknown"} tools=${report.tools.length} ` +
    `routing=${report.routing.map(item => `${item.intent}/${item.primarySkill ?? "-"}`).join(",") || "none"} ` +
    `jobs=${report.jobs.length}${settled.length ? ` (${settled.length} still running: ${settled.map(job => `${job.id.slice(0, 8)}:${job.status}`).join(",")})` : ""} ` +
    `credits=${report.workspaceCredits}`);
  console.log(`REPLY ${clip(report.assistantMessages.map(message => message.content).join("\n"), 2_000)}`);
}

/* --------------------------------------------------------------- state/wait/cancel */

/** Save a delivered image locally so a persona can look at it instead of trusting text. */
async function runDownload() {
  const settings = await session();
  const { admin } = await connect();
  let objectPath = typeof flag("object") === "string" ? flag("object") : undefined;
  const jobId = typeof flag("job") === "string" ? flag("job") : undefined;
  if (!objectPath) {
    assert(jobId, "--job <jobId> or --object <objectPath> required");
    const rows = await rest(`background_jobs?id=eq.${jobId}&select=id,result,status`);
    assert(rows.length === 1, `job not found: ${jobId}`);
    objectPath = rows[0].result?.object_path;
    assert(typeof objectPath === "string", `job ${jobId} has no delivered object (status=${rows[0].status})`);
  }
  const signed = await admin.storage.from("workspace-assets").createSignedUrl(objectPath, 900);
  assert(!signed.error && signed.data?.signedUrl, `sign failed: ${signed.error?.message}`);
  const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `download -> ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const out = resolve(flag("out") ?? `artifacts/agent-sim/downloads/${(jobId ?? objectPath.split("/").pop()).slice(0, 40)}.png`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
  console.log(JSON.stringify({ jobId: jobId ?? null, objectPath, bytes: bytes.length, savedTo: out,
    ...(jobId && settings.sessionId
      ? { sessionJob: (await sessionJobs(settings)).find(job => job.id === jobId) ?? null }
      : {}) }, null, 2));
}

async function runState() {
  const settings = await session();
  assert(settings.sessionId, "session required");
  const report = await collectEvidence(settings);
  if (typeof flag("out") === "string") {
    const path = resolve(flag("out"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT ${path}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

async function collectEvidence(settings) {
  const { api } = await connect();
  const messages = await api("GET", `/api/sessions/${settings.sessionId}/messages`);
  const report = { kind: "agent-sim-state", at: new Date().toISOString(), sessionId: settings.sessionId,
    canvasId: settings.canvasId,
    messages: (messages.messages ?? []).map(messageView),
    runs: await sessionRuns(settings), jobs: await sessionJobs(settings), canvas: await canvasSummary(settings) };
  const jobIds = report.jobs.map(job => job.id);
  report.billing = jobIds.length
    ? await rest(`credit_transactions?job_id=in.(${jobIds.join(",")})&select=transaction_type,amount,job_id,created_at`)
    : [];
  return report;
}

/**
 * Assertion mode: the structural invariants a persona otherwise re-derives by
 * hand (and sometimes gets wrong).
 *
 * Personas disagreed about whether a failed placeholder was a leftover bug or
 * intentional, and about whether a "正在生成中" tail after every job had settled
 * was a real defect; a shared, executable definition removes that argument. Only
 * structural facts are asserted here — never whether the design is any good.
 *
 * Options: --allow <code> (repeatable) to accept a known-environmental
 * violation, --out <json> to save the full evidence beside the verdict.
 */
const CHECK_CODES = {
  unfinished_runs: "an agent run never reached a terminal status",
  unfinished_jobs: "a generation job never reached a terminal status",
  card_not_settled: "a job reached a terminal status but its chat card still shows a non-terminal one",
  missing_terminal_card: "a terminal Mastra-submitted job has no chat card at all, so its outcome never reached the user",
  missing_canvas_delivery: "a succeeded image job has no canvas element carrying its asset",
  stale_generating_placeholder: "the canvas still shows a generating placeholder for a job that already ended",
  orphan_error_placeholder: "a failed placeholder points at a job that is not in this session",
  optimistic_tail: "the last assistant message promises work in progress while every job is already terminal",
};

async function runCheck() {
  const settings = await session();
  assert(settings.sessionId, "session required");
  const allowed = new Set(allFlags("allow"));
  const evidence = await collectEvidence(settings);
  const violations = [];
  const add = (code, detail) => { if (!allowed.has(code)) violations.push({ code, detail }); };

  for (const run of evidence.runs.filter(run => !RUN_TERMINAL.has(run.status)))
    add("unfinished_runs", `run ${run.id} is ${run.status}`);

  const jobsById = new Map(evidence.jobs.map(job => [job.id, job]));
  const jobStatus = jobId => jobsById.get(jobId)?.status;
  for (const job of evidence.jobs.filter(job => !JOB_TERMINAL.has(job.status)))
    add("unfinished_jobs", `job ${job.id} is ${job.status}`);

  // The chat card is keyed by the job id, so a terminal job whose card still
  // reports processing is exactly the "user never sees the outcome" defect.
  const cardStatus = new Map();
  for (const message of evidence.messages)
    for (const block of message.blocks)
      if (block.type === "tool") for (const jobId of block.jobIds ?? []) cardStatus.set(jobId, block.status);
  for (const job of evidence.jobs.filter(job => JOB_TERMINAL.has(job.status))) {
    const status = cardStatus.get(job.id);
    // Only the known in-flight labels count as "not settled": terminal cards use
    // several labels (completed / succeeded / failed / canceled / error), and a
    // whitelist would report a settled card as a defect.
    if (status === undefined && job.mastraSubmission)
      add("missing_terminal_card", `terminal job ${job.id} (${job.status}) has no chat card in this session`);
    else if (status !== undefined && ["queued", "running", "processing", "submitting", "generating", "pending", "in_progress"].includes(String(status)))
      add("card_not_settled", `job ${job.id} is ${job.status} but its card still shows ${status}`);
  }

  const canvasAssets = new Set((evidence.canvas?.images ?? []).map(image => image.assetId).filter(Boolean));
  for (const job of evidence.jobs.filter(job => job.status === "succeeded" && job.jobType === "image_generation")) {
    const assetId = job.result?.asset_id ?? job.result?.assetId;
    if (assetId && !canvasAssets.has(assetId))
      add("missing_canvas_delivery", `job ${job.id} succeeded with asset ${assetId} that is not on the canvas`);
  }

  const terminalStatuses = new Set(["succeeded", "failed", "canceled", "dead_letter"]);
  for (const placeholder of evidence.canvas?.placeholders ?? []) {
    const status = jobStatus(placeholder.jobId);
    if (placeholder.status === "generating" && status && terminalStatuses.has(status))
      add("stale_generating_placeholder", `placeholder ${placeholder.id} still generating for ${status} job ${placeholder.jobId}`);
    if (placeholder.status === "error" && placeholder.jobId && !status)
      add("orphan_error_placeholder", `placeholder ${placeholder.id} references job ${placeholder.jobId} outside this session`);
  }

  // Every job already ended, so a closing message that still promises a result is
  // the exact defect a persona could only argue about anecdotally.
  const allSettled = evidence.jobs.length > 0 && evidence.jobs.every(job => JOB_TERMINAL.has(job.status));
  const lastAssistant = [...evidence.messages].reverse()
    .find(message => message.role === "assistant" && (message.content ?? "").trim());
  if (allSettled && lastAssistant && /正在生成|正在出图|生成中|出图后|稍后告诉你/.test(lastAssistant.content)
    && !/已取消|取消|失败|未生成|没有生成/.test(lastAssistant.content))
    add("optimistic_tail", `last assistant message still promises work in progress: ${clip(lastAssistant.content, 160)}`);

  const verdict = {
    ok: violations.length === 0,
    sessionId: settings.sessionId,
    checkedAt: new Date().toISOString(),
    counts: { runs: evidence.runs.length, jobs: evidence.jobs.length,
      jobStatuses: evidence.jobs.reduce((acc, job) => ({ ...acc, [job.status]: (acc[job.status] ?? 0) + 1 }), {}),
      canvasImages: evidence.canvas?.images?.length ?? 0, placeholders: evidence.canvas?.placeholders?.length ?? 0,
      billingRows: evidence.billing.length },
    allowed: [...allowed],
    violations,
    definitions: CHECK_CODES,
    runsWithError: evidence.runs.filter(run => run.errorCode).map(run => ({ id: run.id, status: run.status, errorCode: run.errorCode })),
  };
  if (typeof flag("out") === "string") {
    const path = resolve(flag("out"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...verdict, evidence }, null, 2)}\n`);
    console.log(`REPORT ${path}`);
  }
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) process.exitCode = 1;
}

async function runWaitJobs() {
  const settings = await session();
  const deadline = Date.now() + minutes("timeout-minutes");
  let last = "";
  while (Date.now() < deadline) {
    const jobs = await sessionJobs(settings);
    const signature = jobs.map(job => `${job.id.slice(0, 8)}:${job.status}`).join(",") || "none";
    if (signature !== last) { console.log(`JOBS ${signature}`); last = signature; }
    if (jobs.length && jobs.every(job => JOB_TERMINAL.has(job.status))) {
      console.log(JSON.stringify({ settled: true, jobs }, null, 2)); return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
  }
  console.log(JSON.stringify({ settled: false, jobs: await sessionJobs(settings) }, null, 2));
}

async function runCancel() {
  const settings = await session();
  const { api } = await connect();
  const runs = (await sessionRuns(settings)).filter(run => !RUN_TERMINAL.has(run.status));
  for (const run of runs) { await api("POST", `/api/agent/runs/${run.id}/cancel`, undefined, 202); console.log(`CANCEL run ${run.id} (${run.status})`); }
  const jobs = (await sessionJobs(settings)).filter(job => !JOB_TERMINAL.has(job.status));
  for (const job of jobs) { await api("POST", `/api/jobs/${job.id}/cancel`); console.log(`CANCEL job ${job.id} (${job.status})`); }
  console.log(`cancelled runs=${runs.length} jobs=${jobs.length}`);
}

const handlers = { models: runModels, skills: runSkills, create: runCreate, upload: runUpload,
  "seed-canvas": runSeedCanvas, turn: runTurn, state: runState, "wait-jobs": runWaitJobs, cancel: runCancel,
  download: runDownload, check: runCheck };
const handler = handlers[mode];
if (!handler) { console.error(`unknown mode: ${mode}\nknown: ${Object.keys(handlers).join(", ")}`); process.exit(2); }
try {
  await handler();
} catch (error) {
  console.error(`FAIL ${redact(error instanceof Error ? error.stack ?? error.message : error)}`);
  process.exitCode = 1;
}
