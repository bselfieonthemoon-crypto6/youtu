import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { designGetResponseSchema, type DesignCommand, type DesignDocumentDto, type DesignObject } from "@loomic/shared";

// This suite creates fresh QA projects only. Traces can contain authentication
// frames, so retain screenshots and an explicitly sanitized result report.
test.use({ trace: "off", video: "off" });

const localSupabase = "http://127.0.0.1:54421";
const api = process.env.LOOMIC_E2E_SERVER_URL ?? "http://127.0.0.1:3002";
const actorId = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const originalTitle = "SUMMER PREVIEW";
const finalTitle = "AUTUMN STUDIO";

test.beforeEach(() => {
  test.skip(process.env.SUPABASE_URL !== localSupabase, "Local replica only");
  expect(new URL(api).hostname, "QA API must be loopback").toMatch(/^(127\.0\.0\.1|localhost)$/);
  expect(new URL(process.env.LOOMIC_E2E_BASE_URL ?? "http://localhost:3000").hostname, "QA browser must be loopback").toMatch(/^(127\.0\.0\.1|localhost)$/);
});

test("local fixture raster guard detects dark ink touching any artboard edge", async ({ page }) => {
  // Browser-only pixel-math check: no login, fixture project, agent or provider.
  await page.setContent('<div data-testid="ink-raster"><img alt="QA raster"></div>');
  const preview = page.getByTestId("ink-raster");
  const samples = [
    { x: 20, y: 20, edge: null }, { x: 0, y: 20, edge: "left" },
    { x: 610, y: 20, edge: "right" }, { x: 20, y: 0, edge: "top" },
    { x: 20, y: 330, edge: "bottom" },
  ] as const;
  for (const sample of samples) {
    await preview.locator("img").evaluate(async (image: HTMLImageElement, point) => {
      const surface = document.createElement("canvas");
      surface.width = 640; surface.height = 360;
      const context = surface.getContext("2d")!;
      context.fillStyle = "#dbeafe"; context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#172554"; context.fillRect(point.x, point.y, 30, 30);
      image.src = surface.toDataURL();
      await image.decode();
    }, sample);
    const ink = await previewInkMargins(preview);
    expect(ink.inkPixels).toBe(900);
    if (sample.edge) expect(ink.margins[sample.edge]).toBe(0);
    else for (const margin of Object.values(ink.margins)) expect(margin).toBeGreaterThanOrEqual(8);
  }
});

