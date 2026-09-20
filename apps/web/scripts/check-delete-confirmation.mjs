// Browser acceptance for the canvas delete-confirmation flow.
//
// A stateless CLI campaign could not settle this: `manipulate_canvas` correctly
// answered `confirmation_required`, but sending the frontend's `agent.confirm_action`
// message from the CLI produced `confirmation_execution_failed` and then
// `Confirmation is not_found`, with no row in any confirmation table. That proves a
// CLI cannot impersonate a browser tab — not that the card is broken. This probe
// drives the real UI instead, against the running local stack, and records a raw
// number for every claim the checklist makes:
//
//   PHASE 1 CREATION  the user's delete request renders "需要确认危险操作" +
//                     "确认删除", and BEFORE any click the canvas still holds the
//                     image (the safety gate really gates).
//   PHASE 2 EXECUTION a real click on that button removes the element from the
//                     persisted canvas, the card settles to "已确认并删除", and the
//                     server's own acknowledgement for the click reports success.
//   PHASE 3 EXPIRY    an unconfirmed card is never applied by a background timer,
//                     and after its TTL elapses the same card can no longer be
//                     confirmed (the click must be rejected, not silently applied).
//   PHASE 4 REFRESH   reloading after a confirmed deletion neither resurrects the
//                     image nor leaves a duplicate pending confirmation.
//
// ISOLATION (why this file no longer reuses one session for every phase):
// a transcript accumulates one confirmation card per phase, and the browser renders
// all of them. Selecting "the last card on screen" therefore let PHASE 2/3/4 confirm
// a card left behind by an earlier phase — the observed "the click happened but the
// element survived and the server still answered confirmation_required". Two rules
// remove that entire class of false result:
//   1. every phase runs against its OWN fixture (project + canvas + session), created
//      for that phase, so no other phase's card exists in its DOM at all;
//   2. a card is addressed by the `data-confirmation-id` marker on the card root, so a
//      phase can only ever act on the confirmation it created.
// The click's own server acknowledgement is recorded from the page's WebSocket, so a
// phase reports what the server answered instead of inferring it from the transcript.
//
// SETUP uses the existing sim harness (isolated project + canvas + session, plus a
// seeded image element). Only the confirmation itself is driven in a browser.
//
// Run from apps/web (that is where `@playwright/test` resolves):
//   node --env-file=../../.env.local ../../apps/web/scripts/check-delete-confirmation.mjs
//
// Flags:
//   --wait-expiry-seconds <n>     TTL wait for PHASE 3 (default 660)
//   --skip-expiry-wait            do not wait out the TTL; record info only
//   --quick                       phases 1-2 + refresh only (development smoke)
//   --reuse-fixture               one shared fixture for every phase (debug only; it
//                                 reintroduces the accumulated-card ambiguity)
//   --canvas <id> --session <id>  reuse an existing isolated fixture for every phase
//   --out <path>                  evidence JSON (default artifacts/.../probe-*.json)
//
// Read-only outside its own isolated fixtures: it seeds images on those fixtures'
// canvases and never touches any other project, canvas or session.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/* --------------------------------------------------------------------- config */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, "..", "..", "..");
const ARTIFACT_DIR = resolve(REPO_ROOT, "artifacts", "delete-confirmation-browser");
const SEED_SOURCE = resolve(REPO_ROOT, "apps", "web", "public", "apple-touch-icon.png");
// The dev server binds the IPv6 loopback only, but the API's CORS allow-list is
// `http://localhost:3020` (http://[::1]:3020 is rejected by preflight and the
// WebSocket handshake), so the browser must be pointed at `localhost`.
const BASE = process.env.CONFIRM_BASE_URL ?? "http://localhost:3020";
const API = process.env.LOOMIC_LIVE_API ?? "http://127.0.0.1:3002";
const QA_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const DELETE_TITLE = "需要确认危险操作";
const CONFIRM_LABEL = "确认删除";
const APPLIED_LABEL = "已确认并删除";
const VERIFY_LOG = resolve(ARTIFACT_DIR, "probe-run.log");
// A canvas deletion only becomes a proposal when the user's own wording asks for a
// removal (hasExplicitCanvasDeleteIntent), so every phase sends a real one.
const DELETE_PROMPT_SHAPE = "把画布上标题为「<title>」的那张图片删除掉";

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const inline = argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}
const has = (name) => argv.includes(`--${name}`);
const EXPIRY_WAIT_SECONDS = Number(flag("wait-expiry-seconds", 660));
const QUICK = has("quick");
const SKIP_EXPIRY_WAIT = has("skip-expiry-wait") || QUICK;
const REUSE_FIXTURE = has("reuse-fixture") || (typeof flag("canvas") === "string" && typeof flag("session") === "string");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------- evidence */

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, "-");
const rows = [];
const screenshots = [];
let failures = 0;
const record = (phase, name, status, detail, data) => {
  rows.push({ phase, name, status, ...(detail ? { detail } : {}), ...(data === undefined ? {} : { data }) });
  const label = status.toUpperCase().padEnd(4);
  const line = `[${phase}] ${label} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  // A long expiry wait invites a reader to assume the run is stuck; stream the log
  // beside the JSON so the timeline survives even if the terminal is gone.
  void appendFile(VERIFY_LOG, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
  if (status === "fail") failures += 1;
};
const pass = (phase, name, detail, data) => record(phase, name, "pass", detail, data);
const fail = (phase, name, detail, data) => record(phase, name, "fail", detail, data);
const info = (phase, name, detail, data) => record(phase, name, "info", detail, data);

async function shot(page, name) {
  const path = resolve(ARTIFACT_DIR, "screenshots", `${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: false }).catch(() => undefined);
  screenshots.push({ name, path });
  return path;
}

