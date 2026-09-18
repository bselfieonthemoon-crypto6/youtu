/**
 * Persistent, isolated, real-provider dialogue driver.
 *
 * Examples (all mutating modes require --submit):
 *   --preflight
 *   --init --submit --fixture ../../../artifacts/paid-dialogue-live/qa.json
 *   --turn "请为品牌做一张海报" --submit --fixture ...
 *   --wait-images --fixture ...
 *   --inspect --fixture ...
 *   --cancel --submit --fixture ...
 *
 * The driver never creates task/proposal rows directly and never mocks a
 * provider. The application API owns all dialogue and generation writes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageAttachmentSchema } from "@loomic/shared";

const require = createRequire(new URL("../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
const { Client } = require("pg") as typeof import("pg");
const { WebSocket } = require("ws") as typeof import("ws");

const API = process.env.LOOMIC_LIVE_API ?? "http://127.0.0.1:3002";
const DEFAULT_FIXTURE = fileURLToPath(new URL("../../../artifacts/paid-dialogue-live/manifest.json", import.meta.url));
const RUN_TERMINAL = new Set(["completed", "failed", "canceled"]);
const JOB_TERMINAL = new Set(["succeeded", "failed", "canceled", "dead_letter"]);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

type Model = { id: string; name?: string; displayName?: string; provider: string; accessible?: boolean; capabilities?: string[] };
type ModelRef = { id: string; name: string; provider: string };
type FixtureManifest = {
  schemaVersion: 1;
  fixtureId: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  workspaceId: string;
  fixture: { projectId: string; canvasId: string; sessionId: string };
  models: { text: ModelRef; image: ModelRef };
  autonomyEnabled: false;
  turns: TurnEvidence[];
};
type SafeToolEvidence = {
  toolName: string;
  status: string;
  prompt?: string;
  aspectRatio?: string;
  model?: string;
  referenceAssetIds?: string[];
  jobIds?: string[];
};
type JobEvidence = {
  id: string; status: string; jobType: string; createdAt: string;
  startedAt?: string | null; completedAt?: string | null;
  assetId?: string; width?: number; height?: number;
  creditsCost?: number | null; creditsTransactionId?: string | null;
  errorCode?: string | null; errorMessage?: string | null;
};
type TurnEvidence = {
  index: number; startedAt: string; completedAt?: string; prompt: string;
  userMessageId?: string; runId?: string; runStatus?: string;
  textModelId: string; imageModelId: string; aspectRatio?: string;
  toolEvidence: SafeToolEvidence[]; observedJobIds: string[];
  jobs: JobEvidence[]; assistantMessageIds: string[];
  assistantTexts?: string[];
  attachmentAssetIds?: string[];
  failure?: string;
};
type Cli = {
  mode: "preflight" | "init" | "turn" | "wait-images" | "inspect" | "cancel";
  submit: boolean; fixturePath: string; turn?: string; waitImages: boolean;
  textModel?: string; imageModel?: string; aspectRatio?: string; timeoutMs: number;
  attachmentsPath?: string; skillSlug?: string;
};

type CancelScopeRow = { id: string; session_id: string; status: string; created_at: string };

/** Keep cancellation restricted to this fixture, even when the manifest has no turns (browser driver). */
export function selectCancelableRows<T extends CancelScopeRow>(rows: T[], sessionId: string, fixtureCreatedAt: string): T[] {
  const start = Date.parse(fixtureCreatedAt);
  assert(Number.isFinite(start), "fixture createdAt is invalid");
  return rows.filter(row => row.session_id === sessionId && Date.parse(row.created_at) >= start &&
    !RUN_TERMINAL.has(row.status) && !JOB_TERMINAL.has(row.status));
}

