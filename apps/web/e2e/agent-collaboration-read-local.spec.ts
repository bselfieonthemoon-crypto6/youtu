import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Read-only review of a previously completed, isolated QA run. No model calls,
// settings writes, project restore, synthetic tool outputs, trace or video.
test.use({ trace: "off", video: "off", viewport: { width: 1440, height: 1400 } });
const supabaseUrl = "http://127.0.0.1:54421";
const api = process.env.LOOMIC_E2E_SERVER_URL ?? "http://127.0.0.1:3002";
const actorId = "541006fa-d2a1-4305-be55-b6263c27a1e3";

test("reviews persisted expert cards, collaboration settings and unconfigured layer backend without mutations", async ({ page, request }, info) => {
  test.skip(process.env.LOOMIC_EXPERT_READ_ONLY !== "true", "Explicit opt-in for local read-only review required");
  test.skip(process.env.SUPABASE_URL !== supabaseUrl, "Local replica only");
  test.setTimeout(120_000);
  expect(new URL(api).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  expect(new URL(process.env.LOOMIC_E2E_BASE_URL ?? "http://localhost:3020").hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  const evidence = JSON.parse(await readFile(path.resolve(process.env.LOOMIC_EXPERT_EVIDENCE ?? "test-results/experts-agent-live/design-task-steering-local-edca9-ent-saves-the-targeted-edit-chromium/actual-expert-collaboration.json"), "utf8"));
  expect(evidence.actualLLM).toBe(true); expect(evidence.simulatedProvider).toBe(false);
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
  const client = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY!, options);
  const account = await admin.auth.admin.getUserById(actorId);
  if (!account.data.user?.email) throw new Error("Local QA account unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  if (link.error) throw new Error("Local QA authentication setup failed");
  const login = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (login.error || !login.data.session) throw new Error("Local QA authentication failed");
  const headers = { Authorization: `Bearer ${login.data.session.access_token}` };
  const blockedMutations: Array<{ method: string; path: string }> = [];
  const agentRunRequests: string[] = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try { const value = JSON.parse(String(payload)); if (value.type === "run.start") agentRunRequests.push("run.start"); } catch { /* transport frame */ }
  }));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    if (new URL(req.url()).origin === new URL(api).origin && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
      blockedMutations.push({ method: req.method(), path: new URL(req.url()).pathname });
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
    key: `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`, session: login.data.session,
  });
  try {
    // agent_runs is private; resolve only this known isolated QA run's session
    // ID with read-only admin access. Do not restore its archived project.
    const run = await admin.from("agent_runs").select("session_id").eq("id", evidence.runId).maybeSingle();
    if (run.error) throw new Error("Persisted QA run lookup failed");
    const beforeSettingsResponse = await request.get(`${api}/api/workspace/settings`, { headers });
    expect(beforeSettingsResponse.ok()).toBe(true);
    const beforeSettings = await beforeSettingsResponse.json();
    const backendResponse = await request.get(`${api}/api/images/layer-backend`, { headers });
    expect(backendResponse.status()).toBe(200);
    const backend = await backendResponse.json();
    expect(backend).toMatchObject({ configured: false, available: false, model: "qwen-image-layered" });
    expect(backend.reason).toContain("未配置");
    expect(Object.keys(backend).sort()).toEqual(["available", "configured", "model", "reason", "remote"]);

    const canvasResponse = await request.get(`${api}/api/canvases/${evidence.canvasId}`, { headers });
    let cardsVerified = false;
    if (canvasResponse.ok() && run.data?.session_id) {
      await page.goto(`/canvas?id=${evidence.canvasId}&session=${run.data.session_id}`);
      const card = page.getByRole("region", { name: "子 Agent 协作" });
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText("当前需求第 1 版");
      await expect(card.locator("details")).toHaveCount(2);
      await card.screenshot({ path: info.outputPath("persisted-expert-card-overview.png") });
      await card.getByText("参考分析", { exact: true }).click();
      await card.locator("details").first().scrollIntoViewIfNeeded();
      await card.locator("details").first().screenshot({ path: info.outputPath("persisted-reference-expert-expanded.png") });
      await card.getByText("参考分析", { exact: true }).click();
      await card.getByText("设计规划", { exact: true }).click();
      await card.locator("details").nth(1).scrollIntoViewIfNeeded();
      await card.locator("details").nth(1).screenshot({ path: info.outputPath("persisted-planning-expert-expanded.png") });
      await card.getByText("参考分析", { exact: true }).click();
      await expect(card.getByRole("region", { name: "子任务产物" })).toHaveCount(2);
      for (const task of evidence.tasks) {
        await expect(card).toContainText(task.model_ref);
        await expect(card).toContainText(task.skills[0].slug);
      }
      await page.reload();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card.locator("details")).toHaveCount(2);
      await expect(card).toContainText("当前需求第 1 版");
      cardsVerified = true;
    }
    // Agent defaults and provider management no longer exist in the user settings page
    // (both are platform-configured), so the read-only check visits the remaining tabs
    // and still proves that opening settings mutates nothing.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: info.outputPath("settings-read-only.png"), fullPage: true });
    const afterSettingsResponse = await request.get(`${api}/api/workspace/settings`, { headers });
    expect(await afterSettingsResponse.json()).toEqual(beforeSettings);
    expect(agentRunRequests).toEqual([]);
    await writeFile(info.outputPath("expert-ui-read-only-evidence.json"), JSON.stringify({
      actualPersistedRun: evidence.runId, canvasId: evidence.canvasId, sessionId: run.data?.session_id ?? null,
      cardsVerified, canvasHttpStatus: canvasResponse.status(), settingsUnchanged: true,
      backend, blockedMutations, agentRunRequests, actualModelCalls: 0,
    }, null, 2));
  } finally {
    await page.goto("about:blank");
    const signedOut = await client.auth.signOut({ scope: "local" });
    expect(signedOut.error).toBeNull();
  }
});
