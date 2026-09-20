// Diagnostic only: when exactly does the deletion target's version change, and is the
// page's own canvas session responsible? Two modes:
//   --with-page   seed, open the canvas page, send the delete request, poll at 200ms
//   --no-page     seed, send the delete request through the API with no browser open
// The control run separates "the browser's canvas session rewrites the element" from
// "the agent's own tool call rewrites it".
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const REPO_ROOT = "E:/Loomic/Loomic";
const ARTIFACT_DIR = resolve(REPO_ROOT, "artifacts", "delete-confirmation-browser");
const SEED_SOURCE = resolve(REPO_ROOT, "apps", "web", "public", "apple-touch-icon.png");
const BASE = "http://localhost:3020";
const API = "http://127.0.0.1:3002";
const QA_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const CONFIRM_LABEL = "确认删除";
const WITH_PAGE = !process.argv.includes("--no-page");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const account = await admin.auth.admin.getUserById(QA_OWNER);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
const verified = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const session = verified.data.session;
const token = session.access_token;

const fixturePath = resolve(ARTIFACT_DIR, `diag-window-${WITH_PAGE ? "page" : "nopage"}-fixture.json`);
execSync(`"${process.execPath}" --env-file=.env.local apps/server/scripts/agent-sim-tools.mjs create --name window-trace-${WITH_PAGE ? "page" : "nopage"} --out "${fixturePath}"`,
  { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const title = WITH_PAGE ? "窗口追踪图A" : "窗口追踪图B";
const bytes = await readFile(SEED_SOURCE);
const objectPath = `qa/delete-confirmation/${randomUUID()}-window.png`;
await admin.storage.from("workspace-assets").upload(objectPath, bytes, { contentType: "image/png" });
const elementId = `sim-image-${randomUUID()}`;
const fileId = `sim-file-${randomUUID()}`;
await admin.from("canvases").update({
  content: {
    elements: [{
      type: "image", id: elementId, x: 0, y: 0, width: 900, height: 1200, angle: 0, fileId, status: "saved",
      scale: [1, 1], crop: null, groupIds: [], boundElements: null, frameId: null, index: null, seed: 1,
      version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(), link: null, locked: false, opacity: 100,
      roundness: null, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid",
      strokeWidth: 1, strokeStyle: "solid", roughness: 0, customData: { assetId: objectPath, title },
    }],
    appState: {},
    files: { [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } },
  },
}).eq("id", fixture.canvasId);

// High-resolution poll: every observed change with a wall-clock timestamp.
const events = [];
let lastKey = null;
let polling = false;
async function pollOnce(label) {
  const row = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
  const element = (row.data.content?.elements ?? []).find((item) => item.id === elementId);
  const key = `${row.data.revision}|${element?.version}|${element?.versionNonce}|${element?.isDeleted}`;
  if (key !== lastKey) {
    lastKey = key;
    events.push({ at: new Date().toISOString(), label, revision: row.data.revision, version: element?.version ?? null,
      versionNonce: element?.versionNonce ?? null, isDeleted: element?.isDeleted ?? null });
  }
}
const poller = (async () => {
  polling = true;
  while (polling) { await pollOnce("poll").catch(() => undefined); await sleep(200); }
})();
await pollOnce("after-seed");

const transcriptBlocks = async () => {
  const response = await fetch(`${API}/api/sessions/${fixture.sessionId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  const messages = Array.isArray(payload) ? payload : (payload.messages ?? []);
  return messages.flatMap((message) => (message.contentBlocks ?? message.content_blocks ?? []).map((block) => ({ messageId: message.id, block })));
};

const toolsSeen = [];
async function sendPromptThroughApi() {
  const created = await fetch(`${API}/api/sessions/${fixture.sessionId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: `把画布上标题为「${title}」的那张图片删除掉`,
      contentBlocks: [{ type: "text", text: `把画布上标题为「${title}」的那张图片删除掉` }] }),
  });
  assert(created.ok, `message create failed: ${created.status}`);
  const body = await created.json();
  const userMessageId = body?.message?.id ?? null;
  // The run itself is started over the WebSocket the same way the browser does it, so
  // this control uses the product path, not a shortcut. `apps/web` has no `ws` package,
  // and Node 24 ships a browser-compatible global WebSocket, so use that.
  const socket = new WebSocket(`${API.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`);
  await new Promise((open, reject) => { socket.addEventListener("open", open, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.send(JSON.stringify({ type: "command", action: "agent.run", accessToken: token, requestId: randomUUID(),
    payload: { sessionId: fixture.sessionId, conversationId: fixture.canvasId, canvasId: fixture.canvasId,
      userMessageId, prompt: `把画布上标题为「${title}」的那张图片删除掉`, canvasSelection: { elementIds: [] },
      imageGenerationPreference: { mode: "auto", models: [], aspectRatio: "auto" }, executionMode: "thinking" } }));
  return socket;
}

let browser = null;
let page = null;
let socket = null;
if (WITH_PAGE) {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
  await page.addInitScript((value) => { localStorage.setItem("sb-127-auth-token", JSON.stringify(value)); }, session);
  await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.waitFor({ state: "visible", timeout: 120_000 });
  await sleep(6000);
  await pollOnce("after-page-load");
  await composer.fill(`把画布上标题为「${title}」的那张图片删除掉`);
  await page.getByRole("button", { name: "发送消息", exact: true }).click({ timeout: 30_000 });
  await pollOnce("after-send");
} else {
  socket = await sendPromptThroughApi();
  await pollOnce("after-send");
}

// Track every tool block landing, with the element version at that instant.
let seen = 0;
let confirmation = null;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const blocks = (await transcriptBlocks()).filter(({ block }) => block?.type === "tool");
  while (seen < blocks.length) {
    const { block } = blocks[seen];
    await pollOnce(`tool:${block.toolName}`);
    toolsSeen.push({ at: new Date().toISOString(), tool: block.toolName, status: block.status,
      error: block.output?.error ?? null, targetVersion: block.output?.confirmation?.targets?.[0]?.version ?? null,
      targetNonce: block.output?.confirmation?.targets?.[0]?.versionNonce ?? null,
      confirmationId: block.output?.confirmation?.confirmationId ?? null });
    seen += 1;
  }
  const fresh = blocks.map(({ block }) => block?.output?.confirmation).filter(Boolean);
  if (fresh.length) { confirmation = fresh[fresh.length - 1]; break; }
  await sleep(500);
}
assert(confirmation, "no confirmation appeared");
await pollOnce("at-proposal");

let ack = null;
if (WITH_PAGE) {
  const root = page.locator(`[data-confirmation-id="${confirmation.confirmationId}"]`);
  await root.waitFor({ state: "visible", timeout: 60_000 });
  await pollOnce("at-card-visible");
  const frames = [];
  await page.exposeFunction("__recordConfirmFrame", (entry) => frames.push(entry));
  await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).click({ timeout: 30_000 });
  await pollOnce("after-click");
  await sleep(10_000);
  await pollOnce("10s-after-click");
  ack = frames;
  await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `diag-window-${Date.now()}.png`) });
} else {
  // Confirm from the same socket that started the run, i.e. the product's own
  // confirmation channel with no page involved at all.
  ack = await new Promise((done) => {
    const timer = setTimeout(() => done([{ note: "no ack in 60s" }]), 60_000);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.action === "agent.confirm_action" && message.payload?.status !== "accepted") {
          clearTimeout(timer); done(message.payload);
        }
      } catch { /* ignore */ }
    });
    socket.send(JSON.stringify({ type: "command", action: "agent.confirm_action", accessToken: token,
      requestId: randomUUID(), payload: { confirmationId: confirmation.confirmationId, decision: "confirm" } }));
  });
  await pollOnce("after-confirm");
  await sleep(8000);
  await pollOnce("8s-after-confirm");
}