async function saveEvidence(extra = {}) {
  const evidence = {
    kind: "delete-confirmation-browser-acceptance",
    startedAt,
    finishedAt: new Date().toISOString(),
    base: BASE,
    api: API,
    prompt: DELETE_PROMPT_SHAPE,
    expiryWaitSeconds: EXPIRY_WAIT_SECONDS,
    isolation: REUSE_FIXTURE ? "shared fixture (--reuse-fixture / --canvas)" : "one fresh fixture per phase",
    checks: rows,
    screenshots,
    counts: {
      total: rows.length,
      passed: rows.filter((row) => row.status === "pass").length,
      failed: failures,
      info: rows.filter((row) => row.status === "info").length,
    },
    ...extra,
  };
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const path = resolve(typeof flag("out") === "string" ? flag("out") : resolve(ARTIFACT_DIR, `probe-${stamp}.json`));
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEVIDENCE ${path}`);
  console.log(`RESULT ${evidence.counts.passed} pass / ${evidence.counts.failed} fail / ${evidence.counts.info} info`);
  return path;
}

/* ------------------------------------------------------------------ supabase */

assert(
  (process.env.SUPABASE_URL ?? "").includes("127.0.0.1"),
  "local Supabase required (SUPABASE_URL must point at 127.0.0.1); run with --env-file=../../.env.local",
);
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
assert(serviceRole && anonKey, "SUPABASE_SERVICE_ROLE_KEY and anon key are required");

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, serviceRole, clientOptions);
const auth = createClient(supabaseUrl, anonKey, clientOptions);

async function login() {
  const account = await admin.auth.admin.getUserById(QA_OWNER);
  assert(account.data?.user?.email, "local QA account unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  assert(!link.error, `magic link failed: ${link.error?.message}`);
  const verified = await auth.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.data.properties.hashed_token,
  });
  assert(verified.data.session && !verified.error, `login failed: ${verified.error?.message}`);
  return verified.data.session;
}

/* ------------------------------------------------------------- setup (harness) */

const simTools = resolve(REPO_ROOT, "apps", "server", "scripts", "agent-sim-tools.mjs");

function runHarness(mode, args) {
  const command = [process.execPath, "--env-file=.env.local", simTools, mode, ...args]
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");
  try {
    return execSync(command, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
  } catch (error) {
    throw new Error(`harness ${mode} failed: ${String(error.stderr ?? error.message).slice(-800)}`);
  }
}

const sharedFixturePath = resolve(ARTIFACT_DIR, "fixture.json");
let sharedFixture = null;

/**
 * One fixture per phase. A fresh project + canvas + session means the phase's DOM can
 * only ever contain the confirmation cards that phase created.
 */
async function fixtureFor(phase) {
  if (REUSE_FIXTURE) {
    const existingCanvas = flag("canvas");
    const existingSession = flag("session");
    if (typeof existingCanvas === "string" && typeof existingSession === "string") {
      return { canvasId: existingCanvas, sessionId: existingSession, projectId: null, created: false, shared: true };
    }
    if (!sharedFixture) {
      try {
        sharedFixture = JSON.parse(await readFile(sharedFixturePath, "utf8"));
      } catch {
        runHarness("create", ["--name", "delete-confirmation-browser", "--out", "artifacts/delete-confirmation-browser/fixture.json"]);
        sharedFixture = JSON.parse(await readFile(sharedFixturePath, "utf8"));
      }
      info("setup", "reused shared fixture", `canvas ${sharedFixture.canvasId} session ${sharedFixture.sessionId}`, {
        projectId: sharedFixture.projectId,
      });
    }
    return { ...sharedFixture, created: false, shared: true };
  }
  const path = resolve(ARTIFACT_DIR, "fixtures", `${phase}.json`);
  // The local API is a long-lived dev process that may be restarting; a fixture
  // creation that races it must not abort the whole campaign.
  for (let attempt = 1; ; attempt += 1) {
    try {
      runHarness("create", ["--name", `delete-confirmation-${phase}`, "--out", path]);
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      info("setup", `${phase} fixture retry`, `attempt ${attempt}: ${String(error.message).split("\n")[0].slice(0, 160)}`);
      await sleep(15_000);
    }
  }
  const fixture = JSON.parse(await readFile(path, "utf8"));
  info("setup", `${phase} fresh fixture`,
    `canvas ${fixture.canvasId} session ${fixture.sessionId}`,
    { projectId: fixture.projectId, fixturePath: path });
  return { ...fixture, created: true, shared: false };
}

/**
 * Prepare the phase's canvas: exactly one image element, with a title the prompt can
 * name so the Agent has an unambiguous destructive target (with several similar images
 * it correctly asks which one instead of proposing a deletion).
 */
async function prepareCanvasWithOneImage(canvasId, label, title) {
  const empty = await admin.from("canvases").update({ content: { elements: [], appState: {}, files: {} } }).eq("id", canvasId);
  assert(!empty.error, `canvas reset failed: ${empty.error?.message}`);
  const seeded = await seedImage(canvasId, label, title);
  return { ...seeded, title };
}

/** Mirrors `agent-sim-tools seed-canvas`: one isolated PNG element + its file entry. */
async function seedImage(canvasId, label, title) {
  const bytes = await readFile(SEED_SOURCE);
  const objectPath = `qa/delete-confirmation/${randomUUID()}-${label}.png`;
  const upload = await admin.storage.from("workspace-assets").upload(objectPath, bytes, { contentType: "image/png" });
  assert(!upload.error, `seed upload failed: ${upload.error?.message}`);
  const elementId = `sim-image-${randomUUID()}`;
  const fileId = `sim-file-${randomUUID()}`;
  const canvas = await admin.from("canvases").select("content").eq("id", canvasId).single();
  assert(!canvas.error, `canvas read failed: ${canvas.error?.message}`);
  const content = canvas.data.content ?? { elements: [], appState: {}, files: {} };
  const element = {
    type: "image", id: elementId, x: 0, y: 0, width: 900, height: 1200, angle: 0,
    fileId, status: "saved", scale: [1, 1], crop: null, groupIds: [], boundElements: null,
    frameId: null, index: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    updated: Date.now(), link: null, locked: false, opacity: 100, roundness: null,
    strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roughness: 0,
    customData: { assetId: objectPath, seededBy: "check-delete-confirmation", ...(title ? { title } : {}) },
  };
  const saved = await admin.from("canvases").update({
    content: {
      ...content,
      elements: [...(content.elements ?? []), element],
      files: { ...(content.files ?? {}), [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } },
    },
  }).eq("id", canvasId).select("id,revision").maybeSingle();
  assert(!saved.error && saved.data, `seed write failed: ${saved.error?.message}`);
  return { elementId, fileId, objectPath, revision: saved.data.revision ?? null };
}

/* ---------------------------------------------------------------- canvas state */

async function canvasState(canvasId) {
  const canvas = await admin.from("canvases").select("content,revision").eq("id", canvasId).single();
  if (canvas.error) throw new Error(`canvas read failed: ${canvas.error.message}`);
  const content = canvas.data.content ?? {};
  const live = (content.elements ?? []).filter((element) => !element.isDeleted);
  return {
    revision: canvas.data.revision ?? null,
    liveIds: live.map((element) => element.id).sort(),
    liveImages: live.filter((element) => element.type === "image").map((element) => element.id).sort(),
    elementCount: live.length,
    content,
  };
}

/** Re-read the row until `match` holds, so a screenshot never races the database. */
async function waitForCanvas(canvasId, match, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = await canvasState(canvasId);
  for (;;) {
    if (match(last)) return last;
    if (Date.now() >= deadline) return last;
    await sleep(everyMs);
    last = await canvasState(canvasId);
  }
}

/* --------------------------------------------------------- transcript evidence */

// The confirmation card is rendered from a tool block, so the transcript is the
// authoritative record of what the UI was told. Read it instead of guessing.
async function sessionBlocks(sessionId) {
  const response = await fetch(`${API}/api/sessions/${sessionId}/messages`, {
    headers: { Authorization: `Bearer ${process.env.__PROBE_TOKEN ?? ""}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const messages = Array.isArray(payload) ? payload : (payload.messages ?? []);
  return messages.flatMap((message) =>
    (message.contentBlocks ?? message.content_blocks ?? []).map((block) => ({ messageId: message.id, block })),
  );
}