async function assertFixtureAbsent(path: string) {
  try {
    await access(path);
    throw new Error(`fixture manifest already exists: ${path}; choose another path`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}

export function parseCli(argv: string[]): Cli {
  const value = (name: string) => {
    const exact = argv.indexOf(name);
    const inline = argv.find(arg => arg.startsWith(`${name}=`));
    return exact >= 0 ? argv[exact + 1] : inline?.slice(name.length + 1);
  };
  const turn = value("--turn");
  const modes = [argv.includes("--preflight") && "preflight", argv.includes("--init") && "init",
    turn !== undefined && "turn", argv.includes("--wait-images") && "wait-images",
    argv.includes("--inspect") && "inspect", argv.includes("--cancel") && "cancel"].filter(Boolean) as Cli["mode"][];
  // --turn ... --wait-images is one turn mode with a post-run image wait.
  const normalized = turn !== undefined ? modes.filter(mode => mode !== "wait-images") : modes;
  assert(normalized.length <= 1, `choose exactly one mode, received: ${modes.join(", ")}`);
  const mode = normalized[0] ?? "preflight";
  const submit = argv.includes("--submit");
  if (["init", "turn", "cancel"].includes(mode)) assert(submit, `${mode} requires explicit --submit`);
  if (mode === "turn") assert(turn?.trim(), "--turn requires non-empty natural text");
  const timeoutMinutes = Number(value("--timeout-minutes") ?? "30");
  assert(Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= 120, "timeout must be 1..120 minutes");
  const textModel = value("--text-model"); const imageModel = value("--image-model"); const aspectRatio = value("--aspect-ratio");
  const skillSlug = value("--skill");
  return { mode, submit, fixturePath: resolve(value("--fixture") ?? DEFAULT_FIXTURE),
    ...(value("--attachments") ? { attachmentsPath: resolve(value("--attachments")!) } : {}),
    ...(skillSlug !== undefined ? { skillSlug } : {}),
    ...(turn !== undefined ? { turn: turn.trim() } : {}), waitImages: argv.includes("--wait-images"),
    ...(textModel !== undefined ? { textModel } : {}), ...(imageModel !== undefined ? { imageModel } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}), timeoutMs: timeoutMinutes * 60_000 };
}

function safeError(error: unknown, max = 1_000) {
  const text = String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|signature|sig|key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)[\s:=]+[^\s,;}]+/gi, "$1=[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

export function sanitizeTool(toolName: string, status: string, input: unknown, output: unknown): SafeToolEvidence {
  const i = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const o = output && typeof output === "object" ? output as Record<string, unknown> : {};
  const refs = [...new Set(strings([i.input_images, i.reference_asset_ids, i.canvasSelection, i.selection]).flatMap(v => v.match(UUID) ?? []))];
  const jobs = [...new Set(strings([o.jobId, o.job_id, o.job, o.result]).flatMap(v => v.match(UUID) ?? []))];
  return { toolName, status,
    ...(typeof i.prompt === "string" ? { prompt: safeError(i.prompt, 4_000) } : {}),
    ...(typeof (i.aspect_ratio ?? i.aspectRatio) === "string" ? { aspectRatio: String(i.aspect_ratio ?? i.aspectRatio) } : {}),
    ...(typeof i.model === "string" ? { model: i.model } : {}),
    ...(refs.length ? { referenceAssetIds: refs } : {}), ...(jobs.length ? { jobIds: jobs } : {}) };
}

function chooseModel(models: Model[], requested: string | undefined, kind: "text" | "image"): ModelRef {
  const accessible = models.filter(model => model.accessible !== false);
  const chosen = requested ? accessible.find(model => model.id === requested) : accessible[0];
  assert(chosen, requested ? `${kind} model not published/accessibile: ${requested}` : `no published ${kind} model available`);
  return { id: chosen.id, name: chosen.name ?? chosen.displayName ?? chosen.id, provider: chosen.provider };
}

async function loadManifest(path: string): Promise<FixtureManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as FixtureManifest;
  assert.equal(value.schemaVersion, 1, "unsupported fixture manifest");
  assert(value.fixture?.projectId && value.fixture?.canvasId && value.fixture?.sessionId, "fixture IDs missing");
  return value;
}

