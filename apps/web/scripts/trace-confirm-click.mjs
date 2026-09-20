// Diagnostic only (never a deliverable): drive the real card on the accumulated
// session, log EVERY websocket frame the page sends/receives around the click, and
// record which card the locator actually resolved to. This separates "the browser
// sent the wrong confirmationId" from "the server rejected a correct one".
//
// Run from apps/web:
//   node --env-file=../../.env.local ../../artifacts/delete-confirmation-browser/trace-confirm-click.mjs
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const REPO_ROOT = resolve("E:/Loomic/Loomic");
const ARTIFACT_DIR = resolve(REPO_ROOT, "artifacts", "delete-confirmation-browser");
const BASE = process.env.CONFIRM_BASE_URL ?? "http://localhost:3020";
const QA_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const DELETE_TITLE = "需要确认危险操作";
const CONFIRM_LABEL = "确认删除";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const fixture = JSON.parse(await readFile(resolve(ARTIFACT_DIR, "fixture.json"), "utf8"));
console.log("fixture", fixture);

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const account = await admin.auth.admin.getUserById(QA_OWNER);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
const verified = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const session = verified.data.session;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const frames = [];
await page.exposeFunction("__recordFrame", (entry) => {
  frames.push(entry);
});
await page.addInitScript((value) => {
  localStorage.setItem("sb-127-auth-token", JSON.stringify(value));
  const Original = window.WebSocket;
  // eslint-disable-next-line no-undef
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      const socket = new target(...args);
      socket.addEventListener("message", (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          if (parsed?.type === "command.ack" || parsed?.action) {
            window.__recordFrame({ direction: "in", at: Date.now(), message: parsed });
          }
        } catch { /* binary or non-JSON */ }
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        try {
          const parsed = JSON.parse(String(data));
          if (parsed?.action) window.__recordFrame({ direction: "out", at: Date.now(), message: parsed });
        } catch { /* ignore */ }
        return send(data);
      };
      return socket;
    },
  });
}, session);

await page.goto(`${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
await composer.waitFor({ state: "visible", timeout: 90_000 });
await sleep(6000);

const cardRoot = () =>
  page.locator("div")
    .filter({ hasText: DELETE_TITLE })
    .filter({ has: page.getByRole("button", { name: CONFIRM_LABEL, exact: true }) })
    .last();

const inventory = await page.evaluate((title) => {
  const roots = [...document.querySelectorAll("div")].filter(
    (node) =>
      node.innerText?.includes(title) &&
      [...node.querySelectorAll("button")].some((button) => button.innerText.trim() === "确认删除"),
  );
  // Keep only innermost roots.
  const innermost = roots.filter((node) => !roots.some((other) => other !== node && node.contains(other)));
  return innermost.map((node) => ({
    text: node.innerText.replace(/\n/g, " | ").slice(0, 300),
    confirmButtons: node.querySelectorAll("button").length,
  }));
}, DELETE_TITLE);
console.log("card inventory", JSON.stringify(inventory, null, 2));

const root = cardRoot();
console.log("locator count", await page.locator("div")
  .filter({ hasText: DELETE_TITLE })
  .filter({ has: page.getByRole("button", { name: CONFIRM_LABEL, exact: true }) })
  .count());
const before = await root.innerText();
const marker = Date.now();
console.log("resolved card text BEFORE click:", before.replace(/\n/g, " | "));
await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `trace-before-click-${marker}.png`) });

await root.getByRole("button", { name: CONFIRM_LABEL, exact: true }).first().click({ timeout: 20_000 });
await sleep(12_000);
const after = await root.innerText().catch(() => "<root detached>");
console.log("resolved card text AFTER click:", String(after).replace(/\n/g, " | "));
await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `trace-after-click-${marker}.png`) });

const canvas = await admin.from("canvases").select("content,revision").eq("id", fixture.canvasId).single();
const live = (canvas.data.content?.elements ?? []).filter((element) => !element.isDeleted);
console.log("canvas live ids", live.map((element) => element.id));
console.log("frames:", JSON.stringify(frames.filter((frame) => JSON.stringify(frame.message).includes("confirm")), null, 2));

await writeFile(
  resolve(ARTIFACT_DIR, `trace-confirm-click-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ inventory, before, after, liveIds: live.map((element) => element.id), frames }, null, 2)}\n`,
);
await browser.close();
