// Diagnostic only: when the confirmation reports "target changed", what actually
// differs between the element at proposal time and at execution time? Seeds a fixture,
// reads the canvas as the tool will, then follows a real delete card and dumps a full
// field diff for the target element across the whole window.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
const token = session.access_token;

const fixturePath = resolve(ARTIFACT_DIR, "diag-diff-fixture.json");
execSync(`"${process.execPath}" --env-file=.env.local apps/server/scripts/agent-sim-tools.mjs create --name field-diff --out "${fixturePath}"`,
  { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const title = "字段差异图";
const bytes = await readFile(SEED_SOURCE);
const objectPath = `qa/delete-confirmation/${randomUUID()}-diff.png`;
await admin.storage.from("workspace-assets").upload(objectPath, bytes, { contentType: "image/png" });
const elementId = `sim-image-${randomUUID()}`;
const fileId = `sim-file-${randomUUID()}`;
const seededElement = {
  type: "image", id: elementId, x: 0, y: 0, width: 900, height: 1200, angle: 0, fileId, status: "saved",
  scale: [1, 1], crop: null, groupIds: [], boundElements: null, frameId: null, index: null, seed: 1,
  version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(), link: null, locked: false, opacity: 100,
  roundness: null, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 1, strokeStyle: "solid", roughness: 0, customData: { assetId: objectPath, title },
};
await admin.from("canvases").update({
  content: { elements: [seededElement], appState: {}, files: { [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } } },
}).eq("id", fixture.canvasId);

const readElement = async () => {
  const row = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
  const element = (row.data.content?.elements ?? []).find((item) => item.id === elementId);
  return { revision: row.data.revision, element: element ?? null };
};

const transcriptBlocks = async () => {
  const response = await fetch(`${API}/api/sessions/${fixture.sessionId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  const messages = Array.isArray(payload) ? payload : (payload.messages ?? []);
  return messages.flatMap((message) => (message.contentBlocks ?? message.content_blocks ?? []).map((block) => ({ block })));
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const frames = [];
await page.exposeFunction("__recordConfirmFrame", (entry) => frames.push(entry));
await page.addInitScript((value) => {
  localStorage.setItem("sb-127-auth-token", JSON.stringify(value));
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      const socket = new target(...args);
      socket.addEventListener("message", (event) => {
        try { const parsed = JSON.parse(String(event.data)); if (parsed?.action === "agent.confirm_action") window.__recordConfirmFrame({ direction: "in", message: parsed }); } catch { }
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => { try { const parsed = JSON.parse(String(data)); if (parsed?.action === "agent.confirm_action") window.__recordConfirmFrame({ direction: "out", message: { action: parsed.action, payload: parsed.payload } }); } catch { } return send(data); };
      return socket;
    },
  });
}, session);
await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
await composer.waitFor({ state: "visible", timeout: 120_000 });
await sleep(5000);

const known = new Set((await transcriptBlocks()).map(({ block }) => block?.output?.confirmation?.confirmationId).filter(Boolean));
await composer.fill(`把画布上标题为「${title}」的那张图片删掉`);
await page.getByRole("button", { name: "发送消息", exact: true }).click({ timeout: 30_000 });

let confirmation = null;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const fresh = (await transcriptBlocks()).map(({ block }) => block?.output?.confirmation).filter((item) => item && !known.has(item.confirmationId));
  if (fresh.length) { confirmation = fresh[fresh.length - 1]; break; }
  await sleep(700);
}
if (!confirmation) throw new Error("no confirmation");
const atProposal = await readElement();
const root = page.locator(`[data-confirmation-id="${confirmation.confirmationId}"]`);
await root.waitFor({ state: "visible", timeout: 60_000 });
const atCard = await readElement();
await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).click({ timeout: 30_000 });
await sleep(12_000);
const afterClick = await readElement();

const diff = (a, b) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out = {};
  for (const key of keys) {
    const left = JSON.stringify(a?.[key] ?? null);
    const right = JSON.stringify(b?.[key] ?? null);
    if (left !== right) out[key] = { proposal: a?.[key] ?? null, after: b?.[key] ?? null };
  }
  return out;
};
console.log("TARGET AT PROPOSAL:", JSON.stringify(atProposal.element));
console.log("TARGET AT CARD VISIBLE:", JSON.stringify(atCard.element));
console.log("TARGET AFTER CLICK:", JSON.stringify(afterClick.element));
console.log("DIFF proposal->card:", JSON.stringify(diff(atProposal.element, atCard.element), null, 1));
console.log("DIFF proposal->after:", JSON.stringify(diff(atProposal.element, afterClick.element), null, 1));
console.log("ACKS:", JSON.stringify(frames, null, 1));
await writeFile(resolve(ARTIFACT_DIR, `diag-fielddiff-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ fixture, elementId, seededElement, confirmation, atProposal, atCard, afterClick,
    diffProposalToCard: diff(atProposal.element, atCard.element), diffProposalToAfter: diff(atProposal.element, afterClick.element), frames }, null, 2)}\n`);
await browser.close();
process.exit(0);
