// Diagnostic only: is the version bump caused by the page's own canvas sync clearing
// the in-flight autosave guard? Sequence: load the page, wait past the idle window
// (no save happens), then send ONE message so the page runs handleCanvasSync, and log
// every canvas PUT body's element version alongside the scene version before/after.
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
const QA_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const account = await admin.auth.admin.getUserById(QA_OWNER);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
const verified = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const session = verified.data.session;

const fixturePath = resolve(ARTIFACT_DIR, "diag-idle-fixture.json");
execSync(`"${process.execPath}" --env-file=.env.local apps/server/scripts/agent-sim-tools.mjs create --name sync-bump-trace --out "${fixturePath}"`,
  { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const bytes = await readFile(SEED_SOURCE);
const objectPath = `qa/delete-confirmation/${randomUUID()}-syncbump.png`;
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
      strokeWidth: 1, strokeStyle: "solid", roughness: 0, customData: { assetId: objectPath, title: "同步追踪图" },
    }],
    appState: {},
    files: { [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } },
  },
}).eq("id", fixture.canvasId);

const dbRead = async () => {
  const row = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
  const element = (row.data.content?.elements ?? []).find((item) => item.id === elementId);
  return { revision: row.data.revision, version: element?.version ?? null, versionNonce: element?.versionNonce ?? null };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const puts = [];
page.on("request", (request) => {
  if (request.method() === "PUT" && request.url().includes("/api/canvases/")) {
    let elementVersion = null;
    try {
      const body = JSON.parse(request.postData() ?? "{}");
      elementVersion = (body.content?.elements ?? []).find((item) => item.id === elementId)?.version ?? null;
    } catch { /* not JSON */ }
    puts.push({ at: new Date().toISOString(), elementVersion });
    console.log("PUT with element version", elementVersion, "at", puts[puts.length - 1].at);
  }
});
await page.addInitScript((value) => { localStorage.setItem("sb-127-auth-token", JSON.stringify(value)); }, session);
await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
await composer.waitFor({ state: "visible", timeout: 120_000 });
await sleep(12_000);
const afterLoad = await dbRead();
console.log("after load (idle, past autosave debounce):", JSON.stringify(afterLoad), "puts:", puts.length);
const sceneBefore = await page.evaluate(() => {
  const api = window.__excalidrawApi ?? null;
  return api ? api.getSceneElements().map((el) => ({ id: el.id, version: el.version, versionNonce: el.versionNonce })) : "no api handle";
});
console.log("scene before send:", JSON.stringify(sceneBefore));

// Sending a message is what makes the page run handleCanvasSync (canvas.sync event).
await composer.fill("你好");
await page.getByRole("button", { name: "发送消息", exact: true }).click({ timeout: 30_000 });
await sleep(15_000);
const afterSend = await dbRead();
console.log("after send:", JSON.stringify(afterSend), "puts:", JSON.stringify(puts));
await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `diag-syncbump-${Date.now()}.png`) });
await writeFile(resolve(ARTIFACT_DIR, `diag-syncbump-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ fixture, elementId, afterLoad, sceneBefore, afterSend, puts }, null, 2)}\n`);
await browser.close();
process.exit(0);
