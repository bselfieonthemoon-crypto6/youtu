// Diagnostic only: with a fresh canvas holding ONE seeded image, open the canvas page
// and do nothing else. If the element's version changes, the browser's own canvas
// session — not the agent — is rewriting persisted element versions, which is what
// makes a later delete confirmation fail its "target unchanged" revalidation.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
execSync(`"${process.execPath}" --env-file=.env.local apps/server/scripts/agent-sim-tools.mjs create --name idle-page-trace --out "${fixturePath}"`,
  { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const bytes = await readFile(SEED_SOURCE);
const objectPath = `qa/delete-confirmation/${randomUUID()}-idle.png`;
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
      strokeWidth: 1, strokeStyle: "solid", roughness: 0, customData: { assetId: objectPath, title: "空闲追踪图" },
    }],
    appState: {},
    files: { [fileId]: { id: fileId, mimeType: "image/png", created: Date.now(), assetId: objectPath } },
  },
}).eq("id", fixture.canvasId);

const observations = [];
let lastKey = null;
async function sample(label) {
  const row = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
  const element = (row.data.content?.elements ?? []).find((item) => item.id === elementId);
  const key = `${row.data.revision}|${element?.version}|${element?.versionNonce}`;
  if (key !== lastKey) {
    lastKey = key;
    observations.push({ at: new Date().toISOString(), label, revision: row.data.revision,
      version: element?.version ?? null, versionNonce: element?.versionNonce ?? null,
      x: element?.x ?? null, y: element?.y ?? null, width: element?.width ?? null, height: element?.height ?? null,
      updated: element?.updated ?? null });
    console.log("CHANGE", JSON.stringify(observations[observations.length - 1]));
  }
}
const poller = (async () => { for (let i = 0; i < 300; i += 1) { await sample("poll"); await sleep(250); } })();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const puts = [];
page.on("request", (request) => {
  if (request.method() === "PUT" && request.url().includes("/api/canvases/")) {
    puts.push({ at: new Date().toISOString(), url: request.url(), bytes: (request.postData() ?? "").length });
    console.log("PUT", request.url(), (request.postData() ?? "").length, "bytes");
  }
});
page.on("response", (response) => {
  if (response.request().method() === "PUT" && response.url().includes("/api/canvases/")) {
    console.log("PUT-RESPONSE", response.status());
  }
});
await page.addInitScript((value) => { localStorage.setItem("sb-127-auth-token", JSON.stringify(value)); }, session);
await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
await composer.waitFor({ state: "visible", timeout: 120_000 });
console.log("composer visible at", new Date().toISOString());
await sample("composer-visible");
// Nothing else happens: no prompt, no agent run, no click.
await sleep(45_000);
await sample("end-of-idle-window");

console.log("IDLE OBSERVATIONS:", JSON.stringify(observations, null, 1));
console.log("PUT COUNT:", puts.length, JSON.stringify(puts, null, 1));
await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `diag-idle-${Date.now()}.png`) });
await browser.close();
process.exit(0);