test("stale design mutation cannot overwrite a saved targeted edit or its preview", async ({ page, request }, info) => {
  test.setTimeout(150_000);
  const fixture = await createFixture(page, request, info);
  try {
    await fixture.open();
    const before = await fixture.readDesign();
    const beforePreview = await previewPixels(fixture.preview);
    const title = before.scene.objects.find((object) => object.objectId === fixture.titleId)!;
    const change = updateTitle(title, finalTitle);
    await fixture.mutate(before.revision, [change]);
    const committed = await fixture.readDesign();

    // A different request with an old document revision must conflict even
    // though it knows a valid object ID. This is real server CAS, not a mock.
    const stale = await request.post(`${api}/api/designs/${fixture.designId}/mutations`, {
      headers: fixture.headers,
      data: {
        design_id: fixture.designId,
        expected_revision: before.revision,
        idempotency_key: crypto.randomUUID(),
        commands: [updateTitle(title, "STALE RESULT MUST NOT LAND")],
      },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe("DESIGN_CONFLICT");
    const after = await fixture.readDesign();
    expect(after.revision).toBe(committed.revision);
    expect(after.scene).toEqual(committed.scene);
    assertUntouched(before, after, fixture.titleId);
    expect((await fixture.readOtherDesign()).scene).toEqual(fixture.otherBefore.scene);
    // Direct mutation APIs intentionally leave preview scheduling to callers.
    await fixture.queuePreview(after);
    await verifySavedPreview(fixture, beforePreview);
    await page.screenshot({ path: info.outputPath("stale-result-rejected.png") });
  } finally {
    await fixture.signOut();
  }
});

test("real LLM accepts a named-layer correction on the active artboard and preserves other layers", async ({ page, request }, info) => {
  // This case uses the configured workspace text model and can incur text-model
  // charges. It never requests image/video generation and is never enabled by
  // the default suite. No intercepted model responses or synthesized run events.
  test.skip(process.env.LOOMIC_DESIGN_TASK_LIVE !== "true", "Explicit opt-in for actual LLM acceptance required");
  test.setTimeout(240_000);
  const fixture = await createFixture(page, request, info);
  const traffic = observeAgentTraffic(page);
  try {
    await fixture.open();
    const before = await fixture.readDesign();
    const beforePreview = await previewPixels(fixture.preview);
    await fixture.preview.dblclick({ force: true });
    const editor = page.getByTestId("design-inline-editor");
    await expect(editor).toBeVisible();
    await expect(editor.locator("canvas").first()).toBeVisible();
    await editor.getByRole("button", { name: "图层 / 属性", exact: true }).click();
    await editor.getByRole("button", { name: "选择图层：QA editable title", exact: true }).click();

    const initial = "把当前画板中名称为 QA editable title 的标题文字改成 SPRING STUDIO，只改这一个文字对象的内容。保留位置、尺寸、字体、颜色、背景和其他图层，不要生成图片。";
    const correction = `更正：同一个标题最终改成 ${finalTitle}。其他要求继续保留，只修改文字内容，立即执行。`;
    await sendMessage(page, initial);
    await expect.poll(() => traffic.acks.length).toBe(1);
    const firstRun = traffic.acks[0]!;
    const firstRequest = traffic.requests[0]!;
    expect(firstRequest.designTask?.target).toMatchObject({
      kind: "design", designId: fixture.designId,
    });
    expect(traffic.isTerminal(firstRun), "Correction must be sent while the original run is still active").toBe(false);

    // This goes through the real running composer; no synthetic websocket send.
    await sendMessage(page, correction);
    await expect.poll(() => traffic.acks.length).toBe(2);
    const correctionRun = traffic.acks[1]!;
    expect(correctionRun).not.toBe(firstRun);
    expect(traffic.requests[1]?.designTask?.correctionOfRunId).toBe(firstRun);
    const sessionId = firstRequest.sessionId;
    expect(sessionId).toBeTruthy();
    const readTask = async () => {
      const response = await request.get(`${api}/api/chat/sessions/${sessionId}/design-task`, { headers: fixture.headers });
      expect(response.ok(), "Persisted design-task endpoint").toBe(true);
      return (await response.json()).task;
    };
    await expect.poll(async () => (await readTask())?.runId, { timeout: 30_000 }).toBe(correctionRun);
    const task = await readTask();
    expect(task.revision).toBeGreaterThanOrEqual(2);
    expect(task.canvasId).toBe(fixture.canvasId);
    expect(task.goal).toBe(initial);
    expect(task.corrections).toContain(correction);
    expect(task.target).toMatchObject({ kind: "design", designId: fixture.designId });
    await expect(page.getByRole("region", { name: "当前需求" })).toContainText(correction);

    await expect.poll(() => traffic.isTerminal(correctionRun), { timeout: 150_000 }).toBe(true);
    expect(traffic.events.find((event) => event.runId === correctionRun && event.type === "run.failed")).toBeUndefined();
    const correctionEvents = traffic.events.filter((event) => event.runId === correctionRun);
    const briefIndex = correctionEvents.findIndex((event) => event.type === "tool.completed" && event.toolName === "update_design_brief" && event.outputStatus === "ready");
    const mutationIndex = correctionEvents.findIndex((event) => event.type === "tool.started" && event.toolName === "manipulate_design");
    expect(briefIndex, "The actual model must record current requirements before editing").toBeGreaterThanOrEqual(0);
    expect(mutationIndex).toBeGreaterThan(briefIndex);
    expect(correctionEvents.some((event) => event.type === "tool.completed" && event.toolName === "manipulate_design")).toBe(true);
    const verification = correctionEvents.find((event) => event.type === "tool.completed" && event.toolName === "verify_design_result" && event.outputStatus === "saved_and_preview_synced");
    expect(verification, "The actual model must verify the authoritative saved result").toBeDefined();
    expect(verification?.previewReady).toBe(true);
    expect(verification?.previewRevision).toBe(verification?.revision);
    await expect(page.getByRole("heading", { name: /^(确认设计方案|确认修改设计)$/ })).toHaveCount(0);
    await expect.poll(async () => titleText(await fixture.readDesign(), fixture.titleId)).toBe(finalTitle);
    const after = await fixture.readDesign();
    expect(verification?.revision).toBe(after.revision);
    expect((await readTask()).brief?.verification?.revision).toBe(after.revision);
    assertUntouched(before, after, fixture.titleId);
    expect((await fixture.readOtherDesign()).scene).toEqual(fixture.otherBefore.scene);

    // Leaving the editor must not flush an old client scene over the agent edit.
    await editor.getByRole("button", { name: "完成", exact: true }).click();
    const saveAndExit = page.getByText("保存并退出", { exact: true });
    if (await saveAndExit.isVisible()) await saveAndExit.click();
    await expect(editor).toBeHidden({ timeout: 60_000 });
    await verifySavedPreview(fixture, beforePreview);
    expect((await readTask()).corrections).toContain(correction);
    await expect(page.getByRole("region", { name: "当前需求" })).toContainText(correction);
    assertUntouched(before, await fixture.readDesign(), fixture.titleId);
    expect((await fixture.readOtherDesign()).scene).toEqual(fixture.otherBefore.scene);
    const { data: jobs, error } = await fixture.client.from("background_jobs").select("id").eq("canvas_id", fixture.canvasId).in("job_type", ["image_generation", "video_generation"]);
    expect(error).toBeNull();
    expect(jobs, "A text-only correction must not submit paid media jobs").toEqual([]);
    await saveEvidence(info, "actual-llm-steering-evidence", {
        actualLLM: true, simulatedProvider: false, canvasId: fixture.canvasId,
        designId: fixture.designId, sessionId, firstRun, correctionRun,
        taskRevision: task.revision, savedRevision: (await fixture.readDesign()).revision,
        target: task.target, finalTitle,
        tools: correctionEvents.filter((event) => event.type === "tool.completed").map((event) => event.toolName),
        verification,
    });
    await page.screenshot({ path: info.outputPath("actual-llm-correction-saved.png") });
  } finally {
    await fixture.signOut();
  }
});

test("real LLM autonomously selects an enabled design skill for professional typography", async ({ page, request }, info) => {
  test.skip(process.env.LOOMIC_DESIGN_SKILL_LIVE !== "true", "Explicit opt-in for actual skill-selection acceptance required");
  test.setTimeout(240_000);
  const fixture = await createFixture(page, request, info);
  const traffic = observeAgentTraffic(page);
  try {
    await fixture.open();
    const before = await fixture.readDesign();
    const { data: installed, error } = await fixture.client.from("workspace_skills")
      .select("skill:skills(slug)").eq("workspace_id", before.workspace_id).eq("enabled", true);
    expect(error).toBeNull();
    const enabledSkillPaths = (installed ?? []).flatMap((entry: any) => entry.skill?.slug
      ? [`/workspace-skills/${entry.skill.slug}/SKILL.md`] : []);
    expect(enabledSkillPaths).toContain("/workspace-skills/typography-layout/SKILL.md");
    const beforePreview = await previewPixels(fixture.preview);
    await fixture.preview.dblclick({ force: true });
    const editor = page.getByTestId("design-inline-editor");
    await expect(editor).toBeVisible();
    await expect(editor.locator("canvas").first()).toBeVisible();
    const prompt = "请把当前画板的两行文字重新组织成专业设计工作室的夏季作品预告卡。现在主次关系与留白比较生硬，请自主确定清晰的阅读顺序、标题和副标题的字号比例、字重、对齐与位置，做出一版克制但有张力的可编辑版式，并说明关键取舍。两段英文必须逐字保留，沿用现有 Arial 字体与文字颜色，保持蓝色背景、640×360 尺寸和另一个画板不变；只调整现有两个文字对象的排版，不新增或删除对象，不生成图片或视频。需求已完整，请直接完成一版并检查实际保存和预览结果。";
    await sendMessage(page, prompt);
    await expect.poll(() => traffic.acks.length).toBe(1);
    const runId = traffic.acks[0]!;
    expect(traffic.requests[0]?.designTask?.target).toMatchObject({ kind: "design", designId: fixture.designId });
    expect(traffic.requests[0]?.skillMentions, "The browser request must not explicitly select a skill").toEqual([]);
    await expect.poll(() => traffic.isTerminal(runId), { timeout: 180_000 }).toBe(true);
    const runEvents = traffic.events.filter((event) => event.runId === runId);
    // Preserve a sanitized trace even when the behavioral assertions fail.
    // Never retain raw websocket frames, credentials or full skill contents.
    await saveEvidence(info, "actual-autonomous-tool-sequence", {
      actualLLM: true, simulatedProvider: false, canvasId: fixture.canvasId,
      designId: fixture.designId, runId, explicitSkillMentions: traffic.requests[0]?.skillMentions,
      enabledSkillPaths, events: runEvents.filter((event) => event.type === "tool.completed" || event.type === "tool.failed"),
    });
    expect(runEvents.some((event) => event.type === "run.failed")).toBe(false);
    const successfulReads = runEvents.filter((event) => event.type === "tool.completed" && ["read_file", "use_skill"].includes(event.toolName ?? "")
      && event.inputPath && enabledSkillPaths.includes(event.inputPath)
      && (event.skillReadCharacters ?? 0) > 100 && !event.skillReadFailed);
    expect(successfulReads.length, "The real model must independently read an enabled professional guide").toBeGreaterThan(0);
    const briefIndex = runEvents.findIndex((event) => event.type === "tool.completed" && event.toolName === "update_design_brief" && event.outputStatus === "ready");
    const mutationIndex = runEvents.findIndex((event) => event.type === "tool.completed" && event.toolName === "manipulate_design" && event.outputStatus === "applied");
    const skillIndex = runEvents.findIndex((event) => event === successfulReads[0]);
    expect(briefIndex).toBeGreaterThanOrEqual(0);
    expect(mutationIndex).toBeGreaterThan(briefIndex);
    expect(mutationIndex, "The guide must inform the actual mutation").toBeGreaterThan(skillIndex);
    const verification = runEvents.filter((event) => event.type === "tool.completed" && event.toolName === "verify_design_result" && event.outputStatus === "saved_and_preview_synced").at(-1);
    expect(verification).toBeDefined();
    expect(verification?.previewReady).toBe(true);
    expect(verification?.contentChanged, "Independent verification must confirm a real scene change, not only a new revision").toBe(true);
    expect(verification?.visualBlockingIssues, "The rendered design must have no objective visual blockers").toEqual([]);
    expect(verification?.visualError).toBeNull();
    expect(verification?.visualReview?.trim().length, "An actual rendered-pixel review is required for layout work").toBeGreaterThan(0);
    const after = await fixture.readDesign();
    expect(verification?.revision).toBe(after.revision);
    const taskResponse = await request.get(`${api}/api/chat/sessions/${traffic.requests[0]!.sessionId}/design-task`, { headers: fixture.headers });
    expect(taskResponse.ok()).toBe(true);
    expect((await taskResponse.json()).task?.brief?.verification).toMatchObject({ contentChanged: true, revision: after.revision,
      previewRevision: after.revision, visualBlockingIssues: [], visualError: null, visualReview: verification?.visualReview });
    expect(after.scene.canvas).toEqual(before.scene.canvas);
    expect(after.scene.objects.map((object) => object.objectId)).toEqual(before.scene.objects.map((object) => object.objectId));
    const texts = (document: DesignDocumentDto) => document.scene.objects.filter((object) => object.type === "text" || object.type === "textbox");
    expect(texts(after).map((object) => ({ id: object.objectId, text: object.text, fontFamily: object.fontFamily, fill: object.fill })))
      .toEqual(texts(before).map((object) => ({ id: object.objectId, text: object.text, fontFamily: object.fontFamily, fill: object.fill })));
    const layout = (document: DesignDocumentDto) => texts(document).map((object) => ({
      id: object.objectId, x: object.x, y: object.y, fontSize: object.fontSize, fontWeight: object.fontWeight, textAlign: object.textAlign,
    }));
    expect(layout(after), "There must be an actual typographic/layout change").not.toEqual(layout(before));
    expect(after.scene.objects.filter((object) => object.type !== "text" && object.type !== "textbox"))
      .toEqual(before.scene.objects.filter((object) => object.type !== "text" && object.type !== "textbox"));
    expect((await fixture.readOtherDesign()).scene).toEqual(fixture.otherBefore.scene);
    await editor.getByRole("button", { name: "完成", exact: true }).click();
    const saveAndExit = page.getByText("保存并退出", { exact: true });
    if (await saveAndExit.isVisible()) await saveAndExit.click();
    await expect(editor).toBeHidden({ timeout: 60_000 });
    await verifySavedPreview(fixture, beforePreview, originalTitle);
    // This fixture contains only a pale blue background and two dark text
    // objects. Inspect actual raster glyphs, not object.width (text may overflow).
    const ink = await previewInkMargins(fixture.preview);
    expect(ink.inkPixels, "The actual preview must contain visible text").toBeGreaterThan(100);
    for (const [edge, margin] of Object.entries(ink.margins))
      expect(margin, `Rendered text must clear the ${edge} artboard edge by at least 8 design pixels`).toBeGreaterThanOrEqual(8);
    const { data: jobs, error: jobError } = await fixture.client.from("background_jobs").select("id").eq("canvas_id", fixture.canvasId).in("job_type", ["image_generation", "video_generation"]);
    expect(jobError).toBeNull();
    expect(jobs).toEqual([]);
    await saveEvidence(info, "actual-autonomous-skill-evidence", {
      actualLLM: true, explicitSkillMention: false, simulatedProvider: false, canvasId: fixture.canvasId,
      designId: fixture.designId, runId, sessionId: traffic.requests[0]?.sessionId,
      enabledSkillPaths, selectedSkillPaths: successfulReads.map((event) => event.inputPath),
      skillReads: successfulReads.map((event) => ({ tool: event.toolName, path: event.inputPath, characters: event.skillReadCharacters, version: event.skillVersion, hash: event.skillHash })),
      tools: runEvents.filter((event) => event.type === "tool.completed").map((event) => event.toolName),
      beforeLayout: layout(before), afterLayout: layout(after), verification, renderedInk: ink,
    });
    await page.screenshot({ path: info.outputPath("actual-autonomous-typography.png") });
  } finally {
    await fixture.signOut();
  }
});

test("real LLM coordinates parallel read-only experts and the main agent saves the targeted edit", async ({ page, request }, info) => {
  test.skip(process.env.LOOMIC_DESIGN_EXPERT_LIVE !== "true", "Explicit opt-in for actual expert model calls required");
  test.setTimeout(300_000);
  const fixture = await createFixture(page, request, info);
  const traffic = observeAgentTraffic(page);
  try {
    await fixture.open();
    const before = await fixture.readDesign();
    const beforePreview = await previewPixels(fixture.preview);
    await fixture.preview.dblclick({ force: true });
    const editor = page.getByTestId("design-inline-editor");
    await expect(editor).toBeVisible();
    await sendMessage(page, `请先并行让参考分析和设计规划两个专家，分别核对当前画板已有内容和本次修改的保留项，只需要简短结论。然后由你修改标题：把 ${originalTitle} 改为 ${finalTitle}。只改这一个文本内容，字体、字号、位置、颜色、副标题、背景、画板尺寸和另一个画板全部不变，不新增或删除对象，不生成图片或视频。专家只分析，最后由你实际修改并检查保存和预览，直接完成。`);
    await expect.poll(() => traffic.acks.length).toBe(1);
    const runId = traffic.acks[0]!;
    await expect.poll(() => traffic.isTerminal(runId), { timeout: 240_000 }).toBe(true);
    const runEvents = traffic.events.filter(event => event.runId === runId);
    const query = await fixture.client.from("agent_delegations" as any).select("id,run_id,task_revision,role,status,model_ref,instruction,result,created_at,completed_at,skills").eq("run_id", runId);
    expect(query.error).toBeNull();
    const tasks = (query.data ?? []) as any[];
    await saveEvidence(info, "actual-expert-collaboration", { actualLLM: true, simulatedProvider: false, runId,
      canvasId: fixture.canvasId, designId: fixture.designId, tasks,
      events: runEvents.filter(event => event.type === "tool.completed" || event.type === "tool.failed") });
    expect(runEvents.some(event => event.type === "run.failed")).toBe(false);
    const initial = tasks.filter(task => ["reference_analysis", "design_planning"].includes(task.role));
    expect(new Set(initial.map(task => task.role)).size, "Both real specialist roles must execute").toBe(2);
    expect(initial.every(task => task.status === "completed" && task.result?.trim())).toBe(true);
    const starts = initial.map(task => Date.parse(task.created_at));
    const ends = initial.map(task => Date.parse(task.completed_at));
    expect(Math.max(...starts), "Real database timestamps must demonstrate overlapping execution").toBeLessThan(Math.min(...ends));
    expect(runEvents.some(event => event.type === "tool.completed" && event.toolName === "delegate_design_tasks")).toBe(true);
    expect(runEvents.some(event => event.type === "tool.completed" && event.toolName === "manipulate_design" && event.outputStatus === "applied")).toBe(true);
    await expect.poll(async () => titleText(await fixture.readDesign(), fixture.titleId)).toBe(finalTitle);
    assertUntouched(before, await fixture.readDesign(), fixture.titleId);
    expect((await fixture.readOtherDesign()).scene).toEqual(fixture.otherBefore.scene);
    await editor.getByRole("button", { name: "完成", exact: true }).click();
    const saveAndExit = page.getByText("保存并退出", { exact: true });
    if (await saveAndExit.isVisible()) await saveAndExit.click();
    await expect(editor).toBeHidden({ timeout: 60_000 });
    await verifySavedPreview(fixture, beforePreview);
    await expect(page.getByText("参考分析", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("设计规划", { exact: true }).first()).toBeVisible();
    const jobs = await fixture.client.from("background_jobs").select("id").eq("canvas_id", fixture.canvasId);
    expect(jobs.error).toBeNull(); expect(jobs.data).toEqual([]);
    await page.screenshot({ path: info.outputPath("actual-experts-saved-reloaded.png") });
  } finally { await fixture.signOut(); }
});

async function createFixture(page: Page, request: APIRequestContext, info: TestInfo) {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(localSupabase, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
  const client = createClient(localSupabase, process.env.SUPABASE_ANON_KEY!, options);
  const account = await admin.auth.admin.getUserById(actorId);
  if (!account.data.user?.email) throw new Error("Local QA actor is unavailable");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  if (link.error) throw new Error("Could not establish local QA login");
  const login = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (login.error || !login.data.session) throw new Error(`Local QA authentication failed (${login.error?.code ?? "no_session"})`);
  const headers = { Authorization: `Bearer ${login.data.session.access_token}` };
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await request.post(`${api}/api/projects`, { headers, data: {
    name: `QA design steering ${suffix}`, description: "Isolated local acceptance fixture; safe to remove after review",
  } });
  expect(created.ok(), "Create isolated QA project").toBe(true);
  const project = (await created.json()).project;
  const canvasId: string = project.primaryCanvas.id;
  const createDesign = async (name: string, x: number) => {
    const canvasResponse = await request.get(`${api}/api/canvases/${canvasId}`, { headers });
    expect(canvasResponse.ok()).toBe(true);
    const { canvas } = await canvasResponse.json();
    const response = await request.post(`${api}/api/designs`, { headers, data: {
      request_id: crypto.randomUUID(), canvas_id: canvasId, expected_canvas_revision: canvas.revision,
      canvas_element_id: crypto.randomUUID(), name, width: 640, height: 360,
      background: "#ffffff", node: { x, y: 120, width: 640, height: 360 },
    } });
    expect(response.ok(), "Create authored QA artboard").toBe(true);
    return (await response.json()).design_id as string;
  };
  const designId = await createDesign("QA selected artboard", 80);
  const otherDesignId = await createDesign("QA untouched artboard", 800);
  const read = async (id: string): Promise<DesignDocumentDto> => {
    const response = await request.get(`${api}/api/designs/${id}`, { headers });
    expect(response.ok(), "Read authoritative design").toBe(true);
    return designGetResponseSchema.parse(await response.json()).design;
  };
  const mutate = async (revision: number, commands: DesignCommand[], id = designId) => {
    const response = await request.post(`${api}/api/designs/${id}/mutations`, { headers, data: {
      design_id: id, expected_revision: revision, idempotency_key: crypto.randomUUID(), commands,
    } });
    expect(response.ok(), "Apply QA design command").toBe(true);
  };
  const titleId = crypto.randomUUID();
  const background: DesignObject = {
    objectId: crypto.randomUUID(), objectVersion: 1, type: "rect", name: "QA protected background",
    role: "background", x: 0, y: 0, width: 640, height: 360, rotation: 0,
    opacity: 1, visible: true, locked: true, zIndex: 0,
    fill: { kind: "solid", color: "#dbeafe" }, stroke: null, strokeWidth: 0,
  };
  await mutate((await read(designId)).revision, [
    { action: "object.add", object: background },
    { action: "object.add", object: textObject(titleId, originalTitle, 1, 80, "QA editable title") },
    { action: "object.add", object: textObject(crypto.randomUUID(), "KEEP THIS SUBTITLE", 2, 220, "QA protected subtitle") },
  ]);
  await mutate((await read(otherDesignId)).revision, [
    { action: "object.add", object: textObject(crypto.randomUUID(), "OTHER ARTBOARD UNCHANGED", 0, 80, "QA other title") },
  ], otherDesignId);
  const otherBefore = await read(otherDesignId);
  const queuePreview = async (document: DesignDocumentDto) => {
    const response = await request.post(`${api}/api/designs/${document.id}/preview`, { headers, data: {
      design_id: document.id, expected_revision: document.revision, idempotency_key: crypto.randomUUID(),
    } });
    expect(response.ok(), "Queue local renderer preview").toBe(true);
  };
  await queuePreview(await read(designId));
  await queuePreview(otherBefore);
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
    key: `sb-${new URL(localSupabase).hostname.split(".")[0]}-auth-token`, session: login.data.session,
  });
  const preview = page.locator(`[data-testid="design-node-preview"][data-design-id="${designId}"]`);
  await saveEvidence(info, "isolated-qa-fixture", { projectId: project.id, canvasId, designId, otherDesignId, titleId });
  return {
    page, request, client, headers, canvasId, designId, titleId, preview, otherBefore, mutate, queuePreview,
    readDesign: () => read(designId), readOtherDesign: () => read(otherDesignId),
    signOut: async () => {
      if (process.env.LOOMIC_CLEANUP_SKILL_QA === "true") {
        await page.goto("about:blank");
        const removed = await request.delete(`${api}/api/projects/${project.id}`, { headers });
        expect(removed.ok(), "Delete only this run's isolated QA project").toBe(true);
        await saveEvidence(info, "isolated-qa-cleanup", { projectId: project.id, deleted: true });
      }
      await client.auth.signOut({ scope: "local" });
    },
    open: async () => {
      await page.goto(`/canvas?id=${canvasId}`);
      await expect(preview).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => previewPixels(preview), { timeout: 60_000 }).not.toBe("");
    },
  };
}

function textObject(objectId: string, text: string, zIndex: number, y: number, name: string): DesignObject {
  return {
    objectId, objectVersion: 1, type: "text", name, role: zIndex === 2 ? "subtitle" : "title",
    x: 40, y, width: 560, height: 70, rotation: 0, opacity: 1, visible: true, locked: false, zIndex,
    text, fontFaceId: null, fontFamily: "Arial", fontSize: zIndex === 2 ? 22 : 38,
    fontWeight: 700, fontStyle: "normal", textAlign: "left", lineHeight: 1.2, charSpacing: 0,
    fill: { kind: "solid", color: "#172554" },
  };
}

function updateTitle(object: DesignObject, text: string): DesignCommand {
  return { action: "object.update", object_id: object.objectId, expected_object_version: object.objectVersion, patch: { object_type: "text", text } };
}

function titleText(design: DesignDocumentDto, titleId: string) {
  const title = design.scene.objects.find((object) => object.objectId === titleId);
  return title?.type === "text" || title?.type === "textbox" ? title.text : undefined;
}

function assertUntouched(before: DesignDocumentDto, after: DesignDocumentDto, titleId: string) {
  expect(after.scene.canvas).toEqual(before.scene.canvas);
  expect(after.scene.objects.map((object) => object.objectId)).toEqual(before.scene.objects.map((object) => object.objectId));
  expect(after.scene.objects.filter((object) => object.objectId !== titleId)).toEqual(before.scene.objects.filter((object) => object.objectId !== titleId));
  const stripAllowed = (object: DesignObject) => {
    const { objectVersion: _version, ...rest } = object;
    if (rest.type === "text" || rest.type === "textbox") {
      const { text: _text, ...properties } = rest;
      return properties;
    }
    return rest;
  };
  expect(stripAllowed(after.scene.objects.find((object) => object.objectId === titleId)!)).toEqual(stripAllowed(before.scene.objects.find((object) => object.objectId === titleId)!));
}

async function previewPixels(preview: ReturnType<Page["locator"]>) {
  if (await preview.locator("img").count() !== 1) return "";
  return preview.locator("img").evaluate((image: HTMLImageElement) => {
    if (!image.complete || !image.naturalWidth) return "";
    const surface = document.createElement("canvas");
    surface.width = image.naturalWidth; surface.height = image.naturalHeight;
    surface.getContext("2d")!.drawImage(image, 0, 0);
    return surface.toDataURL();
  });
}

async function previewInkMargins(preview: ReturnType<Page["locator"]>) {
  return preview.locator("img").evaluate((image: HTMLImageElement) => {
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error("Preview pixels are not loaded");
    const surface = document.createElement("canvas");
    const width = surface.width = image.naturalWidth;
    const height = surface.height = image.naturalHeight;
    const context = surface.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1, inkPixels = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      // Covers navy text and its antialiasing, excludes the fixture's #dbeafe
      // background. This is deliberately not a generic image quality metric.
      if (pixels[index + 3]! > 128 && pixels[index]! < 110 && pixels[index + 1]! < 150 && pixels[index + 2]! < 190) {
        inkPixels++; minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return { width, height, inkPixels, margins: {
      left: minX * 640 / width, right: (width - 1 - maxX) * 640 / width,
      top: minY * 360 / height, bottom: (height - 1 - maxY) * 360 / height,
    } };
  });
}

async function verifySavedPreview(fixture: Awaited<ReturnType<typeof createFixture>>, beforePreview: string, expectedTitle = finalTitle) {
  await expect.poll(async () => {
    const document = await fixture.readDesign();
    return document.preview_status === "ready" && document.preview_revision === document.revision;
  }, { timeout: 60_000 }).toBe(true);
  await expect.poll(() => previewPixels(fixture.preview), { timeout: 45_000 }).not.toBe(beforePreview);
  const savedPreview = await previewPixels(fixture.preview);
  expect(savedPreview.length).toBeGreaterThan(100);
  const saved = await fixture.readDesign();
  expect(titleText(saved, fixture.titleId)).toBe(expectedTitle);
  await fixture.page.reload();
  await expect(fixture.preview.locator("img")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => previewPixels(fixture.preview), { timeout: 45_000 }).toBe(savedPreview);
  expect((await fixture.readDesign()).scene).toEqual(saved.scene);
}

async function sendMessage(page: Page, prompt: string) {
  const input = page.getByRole("textbox", { name: "输入消息" });
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  // Running mode may use a distinct accessible name for its correction action.
  const send = page.getByRole("button", { name: /^(发送消息|发送补充或纠正|发送补充|发送更正|补充要求)$/ });
  // Use the user's actual pointer transition out of the canvas editor before
  // typing. Do not repeatedly re-fill a lost draft and conceal input defects.
  await input.click();
  await expect(input).toBeFocused();
  await input.fill(prompt);
  await expect(input).toHaveValue(prompt);
  await expect(send).toBeEnabled();
  await send.click();
}

async function saveEvidence(info: TestInfo, name: string, evidence: Record<string, unknown>) {
  // Persist explicitly because the local line reporter does not materialize
  // attachment bodies. Callers pass only sanitized, assertion-specific data.
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2), "utf8");
  await info.attach(name, { path, contentType: "application/json" });
}

