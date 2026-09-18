import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { SkillListItem } from "@loomic/shared";
import { writeFile } from "node:fs/promises";

// Local database/HTTP/browser regression only. No model requests or external
// package imports; credentials are excluded from traces, video and evidence.
test.use({ trace: "off", video: "off" });
const supabaseUrl = "http://127.0.0.1:54421";
const api = process.env.LOOMIC_E2E_SERVER_URL ?? "http://127.0.0.1:3002";
const actorId = "541006fa-d2a1-4305-be55-b6263c27a1e3";

test("Skills real CRUD, reference persistence, install state and toggle survive reload", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  test.skip(process.env.SUPABASE_URL !== supabaseUrl, "Local replica only");
  expect(new URL(api).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  expect(new URL(process.env.LOOMIC_E2E_BASE_URL ?? "http://localhost:3020").hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, authOptions);
  const client = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY!, authOptions);
  const account = await admin.auth.admin.getUserById(actorId);
  if (!account.data.user?.email) throw new Error("Local QA account unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  if (link.error) throw new Error("Local QA authentication setup failed");
  const login = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (login.error || !login.data.session) throw new Error("Local QA authentication failed");
  const headers = { Authorization: `Bearer ${login.data.session.access_token}` };
  const suffix = crypto.randomUUID();
  const originalName = `QA Skills CRUD ${suffix}`;
  const editedName = `QA Skills edited ${suffix}`;
  const body = "# QA isolated skill\n\nOnly handle the explicit QA task. Do not call generation models, change other skills or edit any artwork.\n\nRead references/验收 标准.md only when validating the QA output.";
  let skillId: string | undefined;
  let originalSlug: string | undefined;
  const readDetail = async () => {
    const response = await request.get(`${api}/api/skills/${skillId}`, { headers });
    expect(response.ok(), "Read persisted QA skill").toBe(true);
    return (await response.json()).skill;
  };
  const readWorkspace = async () => {
    const response = await request.get(`${api}/api/workspaces/skills`, { headers });
    expect(response.ok(), "Read real workspace installations").toBe(true);
    return (await response.json()).skills as SkillListItem[];
  };
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
    key: `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`, session: login.data.session,
  });
  try {
    await page.goto("/skills");
    await expect(page.getByRole("heading", { name: "技能", exact: true })).toBeVisible({ timeout: 60_000 });
    const baseline = await readWorkspace();
    await expect(page.locator("article[data-skill-id]")).toHaveCount(baseline.length);
    await page.getByRole("button", { name: "添加自定义技能", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称", { exact: true }).fill(originalName);
    await dialog.getByLabel("描述", { exact: true }).fill("Isolated local Skills acceptance fixture; no artwork or provider access.");
    await dialog.getByLabel("SKILL.md 内容", { exact: true }).fill(body);
    await dialog.getByRole("button", { name: "添加文件", exact: true }).click();
    await dialog.getByLabel("文件 1 路径", { exact: true }).fill("references/验收 标准.md");
    await dialog.getByLabel("文件 1 内容", { exact: true }).fill("QA reference revision 1");
    const createResponse = page.waitForResponse((response) => response.url() === `${api}/api/skills` && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "创建并安装", exact: true }).click();
    const created = await createResponse;
    const createPayload = await created.json();
    expect(created.status(), `Create and install atomically: ${createPayload.error?.code ?? ""} ${createPayload.error?.message ?? ""}`).toBe(201);
    const createdSkill = createPayload.skill;
    skillId = createdSkill.id; originalSlug = createdSkill.slug;
    const card = page.locator(`article[data-skill-id="${skillId}"]`);
    await expect(dialog).toBeHidden();
    await expect(card).toContainText(originalName);
    expect((await readWorkspace()).find((skill) => skill.id === skillId)).toMatchObject({ enabled: true, installed: true });
    expect((await readDetail()).files).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: "references/验收 标准.md", content: "QA reference revision 1" })]));

    await card.getByRole("switch").click();
    await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await page.reload();
    await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect((await readWorkspace()).find((skill) => skill.id === skillId)?.enabled).toBe(false);
    await card.getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(dialog).toContainText("已安装 · 已停用");
    await dialog.getByRole("button", { name: "编辑技能", exact: true }).click();
    await dialog.getByLabel("名称", { exact: true }).fill(editedName);
    await dialog.getByLabel("SKILL.md 内容", { exact: true }).fill(`${body}\n\nQA content revision 2`);
    await dialog.getByLabel("文件 1 内容", { exact: true }).fill("QA reference revision 2");
    await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText(editedName);
    await page.reload();
    await expect(card).toContainText(editedName);
    const edited = await readDetail();
    expect(edited.slug, "Renaming cannot change the package import path").toBe(originalSlug);
    expect(edited.skillContent).toContain("QA content revision 2");
    expect(edited.files).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: "references/验收 标准.md", content: "QA reference revision 2" })]));
    await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await card.getByRole("switch").click();
    await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "true");

    await card.getByRole("button", { name: "查看详情", exact: true }).click();
    await dialog.getByRole("button", { name: "卸载技能", exact: true }).click();
    await expect(dialog).toContainText("未安装");
    expect((await readWorkspace()).some((skill) => skill.id === skillId)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await page.getByRole("tab", { name: "技能目录", exact: true }).click();
    await expect(card).toContainText("未安装");
    await card.getByRole("button", { name: "安装", exact: true }).click();
    await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(card).toContainText("已安装");
    await card.getByRole("button", { name: "查看详情", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑技能", exact: true }).click();
    await dialog.getByRole("button", { name: "删除文件 1", exact: true }).click();
    await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await readDetail()).files).toEqual([]);
    await card.getByRole("button", { name: "查看详情", exact: true }).click();
    await dialog.getByRole("button", { name: "删除技能", exact: true }).click();
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toHaveCount(0);
    const deleted = await request.get(`${api}/api/skills/${skillId}`, { headers });
    expect(deleted.status()).toBe(404);
    const after = await readWorkspace();
    expect(after).toEqual(baseline);
    await page.getByRole("heading", { name: "技能", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("skills-real-crud-complete.png"), fullPage: true });
    const builtin = after.filter((skill) => skill.source === "system" && skill.metadata.bundle === "loomic-design-skills-v2");
    const readiness = Object.fromEntries(["ready", "limited", "unavailable", "unknown"].map((status) => [status, builtin.filter((skill) => (skill.readiness?.status ?? "unknown") === status).length]));
    const backgroundSkill = builtin.find((skill) => skill.slug === "background-removal");
    expect(backgroundSkill, "Background-removal package must be installed").toBeDefined();
    expect(backgroundSkill!.readiness?.models.find((model) => model.role === "image")?.upstreamModelId).toBe("gpt-image-2");
    await page.locator(`article[data-skill-id="${backgroundSkill!.id}"]`).getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(dialog.locator('section[aria-label="当前匹配模型"]')).toContainText("gpt-image-2");
    await page.screenshot({ path: info.outputPath("background-removal-model-details.png") });
    const evidence = { localOnly: true, modelCalls: 0,
      qaSkillId: skillId, stableSlug: originalSlug, created: true, referenceRoundtrip: true, disabledAfterReload: true,
      editPersisted: true, uninstallThenInstall: true, removedReferences: true, deleted: true,
      baselineInstallationsUnchanged: true, installedCount: baseline.length,
      builtinCount: builtin.length, readiness, backgroundModelMatches: backgroundSkill!.readiness?.models };
    const evidencePath = info.outputPath("skills-crud-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await info.attach("skills-crud-evidence", { path: evidencePath, contentType: "application/json" });
  } finally {
    // Delete only this exact generated QA skill; never reset workspace installs.
    if (skillId) await request.delete(`${api}/api/skills/${skillId}`, { headers });
    else {
      const response = await request.get(`${api}/api/skills`, { headers });
      if (response.ok()) {
        const skills = (await response.json()).skills as Array<{ id: string; name: string }>;
        for (const skill of skills.filter((entry) => entry.name === originalName || entry.name === editedName)) {
          await request.delete(`${api}/api/skills/${skill.id}`, { headers });
        }
      }
    }
    await client.auth.signOut({ scope: "local" });
  }
});