polling = false;
await poller;
const live = (await admin.from("canvases").select("content").eq("id", fixture.canvasId).single()).data.content.elements
  .filter((element) => !element.isDeleted).map((element) => element.id);

console.log(JSON.stringify({ mode: WITH_PAGE ? "with-page" : "no-page", fixture, elementId,
  proposalTarget: confirmation.targets?.[0] ?? null, toolsSeen, events, ack, liveAfterDelete: live }, null, 1));
await mkdir(ARTIFACT_DIR, { recursive: true });
const allBlocks = await transcriptBlocks();
const toolDump = allBlocks.filter(({ block }) => block?.type === "tool").map(({ block }) => ({
  toolName: block.toolName,
  status: block.status,
  args: block.args ?? block.input ?? block.toolInput ?? null,
  output: block.output ?? null,
}));
await writeFile(resolve(ARTIFACT_DIR, `diag-window-${WITH_PAGE ? "page" : "nopage"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ mode: WITH_PAGE ? "with-page" : "no-page", fixture, elementId, proposalTarget: confirmation.targets?.[0] ?? null,
    toolsSeen, events, ack, liveAfterDelete: live, toolDump }, null, 2)}\n`);
console.log("TOOL DUMP:", JSON.stringify(toolDump.map((entry) => ({
  tool: entry.toolName, status: entry.status, args: entry.args,
  error: entry.output?.error ?? null, targetVersion: entry.output?.confirmation?.targets?.[0]?.version ?? null,
})), null, 1));
if (socket) socket.close();
if (browser) await browser.close();
