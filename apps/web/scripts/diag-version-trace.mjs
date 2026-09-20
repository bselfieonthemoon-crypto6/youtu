// Diagnostic only: track the version/versionNonce of the deletion target from the
// moment it is seeded, through proposal creation, to the moment the confirmation is
// confirmed — and, separately, confirm the SAME proposal from the server side.
// This separates "the browser's canvas session rewrites the element version before the
// click" (client/CAS race) from "the delete execution itself is broken".
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const account = await admin.auth.admin.getUserById(QA_OWNER);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
const verified = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const session = verified.data.session;

const fixturePath = resolve(ARTIFACT_DIR, "diag-version-fixture.json");
for (let attempt = 1; ; attempt += 1) {
  try {
    execSync(`"${process.execPath}" --env-file=.env.local apps/server/scripts/agent-sim-tools.mjs create --name version-trace --out "${fixturePath}"`,
      { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
    break;
  } catch (error) {
    if (attempt >= 6) throw error;
    console.log(`fixture create attempt ${attempt} failed (API restarting?), retrying in 15s`);
    await new Promise((done) => setTimeout(done, 15_000));
  }
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const title = "版本追踪图";
const bytes = await readFile(SEED_SOURCE);
const objectPath = `qa/delete-confirmation/${randomUUID()}-version.png`;
await admin.storage.from("workspace-assets").upload(objectPath, bytes, { contentType: "image/png" });
const elementId = `sim-image-${randomUUID()}`;
const fileId = `sim-file-${randomUUID()}`;
await admin.from("canvases").update({
  content: {
    elements: [{
      type: "image", id: elementId, x: 0, y: 0, width: 900, height: 1200, angle: 0,
      fileId, status: "saved", scale: [1, 1], crop: null, groupIds: [], boundElements: null,
      frameId: null, index: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
      updated: Date.now(), link: null, locked: false, opacity: 100, roundness: null,
      strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid",
      strokeWidth: 1, strokeStyle: "solid", roughness: 0,
      customData: { assetId: objectPath, title },
    }],
    appState: {},
    files: { [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } },
  },
}).eq("id", fixture.canvasId);

const trace = [];
async function snapshot(label) {
  const row = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
  const element = (row.data.content?.elements ?? []).find((item) => item.id === elementId);
  trace.push({
    label,
    at: new Date().toISOString(),
    revision: row.data.revision,
    version: element?.version ?? null,
    versionNonce: element?.versionNonce ?? null,
    isDeleted: element?.isDeleted ?? null,
    seed: element?.seed ?? null,
    customData: element?.customData ?? null,
  });
  return element;
}
await snapshot("after-seed");

const token = session.access_token;
const transcriptBlocks = async () => {
  const response = await fetch(`${API}/api/sessions/${fixture.sessionId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  const messages = Array.isArray(payload) ? payload : (payload.messages ?? []);
  return messages.flatMap((message) => (message.contentBlocks ?? message.content_blocks ?? []).map((block) => ({ messageId: message.id, block })));
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const frames = [];
await page.exposeFunction("__recordFrame", (entry) => { frames.push(entry); });
await page.addInitScript((value) => {
  localStorage.setItem("sb-127-auth-token", JSON.stringify(value));
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      const socket = new target(...args);
      socket.addEventListener("message", (event) => {
        try { const parsed = JSON.parse(String(event.data)); if (parsed?.action) window.__recordFrame({ direction: "in", at: new Date().toISOString(), message: parsed }); } catch { }
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => { try { const parsed = JSON.parse(String(data)); if (parsed?.action) window.__recordFrame({ direction: "out", at: new Date().toISOString(), message: { action: parsed.action, payload: parsed.payload } }); } catch { } return send(data); };
      return socket;
    },
  });
}, session);

await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
await composer.waitFor({ state: "visible", timeout: 120_000 });
await sleep(6000);
await snapshot("after-page-load");

const known = new Set((await transcriptBlocks()).filter(({ block }) => block?.output?.confirmation).map(({ block }) => block.output.confirmation.confirmationId));
await composer.fill(`把画布上标题为「${title}」的那张图片删除掉`);
await page.getByRole("button", { name: "发送消息", exact: true }).click({ timeout: 30_000 });

let confirmation = null;
let seenBlocks = 0;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const blocks = await transcriptBlocks();
  const toolBlocks = blocks.filter(({ block }) => block?.type === "tool");
  // Snapshot the element right after each new tool block lands, so the version bump
  // can be attributed to a specific call instead of a time window.
  while (seenBlocks < toolBlocks.length) {
    const { block } = toolBlocks[seenBlocks];
    await snapshot(`after-tool-${seenBlocks + 1}-${block.toolName}`);
    seenBlocks += 1;
  }
  const fresh = blocks.map(({ block }) => block?.output?.confirmation).filter((item) => item && !known.has(item.confirmationId));
  if (fresh.length) { confirmation = fresh[fresh.length - 1]; break; }
  await sleep(700);
}
assert(confirmation, "no confirmation appeared");
// Which tools ran this turn, and what did they answer? The version bump must be
// attributable to one of them (or to nothing at all).
const turnBlocks = (await transcriptBlocks()).filter(({ block }) => block?.type === "tool");
console.log("TOOL CALLS:", JSON.stringify(turnBlocks.map(({ block }) => ({
  tool: block.toolName,
  status: block.status,
  error: block.output?.error ?? null,
  confirmationId: block.output?.confirmation?.confirmationId ?? null,
  targetVersion: block.output?.confirmation?.targets?.[0]?.version ?? null,
})), null, 1));
const atProposal = await snapshot("at-proposal (transcript has the confirmation)");
console.log("target snapshot in proposal:", JSON.stringify(confirmation.targets?.[0]));
console.log("element at proposal:", JSON.stringify(atProposal && { version: atProposal.version, versionNonce: atProposal.versionNonce, isDeleted: atProposal.isDeleted }));

const root = page.locator(`[data-confirmation-id="${confirmation.confirmationId}"]`);
await root.waitFor({ state: "visible", timeout: 60_000 });
const atCardVisible = await snapshot("at-card-visible");
console.log("element at card visible:", JSON.stringify(atCardVisible && { version: atCardVisible.version, versionNonce: atCardVisible.versionNonce }));

await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).click({ timeout: 30_000 });
const clickAt = Date.now();
await sleep(1500);
await snapshot("1.5s-after-click");
await sleep(8000);
const afterClick = await snapshot("10s-after-click");
const afterText = await root.innerText().catch(() => "<detached>");
console.log("card text after:", String(afterText).replace(/\n/g, " | "));
console.log("element after click:", JSON.stringify(afterClick && { version: afterClick.version, versionNonce: afterClick.versionNonce, isDeleted: afterClick.isDeleted }));
console.log("live after click:", (await admin.from("canvases").select("content").eq("id", fixture.canvasId).single()).data.content.elements.filter((e) => !e.isDeleted).map((e) => e.id));
console.log("frames:", JSON.stringify(frames.filter((f) => JSON.stringify(f.message).includes("confirm")), null, 1));

await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(resolve(ARTIFACT_DIR, `diag-version-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ fixture, elementId, confirmation, trace, toolCalls: turnBlocks.map(({ block }) => ({ tool: block.toolName, status: block.status, error: block.output?.error ?? null, output: block.output })), cardAfter: afterText, clickAt, frames }, null, 2)}\n`);
console.log("trace:", JSON.stringify(trace, null, 1));
await browser.close();
