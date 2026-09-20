// Diagnostic only: open the canvas page and report exactly what the browser sees.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const REPO_ROOT = "E:/Loomic/Loomic";
const ARTIFACT_DIR = resolve(REPO_ROOT, "artifacts", "delete-confirmation-browser");
const BASE = "http://localhost:3020";
const QA_OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const fixture = JSON.parse(await readFile(resolve(ARTIFACT_DIR, "fixture.json"), "utf8"));

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const account = await admin.auth.admin.getUserById(QA_OWNER);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
const verified = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
const session = verified.data.session;
console.log("login ok, session user", session.user.id);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
page.on("console", (m) => console.log(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e.message).slice(0, 300)}`));
page.on("response", (r) => {
  if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url().slice(0, 200)}`);
});
await page.addInitScript((value) => {
  localStorage.setItem("sb-127-auth-token", JSON.stringify(value));
}, session);
const target = `${BASE}/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`;
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
for (const wait of [5000, 10000, 15000, 20000]) {
  await sleep(5000);
  const body = await page.locator("body").innerText().catch(() => "<none>");
  const composer = await page.getByRole("textbox", { name: "输入消息", exact: true }).count();
  console.log(`\n=== after ${wait}ms url=${page.url()} composer=${composer}`);
  console.log(body.replace(/\s+/g, " ").slice(0, 700));
}
await page.screenshot({ path: resolve(ARTIFACT_DIR, "screenshots", `diag-composer-${Date.now()}.png`) });
console.log("\nstored auth keys:", await page.evaluate(() => Object.keys(localStorage)));
await browser.close();