function observeAgentTraffic(page: Page) {
  type CapturedRequest = { sessionId: string; skillMentions: string[]; designTask?: { target?: Record<string, unknown>; correctionOfRunId?: string } };
  const requests: CapturedRequest[] = [];
  const acks: string[] = [];
  const events: Array<{ type: string; runId?: string; toolName?: string; inputPath?: string; skillReadCharacters?: number; skillReadFailed?: boolean; skillVersion?: string; skillHash?: string; outputStatus?: string; contentChanged?: boolean; visualBlockingIssues?: string[] | null; visualError?: string | null; visualReview?: string | null; previewReady?: boolean; previewRevision?: number; revision?: number }> = [];
  const pathsByToolCall = new Map<string, string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const value = JSON.parse(String(payload));
        if (value.action === "agent.run") requests.push({ sessionId: value.payload.sessionId, designTask: value.payload.designTask,
          skillMentions: (value.payload.mentions ?? []).filter((mention: any) => mention.mentionType === "skill").map((mention: any) => mention.slug),
        });
      } catch { /* Non-JSON transport frame. Never retain raw auth frames. */ }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const value = JSON.parse(String(payload));
        if (value.type === "command.ack" && value.action === "agent.run" && typeof value.payload?.runId === "string") acks.push(value.payload.runId);
        if (value.type === "event") {
          const output = value.event.output;
          // LangChain provider adapters may emit a JSON-string wrapper rather
          // than the original object. Decode it; never retain the raw payload.
          let input = value.event.input;
          if (typeof input?.input === "string") {
            try { input = JSON.parse(input.input); } catch { /* Not structured tool arguments. */ }
          } else if (typeof input === "string") {
            try { input = JSON.parse(input); } catch { /* Not structured tool arguments. */ }
          }
          const inputPath = input?.file_path ?? input?.path;
          if (value.event.toolName === "read_file" && typeof inputPath === "string") pathsByToolCall.set(value.event.toolCallId, inputPath);
          if (value.event.toolName === "use_skill" && typeof input?.name === "string") pathsByToolCall.set(value.event.toolCallId, `/workspace-skills/${input.name}/SKILL.md`);
          const path = pathsByToolCall.get(value.event.toolCallId);
          const skillReadSummary = path && value.event.type === "tool.completed" && typeof value.event.outputSummary === "string"
            ? value.event.outputSummary : undefined;
          events.push({ type: value.event.type, runId: value.event.runId, toolName: value.event.toolName,
            ...(path ? { inputPath: path } : {}),
            ...(skillReadSummary ? { skillReadCharacters: skillReadSummary.length,
              skillReadFailed: Boolean(output?.error) || /^\s*(?:Error\b|ENOENT\b|File not found\b|Cannot read\b)/i.test(skillReadSummary) } : {}),
            ...(value.event.toolName === "use_skill" && value.event.type === "tool.completed" ? {
              skillReadCharacters: typeof output?.instructions === "string" ? output.instructions.length : 0,
              skillReadFailed: output?.status !== "loaded" || output?.skill?.path !== path,
              skillVersion: output?.skill?.version, skillHash: output?.skill?.contentHash,
            } : {}),
            ...(typeof output?.status === "string" ? { outputStatus: output.status } : {}),
            ...(typeof output?.contentChanged === "boolean" ? { contentChanged: output.contentChanged } : {}),
            ...(output?.visualBlockingIssues === null || (Array.isArray(output?.visualBlockingIssues) && output.visualBlockingIssues.every((issue: unknown) => typeof issue === "string"))
              ? { visualBlockingIssues: output.visualBlockingIssues } : {}),
            ...(output?.visualError === null || typeof output?.visualError === "string" ? { visualError: output.visualError } : {}),
            ...(output?.visualReview === null || typeof output?.visualReview === "string" ? { visualReview: output.visualReview } : {}),
            ...(typeof output?.previewReady === "boolean" ? { previewReady: output.previewReady } : {}),
            ...(typeof output?.previewRevision === "number" ? { previewRevision: output.previewRevision } : {}),
            ...(typeof output?.revision === "number" ? { revision: output.revision } : {}),
          });
        }
      } catch { /* Ignore protocol frames unrelated to this assertion. */ }
    });
  });
  return { requests, acks, events, isTerminal: (runId: string) => events.some((event) => event.runId === runId && ["run.completed", "run.canceled", "run.failed"].includes(event.type)) };
}
