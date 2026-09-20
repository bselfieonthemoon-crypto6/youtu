// Diagnostic only (not a deliverable): prove or disprove that phase 2's failure was
// caused by the probe clicking an ACCUMULATED card instead of the one it created.
// Runs phase 2 alone, in a FRESH isolated project/canvas/session, and targets the card
// by its own confirmationId (data-confirmation-id) rather than "the last card".
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const REPO_ROOT = "E:/Loomic/Loomic";
const ARTIFACT_DIR = resolve(REPO_ROOT, "artifacts", "delete-confirmation-browser");
const SEED_SOURCE = resolve(REPO_ROOT, "apps", "web", "public", "apple-touch-icon.png");
const BASE = "http://localhost:3020";
const API = "http://127.0.0.1:3002";
const QA_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const DELETE_TITLE = "需要确认危险操作";
const CONFIRM_LABEL = "确认删除";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const account = await admin.auth.admin.getUserById(QA_OWNER);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
const verified = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const session = verified.data.session;

// A brand-new fixture: project + canvas + session that no earlier run has ever used.
const fixturePath = resolve(ARTIFACT_DIR, "diag-fresh-fixture.json");
execSync(
  `"${process.execPath}" --env-file=.env.local apps/server/scripts/agent-sim-tools.mjs create --name phase2-fresh-probe --out "${fixturePath}"`,
  { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 },
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
console.log("fresh fixture:", JSON.stringify(fixture));

/* seed one image with a title the prompt can name */
const title = "执行阶段独立图";
const bytes = await readFile(SEED_SOURCE);
const objectPath = `qa/delete-confirmation/${randomUUID()}-diag.png`;
const upload = await admin.storage.from("workspace-assets").upload(objectPath, bytes, { contentType: "image/png" });
assert(!upload.error, `upload failed: ${upload.error?.message}`);
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
      customData: { assetId: objectPath, seededBy: "diag", title },
    }],
    appState: {},
    files: { [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } },
  },
}).eq("id", fixture.canvasId);
console.log("seeded element", elementId);

const token = session.access_token;
async function transcriptBlocks() {
  const response = await fetch(`${API}/api/sessions/${fixture.sessionId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  const messages = Array.isArray(payload) ? payload : (payload.messages ?? []);
  return messages.flatMap((message) => (message.contentBlocks ?? message.content_blocks ?? []).map((block) => ({ messageId: message.id, block })));
}
const confirmations = async () => (await transcriptBlocks())
  .filter(({ block }) => block?.type === "tool" && block.output?.confirmation)
  .map(({ block }) => block.output.confirmation);

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
        try {
          const parsed = JSON.parse(String(event.data));
          if (parsed?.type === "command.ack" || parsed?.type === "error") {
            window.__recordFrame({ direction: "in", at: new Date().toISOString(), message: parsed });
          }
        } catch { /* not JSON */ }
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        try {
          const parsed = JSON.parse(String(data));
          if (parsed?.action) window.__recordFrame({ direction: "out", at: new Date().toISOString(), message: parsed });
        } catch { /* ignore */ }
        return send(data);
      };
      return socket;
    },
  });
}, session);

await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
await composer.waitFor({ state: "visible", timeout: 120_000 });
await sleep(4000);

const known = new Set((await confirmations()).map((item) => item.confirmationId));
const prompt = `把画布上标题为「${title}」的那张图片删除掉`;
await composer.fill(prompt);
await page.getByRole("button", { name: "发送消息", exact: true }).click({ timeout: 30_000 });

let confirmation = null;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const fresh = (await confirmations()).filter((item) => !known.has(item.confirmationId));
  if (fresh.length) { confirmation = fresh[fresh.length - 1]; break; }
  await sleep(1000);
}
assert(confirmation, "no fresh confirmation appeared");
console.log("fresh confirmation:", JSON.stringify(confirmation));

const root = page.locator(`[data-confirmation-id="${confirmation.confirmationId}"]`);
await root.waitFor({ state: "visible", timeout: 60_000 });
console.log("targeted card count:", await root.count());
console.log("card text before:", (await root.innerText()).replace(/\n/g, " | "));
const targetsSeeded = (confirmation.targets ?? []).some((target) => target.elementId === elementId);
console.log("proposal targets the seeded element:", targetsSeeded);

const before = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
console.log("live ids before click:", (before.data.content.elements ?? []).filter((element) => !element.isDeleted).map((element) => element.id), "revision", before.data.revision);

await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).click({ timeout: 30_000 });
await sleep(20_000);

const afterText = await root.innerText().catch(() => "<detached>");
const after = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
const liveAfter = (after.data.content.elements ?? []).filter((element) => !element.isDeleted).map((element) => element.id);
const acks = frames.filter((frame) => JSON.stringify(frame.message).includes("confirm_action") || JSON.stringify(frame.message).includes("confirmationId"));
console.log("card text after:", String(afterText).replace(/\n/g, " | "));
console.log("live ids after click:", liveAfter, "revision", after.data.revision);
console.log("deleted:", !liveAfter.includes(elementId));
console.log("ws frames:", JSON.stringify(acks, null, 2));
await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `diag-fresh-phase2-${Date.now()}.png`) });

await mkdir(ARTIFACT_DIR, { recursive: true });
const out = resolve(ARTIFACT_DIR, `diag-fresh-phase2-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(out, `${JSON.stringify({ fixture, title, elementId, confirmation, targetsSeeded, cardBefore: await root.innerText().catch(() => null), cardAfter: afterText, liveIdsBefore: (before.data.content.elements ?? []).map((e) => e.id), liveIdsAfter: liveAfter, deleted: !liveAfter.includes(elementId), frames: acks }, null, 2)}\n`);
console.log("EVIDENCE", out);
await browser.close();