async function findConfirmationBlocks(sessionId, confirmationId) {
  const all = (await sessionBlocks(sessionId)) ?? [];
  return all.filter(({ block }) =>
    block?.type === "tool" &&
    block.output?.confirmation &&
    (confirmationId === undefined || block.output.confirmation.confirmationId === confirmationId));
}

/** Every phase acts on the confirmation IT created, never on a card left by another turn. */
async function confirmedIdsBefore(sessionId) {
  return new Set((await findConfirmationBlocks(sessionId)).map(({ block }) => block.output.confirmation.confirmationId));
}

/* ------------------------------------------------------------------- browser */

async function openCanvasPage(browser, fixture, session) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
  const pageErrors = [];
  const consoleErrors = [];
  const frames = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message).slice(0, 200)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });
  await page.exposeFunction("__recordConfirmFrame", (entry) => {
    frames.push(entry);
  });
  await page.addInitScript((value) => {
    localStorage.setItem("sb-127-auth-token", JSON.stringify(value));
    // Record the confirmation traffic the page itself sends and receives. The card's
    // local state is not evidence of what the server answered; the ack is.
    const Original = window.WebSocket;
    window.WebSocket = new Proxy(Original, {
      construct(target, args) {
        const socket = new target(...args);
        socket.addEventListener("message", (event) => {
          try {
            const parsed = JSON.parse(String(event.data));
            if (parsed?.action === "agent.confirm_action") {
              window.__recordConfirmFrame({ direction: "in", at: new Date().toISOString(), message: parsed });
            }
          } catch { /* not JSON */ }
        });
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          try {
            const parsed = JSON.parse(String(data));
            if (parsed?.action === "agent.confirm_action") {
              window.__recordConfirmFrame({
                direction: "out", at: new Date().toISOString(),
                message: { action: parsed.action, payload: parsed.payload },
              });
            }
          } catch { /* ignore */ }
          return send(data);
        };
        return socket;
      },
    });
  }, session);
  const target = `${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      info("browser", "navigation retry", String(error.message).split("\n")[0]);
      await sleep(3000);
    }
  }
  // A stalled bootstrap (auth, membership, canvas fetch) must leave a picture behind
  // instead of only a locator timeout in the log.
  await sleep(8000);
  if (!(await page.getByRole("textbox", { name: "输入消息", exact: true }).count())) {
    await shot(page, `debug-no-composer-${Date.now()}`);
    const body = await page.locator("body").innerText().catch(() => "");
    info("browser", "composer not rendered yet", `${page.url()} :: ${body.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  return { page, pageErrors, consoleErrors, frames };
}