async function saveManifest(path: string, manifest: FixtureManifest) {
  manifest.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function assertLocal() {
  const supabase = new URL(process.env.SUPABASE_URL ?? "http://invalid");
  const database = new URL(process.env.SUPABASE_DB_URL ?? "postgres://invalid/invalid");
  const api = new URL(API);
  assert(["127.0.0.1", "localhost"].includes(supabase.hostname), "local Supabase required");
  assert(["127.0.0.1", "localhost"].includes(database.hostname), "local database required");
  assert(["127.0.0.1", "localhost"].includes(api.hostname), "local API required");
  assert(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY, "local auth keys required");
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  assertLocal();
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  let socket: import("ws").WebSocket | undefined;
  try {
    const ownerId = process.env.LOOMIC_LIVE_QA_OWNER_ID ?? "541006fa-d2a1-4305-be55-b6263c27a1e3";
    const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const auth = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const account = await admin.auth.admin.getUserById(ownerId);
    assert(!account.error && account.data.user?.email, "local QA owner unavailable");
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email! });
    assert(!link.error && link.data.properties.hashed_token, "local magic-link unavailable");
    const login = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
    assert(!login.error && login.data.session?.access_token, "local login unavailable");
    const token = login.data.session.access_token;
    const headers = (json = false) => ({ Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) });
    const api = async <T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
      const response = await fetch(API + path, { method, headers: headers(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
      const data = await response.json().catch(() => null);
      assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${safeError(JSON.stringify(data))}`);
      return data as T;
    };
    const health = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(10_000) });
    assert(health.ok, "local API health unavailable");
    const viewer = await api<{ workspace: { id: string }; credits?: { balance: number } }>("GET", "/api/viewer");
    const [textList, imageList] = await Promise.all([
      api<{ models: Model[] }>("GET", "/api/models"), api<{ models: Model[] }>("GET", "/api/image-models"),
    ]);
    console.log(`PREFLIGHT api=ok textModels=${textList.models.length} imageModels=${imageList.models.length} credits=${viewer.credits?.balance ?? "unavailable"}`);
    if (cli.mode === "preflight") return;

    if (cli.mode === "init") {
      // Refuse before creating a project/canvas/session so an existing evidence
      // manifest can never be overwritten by a new fixture.
      await assertFixtureAbsent(cli.fixturePath);
      const text = chooseModel(textList.models, cli.textModel, "text");
      const image = chooseModel(imageList.models, cli.imageModel, "image");
      const project = await api<{ project: { id: string; primaryCanvas: { id: string } } }>("POST", "/api/projects", { name: `QA paid dialogue ${new Date().toISOString()}` }, 201);
      const session = await api<{ session: { id: string } }>("POST", `/api/canvases/${project.project.primaryCanvas.id}/sessions`, { title: "QA real paid dialogue" }, 201);
      // The autonomy tombstone route was retired with the legacy runtime; a stale
  // client now gets a plain 404.
  await api("GET", `/api/chat/sessions/${session.session.id}/autonomy`, undefined, 404);
      const now = new Date().toISOString();
      const manifest: FixtureManifest = { schemaVersion: 1, fixtureId: randomUUID(), createdAt: now, updatedAt: now,
        ownerId, workspaceId: viewer.workspace.id,
        fixture: { projectId: project.project.id, canvasId: project.project.primaryCanvas.id, sessionId: session.session.id },
        models: { text, image }, autonomyEnabled: false, turns: [] };
      await saveManifest(cli.fixturePath, manifest);
      console.log(`INIT fixture=${cli.fixturePath} project=${manifest.fixture.projectId} canvas=${manifest.fixture.canvasId} session=${manifest.fixture.sessionId}`);
      console.log(`MODELS text=${text.id} image=${image.id} autonomy=off`);
      return;
    }

    const manifest = await loadManifest(cli.fixturePath);
    assert.equal(manifest.ownerId, ownerId, "fixture owner mismatch");
    assert.equal(manifest.workspaceId, viewer.workspace.id, "fixture workspace mismatch");
    // Explicit model changes apply to future turns only; existing turn evidence
    // retains the models actually used. This allows long-lived QA sessions to
    // survive administrator model replacement without rewriting old results.
    if (cli.mode === "turn" && cli.submit) {
      if (cli.textModel) manifest.models.text = chooseModel(textList.models, cli.textModel, "text");
      if (cli.imageModel) manifest.models.image = chooseModel(imageList.models, cli.imageModel, "image");
    }
    assert(textList.models.some(m => m.id === manifest.models.text.id), "fixture text model is no longer published");
    assert(imageList.models.some(m => m.id === manifest.models.image.id && m.accessible !== false), "fixture image model is no longer accessible");

    let skillMention: { mentionType: "skill"; id: string; label: string; slug: string } | undefined;
    if (cli.skillSlug) {
      const skillRow = await db.query<{ id: string; name: string; slug: string }>(
        "select id,name,slug from public.skills where slug=$1", [cli.skillSlug]);
      assert(skillRow.rows.length === 1, `skill not found: ${cli.skillSlug}`);
      const row = skillRow.rows[0]!;
      skillMention = { mentionType: "skill", id: row.id, label: row.name, slug: row.slug };
    }

    const safeJob = (row: any): JobEvidence => ({ id: row.id, status: row.status, jobType: row.job_type, createdAt: row.created_at,
      startedAt: row.started_at, completedAt: row.completed_at,
      ...(typeof row.result?.asset_id === "string" ? { assetId: row.result.asset_id } : {}),
      ...(Number.isFinite(row.result?.width) ? { width: row.result.width } : {}),
      ...(Number.isFinite(row.result?.height) ? { height: row.result.height } : {}),
      creditsCost: row.credits_cost ?? null, creditsTransactionId: row.credits_transaction_id ?? null,
      errorCode: row.error_code ?? null, errorMessage: row.error_message ? safeError(row.error_message) : null });
    const queryJobs = async (turn: TurnEvidence) => {
      const ids = [...new Set(turn.observedJobIds)];
      const result = await db.query(
        `select id,session_id,status,job_type,result,error_code,error_message,credits_cost,credits_transaction_id,created_at,started_at,completed_at
           from background_jobs where session_id=$1 and (created_at >= $2 or id = any($3::uuid[])) order by created_at`,
        [manifest.fixture.sessionId, turn.startedAt, ids]);
      return result.rows;
    };
    const waitImages = async (turn: TurnEvidence) => {
      const stop = Date.now() + cli.timeoutMs;
      let last = "";
      while (Date.now() < stop) {
        const rows = (await queryJobs(turn)).filter(row => row.job_type === "image_generation");
        const signature = rows.map(row => `${row.id.slice(0, 8)}:${row.status}`).join(",") || "none";
        if (signature !== last) { console.log(`IMAGES ${signature}`); last = signature; }
        turn.jobs = rows.map(safeJob);
        // Zero jobs is explicitly "none", never successful completion.
        if (rows.length === 0) {
          if (cli.mode !== "wait-images") await saveManifest(cli.fixturePath, manifest);
          console.log("IMAGES none-observed (not completed)"); return;
        }
        if (rows.every(row => JOB_TERMINAL.has(row.status))) {
          // A standalone observer must not overwrite newer dialogue evidence
          // with the manifest it loaded before the image finished.
          if (cli.mode !== "wait-images") await saveManifest(cli.fixturePath, manifest);
          for (const job of turn.jobs) console.log(`IMAGE job=${job.id} status=${job.status} asset=${job.assetId ?? "none"} size=${job.width ?? "?"}x${job.height ?? "?"} credits=${job.creditsCost ?? "unavailable"}`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
      throw new Error("image jobs did not reach a terminal state before timeout");
    };

    if (cli.mode === "inspect") {
      const runs = await db.query("select id,status,created_at,completed_at from agent_runs where session_id=$1 order by created_at", [manifest.fixture.sessionId]);
      const messages = await api<{ messages: Array<{ id: string; role: string }> }>("GET", `/api/sessions/${manifest.fixture.sessionId}/messages`);
      const jobs = await db.query(
        `select id,status,job_type,result,error_code,error_message,credits_cost,credits_transaction_id,created_at,started_at,completed_at
           from background_jobs where session_id=$1 order by created_at`, [manifest.fixture.sessionId]);
      console.log(JSON.stringify({ fixture: manifest.fixture, models: manifest.models, autonomyEnabled: manifest.autonomyEnabled,
        turns: manifest.turns.length, messages: messages.messages.length, runs: runs.rows,
        sessionJobs: jobs.rows.map(safeJob) }, null, 2));
      return;
    }
    if (cli.mode === "wait-images") {
      // Browser-driven acceptance keeps its richer UI trace separately. The
      // dedicated fixture session and creation time remain a safe lower bound
      // when this CLI has no turn record of its own.
      const turn = manifest.turns.at(-1) ?? {
        index: 0, startedAt: manifest.createdAt, prompt: "[browser-driven dialogue]",
        textModelId: manifest.models.text.id, imageModelId: manifest.models.image.id,
        toolEvidence: [], observedJobIds: [], jobs: [], assistantMessageIds: [],
      } satisfies TurnEvidence;
      await waitImages(turn); return;
    }
    if (cli.mode === "cancel") {
      assert(cli.submit, "cancel requires explicit --submit");
      const runs = await db.query<CancelScopeRow>(
        "select id,session_id,status,created_at from agent_runs where session_id=$1 and created_at >= $2 order by created_at",
        [manifest.fixture.sessionId, manifest.createdAt]);
      for (const run of selectCancelableRows(runs.rows, manifest.fixture.sessionId, manifest.createdAt)) {
        await api("POST", `/api/agent/runs/${run.id}/cancel`, undefined, 202);
        console.log(`CANCEL run=${run.id} status=${run.status}`);
      }
      const browserTurn = {
        index: 0, startedAt: manifest.createdAt, prompt: "[browser-driven cancellation]",
        textModelId: manifest.models.text.id, imageModelId: manifest.models.image.id,
        toolEvidence: [], observedJobIds: [], jobs: [], assistantMessageIds: [],
      } satisfies TurnEvidence;
      const jobs = await queryJobs(browserTurn);
      for (const job of selectCancelableRows(jobs, manifest.fixture.sessionId, manifest.createdAt)) {
        await api("POST", `/api/jobs/${job.id}/cancel`); console.log(`CANCEL job=${job.id}`);
      }
      return;
    }

    assert(cli.turn, "turn text missing");
    const attachments = cli.attachmentsPath
      ? (JSON.parse(await readFile(cli.attachmentsPath, "utf8")) as unknown[]).map(value => imageAttachmentSchema.parse(value))
      : [];
    assert(attachments.length <= 16, "QA supports at most 16 references");
    for (const attachment of attachments) {
      const asset = await admin.from("asset_objects").select("workspace_id,created_by")
        .eq("id", attachment.assetId).single();
      assert(!asset.error && asset.data?.workspace_id === manifest.workspaceId && asset.data.created_by === manifest.ownerId,
        "QA attachment must belong to fixture owner and workspace");
    }
    // Retirement is a server invariant, not a per-session user preference.
    await api("GET", `/api/chat/sessions/${manifest.fixture.sessionId}/autonomy`, undefined, 404);
    const turn: TurnEvidence = { index: manifest.turns.length + 1, startedAt: new Date().toISOString(), prompt: cli.turn,
      textModelId: manifest.models.text.id, imageModelId: manifest.models.image.id,
      ...(cli.aspectRatio ? { aspectRatio: cli.aspectRatio } : {}), toolEvidence: [], observedJobIds: [], jobs: [], assistantMessageIds: [] };
    if (attachments.length) turn.attachmentAssetIds = attachments.map(item => item.assetId);
    manifest.turns.push(turn); await saveManifest(cli.fixturePath, manifest);
    try {
      const created = await api<{ message: { id: string } }>("POST", `/api/sessions/${manifest.fixture.sessionId}/messages`,
        { role: "user", content: cli.turn, contentBlocks: [{ type: "text", text: cli.turn },
          ...(skillMention ? [{ type: "mention", ...skillMention }] : []),
          ...attachments.map(item => ({ type: "image", source: "upload", ...item }))] }, 201);
      turn.userMessageId = created.message.id; await saveManifest(cli.fixturePath, manifest);
      console.log(`TURN ${turn.index} message=${turn.userMessageId} persisted`);
      socket = new WebSocket(`${API.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`);
      await new Promise<void>((resolveOpen, reject) => { socket!.once("open", resolveOpen); socket!.once("error", reject); });
      const requestId = randomUUID();
      await new Promise<void>((resolveRun, reject) => {
        const timer = setTimeout(() => finish(new Error("agent run timed out")), Math.min(cli.timeoutMs, 20 * 60_000));
        const finish = (error?: Error) => { clearTimeout(timer); socket?.off("message", onMessage); error ? reject(error) : resolveRun(); };
        const onMessage = async (raw: Buffer) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.type === "rpc.request") {
              socket?.send(JSON.stringify({ type: "rpc.response", id: message.id, error: "QA CLI has no browser screenshot context." })); return;
            }
            if (message.type === "error" && message.requestId === requestId) return finish(new Error(message.code ?? message.message));
            if (message.type === "command.ack" && message.requestId === requestId) {
              turn.runId = message.payload?.runId; console.log(`RUN ack id=${turn.runId ?? "missing"}`); await saveManifest(cli.fixturePath, manifest); return;
            }
            const event = message.type === "event" ? message.event : undefined;
            if (!event || (turn.runId && event.runId !== turn.runId)) return;
            if (event.type === "tool.started" || event.type === "tool.completed") {
              const evidence = sanitizeTool(event.toolName ?? "unknown", event.type === "tool.started" ? "running" : "completed", event.input, event.output);
              if (event.type === "tool.completed") turn.toolEvidence.push(evidence);
              for (const id of evidence.jobIds ?? []) if (!turn.observedJobIds.includes(id)) turn.observedJobIds.push(id);
              console.log(`TOOL ${evidence.toolName} ${evidence.status}${evidence.jobIds?.length ? ` jobs=${evidence.jobIds.join(",")}` : ""}`);
            }
            if (["run.completed", "run.failed", "run.canceled"].includes(event.type)) {
              turn.runStatus = event.type.slice(4); turn.completedAt = new Date().toISOString();
              if (event.error) turn.failure = safeError(event.error?.message ?? event.error);
              await saveManifest(cli.fixturePath, manifest); console.log(`RUN ${turn.runStatus}`); finish();
            }
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        };
        socket!.on("message", onMessage);
        socket!.send(JSON.stringify({ type: "command", action: "agent.run", accessToken: token, requestId,
          payload: { sessionId: manifest.fixture.sessionId, conversationId: manifest.fixture.canvasId,
            canvasId: manifest.fixture.canvasId, userMessageId: turn.userMessageId, prompt: cli.turn,
            ...(attachments.length ? { attachments } : {}),
            ...(skillMention ? { mentions: [skillMention] } : {}),
            model: manifest.models.text.id, executionMode: "thinking",
            imageGenerationPreference: { mode: "manual", models: [manifest.models.image.id], ...(cli.aspectRatio ? { aspectRatio: cli.aspectRatio } : {}) } } }));
      });
      const messages = await api<{ messages: Array<{ id: string; role: string; content?: string; createdAt?: string }> }>("GET", `/api/sessions/${manifest.fixture.sessionId}/messages`);
      const start = Date.parse(turn.startedAt);
      turn.assistantMessageIds = messages.messages.filter(m => m.role === "assistant" && (!m.createdAt || Date.parse(m.createdAt) >= start)).map(m => m.id);
      const readReplies = () => db.query<{ id: string; content: string }>(
        "select id,content from chat_messages where session_id=$1 and role='assistant' and created_at >= $2 order by session_sequence",
        [manifest.fixture.sessionId, turn.startedAt]);
      let persistedReplies = await readReplies();
      // Completion events may precede the chat projection write. Poll reads only;
      // never resubmit a user message or model run to collect its evidence.
      for (let attempt = 0; turn.runStatus === "completed" && !persistedReplies.rows.length && attempt < 10; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        persistedReplies = await readReplies();
      }
      turn.assistantMessageIds = persistedReplies.rows.map(m => m.id);
      turn.assistantTexts = persistedReplies.rows.map(m => m.content).filter(Boolean);
      const rows = await queryJobs(turn); turn.jobs = rows.map(safeJob);
      await saveManifest(cli.fixturePath, manifest);
      if (cli.waitImages) await waitImages(turn);
      console.log(`TURN done run=${turn.runId} status=${turn.runStatus} tools=${turn.toolEvidence.length} jobs=${turn.jobs.length}`);
    } catch (error) {
      turn.failure = safeError(error); await saveManifest(cli.fixturePath, manifest); throw error;
    }
  } finally {
    socket?.close(); await db.end().catch(() => undefined);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch(error => { console.error(`FAIL ${safeError(error)}`); process.exitCode = 1; });
