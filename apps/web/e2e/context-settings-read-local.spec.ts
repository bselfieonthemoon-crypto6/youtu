import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Local read-only product verification. No model request, provider write or
// saved capacity changes; authentication credentials never enter test output.
test.use({ trace: "off", video: "off", viewport: { width: 1440, height: 1000 } });
test("exposes actual context controls without inventing model capacity or changing settings", async ({ page, request }, info) => {
  test.skip(process.env.LOOMIC_CONTEXT_READ_ONLY !== "true", "Explicit local read-only opt-in required");
  const supabaseUrl = "http://127.0.0.1:54421";
  test.skip(process.env.SUPABASE_URL !== supabaseUrl, "Local replica only");
  const api = process.env.LOOMIC_E2E_SERVER_URL ?? "http://127.0.0.1:3002";
  expect(new URL(api).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(new URL(process.env.LOOMIC_E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const auth = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, auth);
  const client = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY!, auth);
  const account = await admin.auth.admin.getUserById("541006fa-d2a1-4305-be55-b6263c27a1e3");
  if (!account.data.user?.email) throw new Error("Local QA account unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  if (link.error) throw new Error("Local QA authentication setup failed");
  const login = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (login.error || !login.data.session) throw new Error("Local QA authentication failed");
  const headers = { Authorization: `Bearer ${login.data.session.access_token}` };
  const mutations: string[] = [], modelRuns: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
    try { if (JSON.parse(String(payload)).type === "run.start") modelRuns.push("run.start"); } catch { /* transport */ }
  }));
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      mutations.push(route.request().method() + " " + new URL(route.request().url()).pathname);
      await route.abort();
    } else await route.continue();
  });
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
    key: "sb-127-auth-token", session: login.data.session,
  });
  try {
    // Catch request failures here: Playwright's default transport error prints
    // request headers, which would expose this short-lived test credential.
    const readProviders = () => request.get(`${api}/api/workspace/provider-configs`, { headers })
      .catch(() => { throw new Error("Local provider API request failed (details redacted)"); });
    const before = await readProviders();
    expect(before.ok()).toBe(true);
    const providers = await before.json();
    await page.goto("/settings?tab=providers");
    await expect(page.getByRole("heading", { name: "模型供应商", exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "编辑", exact: true }).first().click();
    await page.getByLabel("筛选模型类型").selectOption("text");
    const details = page.locator("details").filter({ hasText: "上下文容量：" }).first();
    await expect(details).toContainText("未验证 · 使用保守运行预算");
    await details.locator("summary").click();
    await expect(details.getByLabel("总上下文窗口 tokens")).toHaveValue("");
    await expect(details.getByLabel("输入上限 tokens")).toHaveValue("");
    await expect(details.getByLabel("输出上限 tokens")).toHaveValue("");
    await details.scrollIntoViewIfNeeded();
    await details.screenshot({ path: info.outputPath("context-capacity-controls.png") });
    const after = await readProviders();
    expect(await after.json()).toEqual(providers);
    expect(mutations).toEqual([]); expect(modelRuns).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await client.auth.signOut({ scope: "local" });
  }
});