async function waitForComposer(page) {
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.waitFor({ state: "visible", timeout: 120_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await composer.isEnabled().catch(() => false)) return composer;
    await sleep(500);
  }
  return composer;
}

/** Send one user message through the real composer (this is what starts the run). */
async function sendFromComposer(page, text) {
  const composer = await waitForComposer(page);
  await composer.fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click({ timeout: 30_000 });
}

/**
 * The confirmation id comes from the transcript, which is the authoritative record of
 * what the card was told; `known` keeps the phase from latching onto an earlier turn.
 * The card root is then addressed by `data-confirmation-id`, so the phase can only act
 * on its own proposal even if the DOM also holds cards from other turns.
 */
async function waitForDeleteCard(page, sessionId, known = new Set(), timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const blocks = await findConfirmationBlocks(sessionId);
    const fresh = blocks.filter(({ block }) => !known.has(block.output.confirmation.confirmationId));
    const candidate = fresh[fresh.length - 1]?.block?.output?.confirmation;
    if (candidate?.confirmationId) {
      const card = cardById(page, candidate.confirmationId);
      await card.waitFor({ state: "visible", timeout: 60_000 });
      return { card, confirmation: candidate, block: fresh[fresh.length - 1].block };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no NEW delete confirmation appeared (delete cards on screen: ` +
        `${await page.locator("[data-confirmation-id]").count()}, ` +
        `known ids: ${known.size}, transcript blocks: ${blocks.length})`,
      );
    }
    await sleep(1000);
  }
}

function cardById(page, confirmationId) {
  return page.locator(`[data-confirmation-id="${confirmationId}"]`);
}

async function waitForCardText(root, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await root.innerText().catch(() => "");
    if (content.includes(text)) return content;
    if (Date.now() >= deadline) return content;
    await sleep(400);
  }
}

async function waitForCardState(root, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let content = await root.innerText().catch(() => "");
  let confirmButtons = await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).count().catch(() => 0);
  for (;;) {
    if (predicate({ content, confirmButtons })) return { content, confirmButtons };
    if (Date.now() >= deadline) return { content, confirmButtons };
    await sleep(400);
    content = await root.innerText().catch(() => "");
    confirmButtons = await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).count().catch(() => 0);
  }
}

function cardButtons(root) {
  return {
    confirm: root.getByRole("button", { name: CONFIRM_LABEL, exact: true }),
    cancel: root.getByRole("button", { name: "取消", exact: true }),
  };
}

/**
 * Wait for the server's own answer to THIS click. The card marks itself applied on an
 * immediate `accepted`/`applied` ack, so the second ack (the final outcome) is what
 * separates "the delete really ran" from "the button looked like it worked".
 */
async function waitForConfirmAck(frames, confirmationId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const mine = () => frames.filter((frame) => frame.message?.payload?.confirmationId === confirmationId);
  for (;;) {
    const entries = mine();
    const sent = entries.find((frame) => frame.direction === "out");
    const acks = entries.filter((frame) => frame.direction === "in").map((frame) => frame.message.payload);
    const terminal = acks.find((payload) => payload.status && payload.status !== "accepted");
    if (terminal) return { sentAt: sent?.at ?? null, acks, terminal };
    if (sent && Date.now() >= deadline) return { sentAt: sent.at, acks, terminal: null };
    if (Date.now() >= deadline) return { sentAt: sent?.at ?? null, acks, terminal: null };
    await sleep(300);
  }
}

function ackSummary(ack) {
  if (!ack) return "no terminal acknowledgement";
  return `status=${ack.status}${ack.code ? ` code=${ack.code}` : ""}${ack.message ? ` message=${ack.message}` : ""}`;
}

/* ------------------------------------------------------- the CLI-only question */

// Reproduce what the stateless CLI did: an independent WebSocket that only sends
// `agent.confirm_action`. Two variants separate "the CLI never bound a canvas" from
// "the confirmation id itself was stale".
async function cliArtifactProbe(token, realConfirmationId) {
  // `apps/web` has no `ws` package; Node 24 ships a browser-compatible global WebSocket,
  // which is enough for an independent socket that only sends one command.
  const outcomes = {};
  const ask = async (label, confirmationId) => {
    const socket = new WebSocket(`${API.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`);
    await new Promise((open, reject) => {
      socket.addEventListener("open", open, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const requestId = randomUUID();
    const ack = await new Promise((done) => {
      const timer = setTimeout(() => done({ status: "no_ack_within_15s" }), 15_000);
      socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === "command.ack" && message.action === "agent.confirm_action") {
          clearTimeout(timer);
          done(message.payload ?? {});
        }
      });
      socket.send(JSON.stringify({
        type: "command",
        action: "agent.confirm_action",
        accessToken: token,
        requestId,
        payload: { confirmationId, decision: "confirm" },
      }));
    });
    socket.close();
    outcomes[label] = { confirmationId, ack: ack };
    return ack;
  };
  const bogus = await ask("independent_socket_unknown_id", randomUUID());
  const real = realConfirmationId
    ? await ask("independent_socket_real_id", realConfirmationId)
    : null;
  return { outcomes, bogus, real };
}

/* ---------------------------------------------------------------------- main */

const session = await login();
process.env.__PROBE_TOKEN = session.access_token;
const browser = await chromium.launch({ headless: true });
const evidence = { fixtures: {} };

try {
  /* ============================== PHASE 1: creation gating =================== */
  {
    const phase = "phase1-creation";
    const title = "确认删除测试图";
    const fixture = await fixtureFor("phase1");
    const seeded = await prepareCanvasWithOneImage(fixture.canvasId, "p1", title);
    evidence.fixtures.phase1 = { canvasId: fixture.canvasId, sessionId: fixture.sessionId, projectId: fixture.projectId ?? null };
    const known = await confirmedIdsBefore(fixture.sessionId);
    evidence.phase1 = { seeded };
    const { page, pageErrors, consoleErrors } = await openCanvasPage(browser, fixture, session);
    try {
      info(phase, "before-state", `canvas holds ${(await canvasState(fixture.canvasId)).elementCount} element(s), seeded ${seeded.elementId}`);
      await sendFromComposer(page, `把画布上标题为「${title}」的那张图片删除掉`);
      const { card: root, confirmation, block } = await waitForDeleteCard(page, fixture.sessionId, known);
      evidence.phase1.confirmation = confirmation;
      evidence.phase1.toolStatus = block?.status ?? null;
      pass(phase, "agent proposed a destructive confirmation", `confirmationId=${confirmation.confirmationId} targets=${confirmation.targets?.length ?? 0}`);
      evidence.phase1.targets = confirmation.targets;
      if ((confirmation.targets ?? []).some((target) => target.elementId === seeded.elementId)) {
        pass(phase, "the proposal names the seeded image", `target elementId=${seeded.elementId}`);
      } else {
        fail(phase, "the proposal names the seeded image",
          `targets: ${JSON.stringify((confirmation.targets ?? []).map((target) => target.elementId))}`);
      }
      const cardText = await root.innerText();
      evidence.phase1.cardText = cardText;
      pass(phase, "confirmation card is rendered in the browser", `${DELETE_TITLE} + ${CONFIRM_LABEL}`);
      const stillThere = await canvasState(fixture.canvasId);
      await shot(page, "phase1-card-before-confirm");
      if (stillThere.liveIds.includes(seeded.elementId)) {
        pass(phase, "image is STILL on the canvas before any confirmation",
          `element ${seeded.elementId} present, ${stillThere.elementCount} live element(s), revision ${stillThere.revision}`);
      } else {
        fail(phase, "image is STILL on the canvas before any confirmation",
          `element ${seeded.elementId} was already gone before any click`);
      }
      if (pageErrors.length) info(phase, "page errors", pageErrors.slice(0, 3).join(" | "));
      if (consoleErrors.length) evidence.phase1.consoleErrors = consoleErrors.slice(0, 6);
    } finally {
      await page.close();
    }
  }

  /* ============================== PHASE 2: execution ========================= */
  {
    const phase = "phase2-execution";
    const title = "确认删除执行图";
    const fixture = await fixtureFor("phase2");
    const seeded = await prepareCanvasWithOneImage(fixture.canvasId, "p2", title);
    evidence.fixtures.phase2 = { canvasId: fixture.canvasId, sessionId: fixture.sessionId, projectId: fixture.projectId ?? null };
    const known = await confirmedIdsBefore(fixture.sessionId);
    evidence.phase2 = { seeded };
    const { page, pageErrors, consoleErrors, frames } = await openCanvasPage(browser, fixture, session);
    try {
      await sendFromComposer(page, `把画布上标题为「${title}」的那张图片删除掉`);
      const { card: root, confirmation } = await waitForDeleteCard(page, fixture.sessionId, known);
      const confirmationId = confirmation.confirmationId;
      evidence.phase2.confirmation = confirmation;
      if ((confirmation.targets ?? []).some((target) => target.elementId === seeded.elementId)) {
        pass(phase, "the proposal names the seeded image", `target elementId=${seeded.elementId}`);
      } else {
        fail(phase, "the proposal names the seeded image",
          `targets: ${JSON.stringify((confirmation.targets ?? []).map((target) => target.elementId))}`);
      }
      const cardCount = await cardById(page, confirmationId).count();
      evidence.phase2.targetedCardCount = cardCount;
      if (cardCount === 1) {
        pass(phase, "the phase addresses exactly one card, by its own confirmation id",
          `[data-confirmation-id="${confirmationId}"] matched 1 element`);
      } else {
        fail(phase, "the phase addresses exactly one card, by its own confirmation id", `matched ${cardCount}`);
      }
      const before = await canvasState(fixture.canvasId);
      const confirmButtonCount = await cardButtons(root).confirm.count();
      evidence.phase2.buttonCount = confirmButtonCount;
      if (confirmButtonCount === 1) {
        pass(phase, "the card exposes exactly one 确认删除 button", "count=1");
      } else {
        fail(phase, "the card exposes exactly one 确认删除 button", `count=${confirmButtonCount}`);
      }
      await cardButtons(root).confirm.first().click({ timeout: 30_000 });
      const clickedAt = new Date().toISOString();
      evidence.phase2.clickedAt = clickedAt;
      const ack = await waitForConfirmAck(frames, confirmationId);
      evidence.phase2.clickAck = ack;
      const settled = await waitForCardText(root, APPLIED_LABEL, 60_000);
      evidence.phase2.settledText = settled;
      await shot(page, "phase2-card-applied");
      const after = await waitForCanvas(fixture.canvasId, (state) => !state.liveIds.includes(seeded.elementId), 30_000);
      evidence.phase2.canvasAfter = { revision: after.revision, liveIds: after.liveIds, elementCount: after.elementCount };

      if (ack.terminal && (ack.terminal.status === "applied" || ack.terminal.status === "accepted")) {
        pass(phase, "the server acknowledged the click as successful", ackSummary(ack.terminal));
      } else {
        fail(phase, "the server acknowledged the click as successful", ackSummary(ack.terminal));
      }
      if (!after.liveIds.includes(seeded.elementId)) {
        pass(phase, "a real click deleted the element from the persisted canvas",
          `element gone, ${after.elementCount} live element(s) remain, revision ${before.revision} -> ${after.revision}`);
      } else {
        fail(phase, "a real click deleted the element from the persisted canvas",
          `element ${seeded.elementId} is still present after the click (${ackSummary(ack.terminal)})`);
      }
      if (settled.includes(APPLIED_LABEL)) {
        pass(phase, "card settled to the applied state", `card text contains 「${APPLIED_LABEL}」`);
      } else {
        fail(phase, "card settled to the applied state", `card text: ${settled.replace(/\n/g, " / ").slice(0, 300)}`);
      }
      // The card renders from the proposal block, whose output legitimately carries
      // `error: "confirmation_required"` (that IS the proposal). Treating that string
      // as a failure code made this check self-defeating; the click's own ack is the
      // only honest evidence of what happened after the click.
      const blockAfter = (await findConfirmationBlocks(fixture.sessionId, confirmationId))
        .map(({ block: current }) => current.output ?? {});
      evidence.phase2.blockAfter = blockAfter.map((output) => ({ status: output.status ?? null, error: output.error ?? null }));
      if (settled.includes(APPLIED_LABEL) && ack.terminal?.status !== "failed") {
        pass(phase, "message state is consistent (card applied and no failed click ack)");
      } else {
        fail(phase, "message state is consistent (card applied and no failed click ack)", ackSummary(ack.terminal));
      }
      if (pageErrors.length) info(phase, "page errors", pageErrors.slice(0, 3).join(" | "));
      if (consoleErrors.length) evidence.phase2.consoleErrors = consoleErrors.slice(0, 6);
    } finally {
      await page.close();
    }
  }

  if (!QUICK) {
    /* ============================== PHASE 3: expiry ========================== */
    const phase3 = "phase3-expiry";
    {
      const title = "过期测试图";
      const fixture = await fixtureFor("phase3");
      const seeded = await prepareCanvasWithOneImage(fixture.canvasId, "p3", title);
      evidence.fixtures.phase3 = { canvasId: fixture.canvasId, sessionId: fixture.sessionId, projectId: fixture.projectId ?? null };
      const known = await confirmedIdsBefore(fixture.sessionId);
      const { page, frames } = await openCanvasPage(browser, fixture, session);
      try {
        await sendFromComposer(page, `把画布上标题为「${title}」的那张图片删除掉`);
        const { card: root, confirmation } = await waitForDeleteCard(page, fixture.sessionId, known);
        const confirmationId = confirmation.confirmationId;
        evidence.phase3 = { seeded, confirmation, proposedAt: new Date().toISOString(), expiresAt: confirmation.expiresAt };
        pass(phase3, "unconfirmed card is pending in the browser",
          `confirmationId=${confirmationId} expiresAt=${confirmation.expiresAt}`);
        if ((confirmation.targets ?? []).some((target) => target.elementId === seeded.elementId)) {
          pass(phase3, "the proposal names the seeded image", `target elementId=${seeded.elementId}`);
        } else {
          fail(phase3, "the proposal names the seeded image",
            `targets: ${JSON.stringify((confirmation.targets ?? []).map((target) => target.elementId))}`);
        }

        const shortWait = SKIP_EXPIRY_WAIT ? 300 : 150;
        await sleep(shortWait * 1000);
        const untouched = await canvasState(fixture.canvasId);
        evidence.phase3.afterShortWait = { waitedSeconds: shortWait, liveIds: untouched.liveIds, revision: untouched.revision };
        if (untouched.liveIds.includes(seeded.elementId)) {
          pass(phase3, "no background timer applied the unconfirmed deletion",
            `element still present after ${shortWait}s (revision ${untouched.revision})`);
        } else {
          fail(phase3, "no background timer applied the unconfirmed deletion",
            `element ${seeded.elementId} disappeared without a click after ${shortWait}s`);
        }

        if (SKIP_EXPIRY_WAIT) {
          info(phase3, "TTL wait skipped", `--skip-expiry-wait: server TTL is 10 minutes (destructive-confirmation-service.ts)`);
        } else {
          const remaining = Date.parse(confirmation.expiresAt) - Date.now();
          const budgetMs = EXPIRY_WAIT_SECONDS * 1000;
          if (remaining > budgetMs) {
            info(phase3, "TTL wait exceeds the configured budget",
              `${Math.round(remaining / 1000)}s remaining but --wait-expiry-seconds=${EXPIRY_WAIT_SECONDS}; recording info only`);
            evidence.phase3.ttlWaitSkipped = { remainingSeconds: Math.round(remaining / 1000), budgetSeconds: EXPIRY_WAIT_SECONDS };
          } else {
            info(phase3, "waiting out the confirmation TTL",
              `${Math.max(0, Math.round(remaining / 1000))}s remaining of the 10-minute TTL`);
            if (remaining > 0) await sleep(remaining + 15_000);
            const atTtl = await canvasState(fixture.canvasId);
            evidence.phase3.afterTtlWait = { liveIds: atTtl.liveIds, revision: atTtl.revision };
            if (atTtl.liveIds.includes(seeded.elementId)) {
              pass(phase3, "the TTL elapsed with the image untouched",
                `element still present at TTL+15s, ${atTtl.elementCount} live element(s), revision ${atTtl.revision}`);
            } else {
              fail(phase3, "the TTL elapsed with the image untouched",
                `element ${seeded.elementId} vanished while the card was never confirmed`);
            }
            await shot(page, "phase3-card-after-ttl");
            const buttons = cardButtons(root);
            if (await buttons.confirm.count()) {
              await buttons.confirm.first().click({ timeout: 30_000 });
              // The card only reports 「失败」 once the server answers; wait for that
              // answer instead of asserting on an immediate screenshot.
              const ack = await waitForConfirmAck(frames, confirmationId, 30_000);
              const expired = await waitForCardState(
                root,
                ({ content, confirmButtons }) => /失败|已取消/.test(content) || confirmButtons === 0,
                20_000,
              );
              evidence.phase3.expiredClickAck = ack;
              evidence.phase3.cardAfterExpiredClick = expired.content;
              evidence.phase3.confirmButtonsAfterExpiredClick = expired.confirmButtons;
              const rejected = !expired.content.includes(APPLIED_LABEL)
                && (!ack.terminal || ack.terminal.status === "failed");
              if (rejected) {
                pass(phase3, "an expired card can no longer be confirmed",
                  `${ackSummary(ack.terminal)}; card did not reach 「${APPLIED_LABEL}」: ` +
                  `${expired.content.replace(/\n/g, " / ").slice(0, 200)}`);
              } else {
                fail(phase3, "an expired card can no longer be confirmed",
                  `card reported 「${APPLIED_LABEL}」 after the TTL (${ackSummary(ack.terminal)})`);
              }
              info(phase3, "expired-click server codes", ackSummary(ack.terminal));
            } else {
              fail(phase3, "an expired card can no longer be confirmed", "the confirm button was no longer rendered");
            }
            const finalState = await canvasState(fixture.canvasId);
            if (finalState.liveIds.includes(seeded.elementId)) {
              pass(phase3, "the rejected click did not delete anything", `element ${seeded.elementId} still present`);
            } else {
              fail(phase3, "the rejected click did not delete anything", `element ${seeded.elementId} is gone`);
            }
            // A rejected click must not be replayed by a background recovery tick either.
            await sleep(60_000);
            const afterRejection = await canvasState(fixture.canvasId);
            evidence.phase3.afterRejectionWait = { liveIds: afterRejection.liveIds, revision: afterRejection.revision };
            if (afterRejection.liveIds.includes(seeded.elementId)) {
              pass(phase3, "nothing replay-deleted the element after the expired click",
                `element still present 60s later (revision ${afterRejection.revision})`);
            } else {
              fail(phase3, "nothing replay-deleted the element after the expired click",
                `element ${seeded.elementId} disappeared after the rejected click`);
            }
          }
        }
      } finally {
        await page.close();
      }
    }

    /* ============================== PHASE 4: refresh ======================== */
    {
      const phase4 = "phase4-refresh";
      const title = "刷新测试图";
      const fixture = await fixtureFor("phase4");
      const seeded = await prepareCanvasWithOneImage(fixture.canvasId, "p4", title);
      evidence.fixtures.phase4 = { canvasId: fixture.canvasId, sessionId: fixture.sessionId, projectId: fixture.projectId ?? null };
      const known = await confirmedIdsBefore(fixture.sessionId);
      const { page, frames } = await openCanvasPage(browser, fixture, session);
      try {
        await sendFromComposer(page, `把画布上标题为「${title}」的那张图片删除掉`);
        const { card: root, confirmation } = await waitForDeleteCard(page, fixture.sessionId, known);
        const confirmationId = confirmation.confirmationId;
        if (!(confirmation.targets ?? []).some((target) => target.elementId === seeded.elementId)) {
          fail(phase4, "the proposal names the seeded image",
            `targets: ${JSON.stringify((confirmation.targets ?? []).map((target) => target.elementId))}`);
        }
        await cardButtons(root).confirm.first().click({ timeout: 30_000 });
        const ack = await waitForConfirmAck(frames, confirmationId);
        const settled = await waitForCardText(root, APPLIED_LABEL, 60_000);
        const afterClick = await waitForCanvas(fixture.canvasId, (state) => !state.liveIds.includes(seeded.elementId), 30_000);
        const signatureAfterClick = JSON.stringify({
          revision: afterClick.revision,
          ids: afterClick.liveIds,
          files: Object.keys(afterClick.content?.files ?? {}).sort(),
        });
        evidence.phase4 = {
          seeded,
          confirmation,
          clickAck: ack,
          settledText: settled,
          afterClick: { liveIds: afterClick.liveIds, revision: afterClick.revision, signature: signatureAfterClick },
        };
        if (afterClick.liveIds.includes(seeded.elementId)) {
          // Everything below would be meaningless: the reload check only says something
          // when the delete actually happened first.
          fail(phase4, "the delete succeeded before the reload test", `${ackSummary(ack.terminal)}`);
          info(phase4, "reload checks skipped", "the element was still present before the reload");
        } else {
          pass(phase4, "the delete succeeded before the reload test",
            `element gone, revision ${afterClick.revision}, ${ackSummary(ack.terminal)}`);
          const storageFlag = await page.evaluate(
            (id) => localStorage.getItem(`loomic:handled-confirmation:${id}`),
            confirmationId,
          );
          evidence.phase4.handledStorageFlag = storageFlag;
          // Count only the cards this phase created (its own session holds no others).
          const cardsForThisTarget = () => page.getByText(title, { exact: true }).count();
          const cardCountBefore = await cardsForThisTarget();
          evidence.phase4.cardCountBeforeReload = cardCountBefore;

          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
          await waitForComposer(page);
          await sleep(8000);
          await shot(page, "phase4-after-reload");
          const afterReload = await canvasState(fixture.canvasId);
          const signatureAfterReload = JSON.stringify({
            revision: afterReload.revision,
            ids: afterReload.liveIds,
            files: Object.keys(afterReload.content?.files ?? {}).sort(),
          });
          evidence.phase4.afterReload = {
            liveIds: afterReload.liveIds,
            revision: afterReload.revision,
            elementCount: afterReload.elementCount,
            signature: signatureAfterReload,
          };
          if (!afterReload.liveIds.includes(seeded.elementId)) {
            pass(phase4, "reload did not resurrect the deleted image",
              `element ${seeded.elementId} still absent (revision ${afterClick.revision} -> ${afterReload.revision})`);
          } else {
            fail(phase4, "reload did not resurrect the deleted image", `element ${seeded.elementId} is back on the canvas`);
          }
          if (signatureAfterReload === signatureAfterClick) {
            pass(phase4, "the persisted canvas is byte-identical across the reload",
              `revision ${afterReload.revision}, ${afterReload.elementCount} live element(s)`);
          } else {
            info(phase4, "the persisted canvas changed across the reload",
              `before=${signatureAfterClick.slice(0, 160)} after=${signatureAfterReload.slice(0, 160)}`);
          }
          const cardCountAfter = await cardsForThisTarget();
          evidence.phase4.cardCountAfterReload = cardCountAfter;
          if (cardCountAfter <= cardCountBefore) {
            pass(phase4, "reload did not duplicate the confirmation",
              `${cardCountAfter} card(s) carrying 「${title}」 after reload (was ${cardCountBefore})`);
          } else {
            fail(phase4, "reload did not duplicate the confirmation",
              `${cardCountAfter} cards after reload vs ${cardCountBefore} before`);
          }
          // A card that still offers 确认删除 after the action was applied would be the
          // "confirmation comes back on refresh" regression; record it plainly.
          const reloadedCard = cardById(page, confirmationId);
          const reloadedVisible = await reloadedCard.count();
          const confirmButtonsAfter = reloadedVisible
            ? await cardButtons(reloadedCard).confirm.count()
            : 0;
          evidence.phase4.confirmButtonsAfterReload = confirmButtonsAfter;
          if (confirmButtonsAfter === 0) {
            pass(phase4, "confirmed card does not reappear as a pending action after reload",
              reloadedVisible
                ? "the same card is rendered without a 确认删除 button"
                : "the confirmed card is not rendered at all");
          } else {
            fail(phase4, "confirmed card does not reappear as a pending action after reload",
              `${confirmButtonsAfter} 确认删除 button(s) rendered on [data-confirmation-id="${confirmationId}"]`);
          }
        }
      } finally {
        await page.close();
      }
    }
  } else {
    info("quick", "phase 3 skipped", "--quick");
  }

  /* ==================== the CLI-only question, answered with a browser ====== */
  {
    const phase = "cli-artifact";
    const title = "命令行对照图";
    const fixture = await fixtureFor("cliArtifact");
    const seeded = await prepareCanvasWithOneImage(fixture.canvasId, "cli", title);
    evidence.fixtures.cliArtifact = { canvasId: fixture.canvasId, sessionId: fixture.sessionId, projectId: fixture.projectId ?? null };
    const known = await confirmedIdsBefore(fixture.sessionId);
    const { page, frames } = await openCanvasPage(browser, fixture, session);
    try {
      await sendFromComposer(page, `把画布上标题为「${title}」的那张图片删除掉`);
      const { card: root, confirmation } = await waitForDeleteCard(page, fixture.sessionId, known);
      if (!(confirmation.targets ?? []).some((target) => target.elementId === seeded.elementId)) {
        fail(phase, "the proposal names the seeded image",
          `targets: ${JSON.stringify((confirmation.targets ?? []).map((target) => target.elementId))}`);
      }
      const probe = await cliArtifactProbe(session.access_token, confirmation.confirmationId);
      evidence.cliArtifact = { seeded, confirmationId: confirmation.confirmationId, ...probe };
      info(phase, "independent CLI socket, unknown id", JSON.stringify(probe.bogus));
      info(phase, "independent CLI socket, real pending id", JSON.stringify(probe.real));
      // The browser's own click still works on the same proposal.
      await cardButtons(root).confirm.first().click({ timeout: 30_000 });
      const ack = await waitForConfirmAck(frames, confirmation.confirmationId);
      const text = await waitForCardText(root, APPLIED_LABEL, 60_000);
      const after = await waitForCanvas(fixture.canvasId, (state) => !state.liveIds.includes(seeded.elementId), 30_000);
      evidence.cliArtifact.browserClickText = text;
      evidence.cliArtifact.browserClickAck = ack;
      if (text.includes(APPLIED_LABEL) && !after.liveIds.includes(seeded.elementId)) {
        pass(phase, "the same confirmation executes from a real browser click",
          `element ${seeded.elementId} deleted by the browser after the CLI socket failed (${ackSummary(ack.terminal)})`);
      } else {
        fail(phase, "the same confirmation executes from a real browser click",
          `card: ${text.replace(/\n/g, " / ").slice(0, 200)}; ${ackSummary(ack.terminal)}`);
      }    } finally {
      await page.close();
    }
  }
} finally {
  await saveEvidence(evidence);
  await browser.close();
}

if (failures > 0) process.exitCode = 1;
