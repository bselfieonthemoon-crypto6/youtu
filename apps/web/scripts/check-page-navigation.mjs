// Browser probe: does clicking a sidebar link always bring the new page in?
//
// The reported symptom is "I click and nothing happens, the old page stays". This turns
// that into a number. After every click it waits for the URL to change and then compares
// the main content with what was there before, so it separates two different failures:
//
//   CLICK-LOST  the URL never changed  -> the click never reached the link
//   STALLED     the URL changed but the content is byte-identical -> the new page
//               never mounted, which is what a keyed AnimatePresence(mode="wait") does
//               when its exit animation completion never arrives
//
// Read-only: it only navigates. The isolated QA login stays in memory.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.REPRO_BASE_URL ?? "http://localhost:3020";
const ROUNDS = Number(process.env.REPRO_ROUNDS ?? 24);
const SETTLE_MS = Number(process.env.REPRO_SETTLE_MS ?? 900);

assert.match(process.env.SUPABASE_URL ?? "", /127\.0\.0\.1/);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const account = await admin.auth.admin.getUserById("541006fa-d2a1-4305-be55-b6263c27a1e3");
assert(account.data.user?.email, "local QA account unavailable");
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
assert(!link.error, "local QA login link failed");
const login = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
assert(login.data.session && !login.error, `local QA login failed: ${login.error?.message}`);

const pages = [
  { link: "Home", path: "/home" },
  { link: "Projects", path: "/projects" },
  { link: "Brand Kit", path: "/brand-kit" },
  { link: "Skills", path: "/skills" },
  { link: "Settings", path: "/settings" },
  { link: "管理后台", path: "/admin" },
];

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(String(error.message).slice(0, 120)));
  await page.addInitScript(({ session }) => localStorage.setItem("sb-127-auth-token", JSON.stringify(session)),
    { session: login.data.session });

  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const read = async () => ({
    url: new URL(page.url()).pathname,
    text: await page.locator("main").innerText().catch(() => ""),
  });

  let clickLost = 0;
  let stalled = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const before = await read();
    const target = pages.find(entry => entry.path !== before.url) ?? pages[round % pages.length];
    const chosen = pages[round % pages.length];
    const wanted = chosen.path === before.url ? target : chosen;

    await page.getByRole("link", { name: wanted.link, exact: true }).first()
      .click({ timeout: 5000 }).catch(() => {});
    const navigated = await page.waitForURL(url => new URL(url).pathname !== before.url, { timeout: 5000 })
      .then(() => true).catch(() => false);
    await page.waitForTimeout(SETTLE_MS);
    const after = await read();

    if (!navigated) {
      clickLost += 1;
      console.log(`  CLICK-LOST #${round} 「${wanted.link}」url 仍是 ${after.url}`);
    } else if (after.text === before.text) {
      stalled += 1;
      console.log(`  STALLED    #${round} 「${wanted.link}」url=${after.url} 但内容与上一页完全相同`);
    }
  }

  console.log(`\n${ROUNDS} 次点击:CLICK-LOST ${clickLost},STALLED ${stalled},`
    + `失败率 ${(((clickLost + stalled) / ROUNDS) * 100).toFixed(0)}%`);
  if (errors.length) console.log(`页面 JS 错误 ${errors.length} 条,例如:${errors[0]}`);
  process.exitCode = clickLost + stalled > 0 ? 1 : 0;
} finally {
  await browser.close();
}
