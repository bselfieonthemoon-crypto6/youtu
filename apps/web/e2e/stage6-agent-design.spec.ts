import { type ChildProcess, spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  type CanvasGetResponse,
  canvasGetResponseSchema,
  createDesignResponseSchema,
  designCatalogMutationResponseSchema,
  designGetResponseSchema,
  designResourceDtoSchema,
  designTemplateDetailDtoSchema,
  projectCreateResponseSchema,
  providerConfigResponseSchema,
  uploadResponseSchema,
} from "@loomic/shared";
import {
  type APIRequestContext,
  type APIResponse,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

if (!process.env.APIYI_API_KEY) {
  try {
    loadEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url)));
  } catch {
    // The fixture assertion below reports a precise, secret-safe error.
  }
}

const serverURL = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
const supabaseURL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const configuredEmail = process.env.LOOMIC_E2E_EMAIL;
const configuredPassword = process.env.LOOMIC_E2E_PASSWORD;
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Stage 6 runs Agent design tools and finalizes one paid image exactly once", async ({
  page,
  request,
}) => {
  test.setTimeout(15 * 60_000);
  assertLocalFixtureEnvironment();

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const fixture: CleanupFixture = {
    accessToken: null,
    projectId: null,
    resourceId: null,
    templateId: null,
    uploadedAssetId: null,
    generatedAssetIds: [],
    jobIds: [],
    catalogRequestIds: [],
    createdAuthUserId: null,
    actorUserId: null,
    providerConfigId: null,
    startedAt,
  };
  let worker: ChildProcess | null = null;

  try {
    const admin = createClient(supabaseURL, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const account = await ensureLocalTestAccount(admin, runId);
    fixture.createdAuthUserId = account.createdUserId;
    const accessToken = await loginSeededUser(
      page,
      account.email,
      account.password,
    );
    fixture.accessToken = accessToken;
    const { data: authenticated, error: authenticatedError } =
      await admin.auth.getUser(accessToken);
    if (authenticatedError || !authenticated.user)
      throw (
        authenticatedError ?? new Error("Stage 6 authenticated user missing.")
      );
    const actorUserId = authenticated.user.id;
    fixture.actorUserId = actorUserId;
    const project = projectCreateResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/projects`, {
          headers: jsonHeaders(accessToken),
          data: {
            name: `Stage 6 Agent ${runId}`,
            description: "Disposable local Stage 6 Agent acceptance fixture.",
          },
        }),
        "create Stage 6 project",
      ),
    ).project;
    fixture.projectId = project.id;
    const canvasId = project.primaryCanvas.id;
    const workspaceId = project.workspace.id;

    const [{ error: subscriptionError }, { error: balanceError }] =
      await Promise.all([
        admin
          .from("subscriptions")
          .update({ plan: "pro" })
          .eq("workspace_id", workspaceId),
        admin
          .from("credit_balances")
          .update({ balance: 100 })
          .eq("workspace_id", workspaceId),
      ]);
    if (subscriptionError || balanceError)
      throw (
        subscriptionError ??
        balanceError ??
        new Error("Stage 6 billing fixture setup failed.")
      );

    const provider = providerConfigResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/workspace/provider-configs`, {
          headers: jsonHeaders(accessToken),
          data: {
            displayName: `Stage 6 APIYI ${runId}`,
            baseUrl: process.env.APIYI_API_BASE ?? "https://api.apiyi.com/v1",
            apiKey: process.env.APIYI_API_KEY,
            enabled: true,
            models: [
              {
                upstreamModelId: "gpt-image-2",
                displayName: "GPT Image 2",
                modality: "image",
                enabled: true,
                capabilities: ["image_generation"],
              },
            ],
          },
        }),
        "create Stage 6 provider",
      ),
    ).config;
    fixture.providerConfigId = provider.id;
    await readJson(
      await request.post(
        `${serverURL}/api/workspace/provider-configs/${provider.id}/test`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ),
      "test Stage 6 provider",
    );
    const imageCatalog = (await readJson(
      await request.get(`${serverURL}/api/image-models`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      "load Stage 6 image catalog",
    )) as { models?: Array<{ id?: unknown }> };
    const imageModelRef = readString(imageCatalog.models?.[0]?.id);
    if (!imageModelRef?.startsWith("workspace:"))
      throw new Error("Stage 6 provider model was not published to the workspace.");

    const initialCanvas = await fetchCanvas(request, accessToken, canvasId);
    const created = createDesignResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/designs`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: crypto.randomUUID(),
            canvas_id: canvasId,
            expected_canvas_revision: initialCanvas.canvas.revision,
            canvas_element_id: `stage6-design-${runId}`,
            name: `Stage 6 设计 ${runId}`,
            width: 640,
            height: 360,
            background: "#ffffff",
            node: { x: 80, y: 80, width: 640, height: 360 },
          },
        }),
        "create Stage 6 design",
      ),
    );
    const designId = created.design_id;
    const textObjectId = crypto.randomUUID();
    await mutateDesign(request, accessToken, designId, {
      expectedRevision: created.design_revision,
      commands: [
        {
          action: "object.add",
          object: textObject(textObjectId, "Agent 修改前"),
        },
      ],
    });

    const uploaded = uploadResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/uploads`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          multipart: {
            file: {
              name: `stage6-${runId}.png`,
              mimeType: "image/png",
              buffer: PNG_FIXTURE,
            },
          },
        }),
        "upload Stage 6 resource",
      ),
    );
    fixture.uploadedAssetId = uploaded.asset.id;
    const resourceName = `stage6-resource-${runId}`;
    const resourceRequestId = crypto.randomUUID();
    fixture.catalogRequestIds.push(resourceRequestId);
    const resource = designResourceDtoSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/admin/design-catalog/resources`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: resourceRequestId,
            scope: "workspace",
            workspace_id: workspaceId,
            kind: "image",
            name: resourceName,
            description: "Stage 6 Agent search fixture.",
            asset_object_id: uploaded.asset.id,
            preview_asset_object_id: uploaded.asset.id,
            category_id: null,
            tag_ids: [],
            source_url: null,
            author: null,
            license_name: "Local test fixture",
            license_url: null,
            attribution: null,
            usage_restrictions: "Local automated test only",
          },
        }),
        "create Stage 6 resource",
      ),
    );
    fixture.resourceId = resource.id;
    await publishCatalogEntry(
      request,
      accessToken,
      "resource",
      resource.id,
      resource.revision,
      fixture.catalogRequestIds,
    );

    const templateName = `stage6-template-${runId}`;
    const templateRequestId = crypto.randomUUID();
    fixture.catalogRequestIds.push(templateRequestId);
    const template = designTemplateDetailDtoSchema.parse(
      await readJson(
        await request.post(
          `${serverURL}/api/admin/design-catalog/templates/from-design`,
          {
            headers: jsonHeaders(accessToken),
            data: {
              request_id: templateRequestId,
              design_id: designId,
              scope: "workspace",
              workspace_id: workspaceId,
              name: templateName,
              description: "Stage 6 Agent template fixture.",
              preview_asset_object_id: uploaded.asset.id,
              category_id: null,
              tag_ids: [],
              source_url: null,
              author: null,
              license_name: "Local test fixture",
              license_url: null,
              attribution: null,
              usage_restrictions: "Local automated test only",
            },
          },
        ),
        "create Stage 6 template",
      ),
    );
    fixture.templateId = template.template.id;
    const templateRevision = await publishCatalogEntry(
      request,
      accessToken,
      "template",
      template.template.id,
      template.template.revision,
      fixture.catalogRequestIds,
    );

    worker = await startWorker(runId);
    const websocketConnected = page.waitForEvent("console", {
      predicate: (message) => message.text().includes("[ws] connected"),
      timeout: 60_000,
    });
    await page.goto(`/canvas?id=${encodeURIComponent(canvasId)}`);
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    await websocketConnected;
    await expect(
      page.getByText("连接已断开，正在重连...", { exact: true }),
    ).toBeHidden();

    await sendAgentPrompt(
      page,
      `只执行一个动作：调用 inspect_design 读取 design_id=${designId}，不要修改设计。`,
    );
    const inspectCard = page
      .getByText(new RegExp(`已读取设计.*${escapeRegExp(runId)}`))
      .last();
    await expect(inspectCard).toBeVisible({ timeout: 120_000 });
    const inspectContainer = inspectCard.locator(
      "xpath=ancestor::div[button[normalize-space()='打开设计']][1]",
    );
    await inspectContainer.getByRole("button", { name: "打开设计" }).click();
    await expect(
      page.locator(`dialog[data-design-id="${designId}"]`),
    ).toBeVisible();
    await page
      .locator(`dialog[data-design-id="${designId}"]`)
      .getByRole("button", { name: "返回画布" })
      .click();

    const beforeTextMutation = await fetchDesign(
      request,
      accessToken,
      designId,
    );
    await sendAgentPrompt(
      page,
      `只调用 get_design_objects：读取 design_id=${designId} 在 expected_revision=${beforeTextMutation.revision} 的对象 ${textObjectId}，不要修改设计。`,
    );
    await expect(page.getByText("已读取设计对象").last()).toBeVisible({
      timeout: 120_000,
    });
    const currentTextObject = beforeTextMutation.scene.objects.find(
      (candidate) => candidate.objectId === textObjectId,
    );
    if (!currentTextObject) throw new Error("Stage 6 text fixture is missing.");
    const textMutationIdempotencyKey = crypto.randomUUID();
    await sendAgentPrompt(
      page,
      `只调用一次 manipulate_design，并严格使用这个 JSON 输入：{"design_id":"${designId}","expected_revision":${beforeTextMutation.revision},"idempotency_key":"${textMutationIdempotencyKey}","commands":[{"action":"object.update","object_id":"${textObjectId}","expected_object_version":${currentTextObject.objectVersion},"patch":{"object_type":"text","text":"Agent 已真实修改"}}]}。不要改写字段，不要调用其他工具。`,
    );
    await expect(page.getByText("设计修改完成").last()).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(
        async () => {
          const design = await fetchDesign(request, accessToken, designId);
          const object = design.scene.objects.find(
            (candidate) => candidate.objectId === textObjectId,
          );
          return object?.type === "text" ? object.text : null;
        },
        { timeout: 30_000 },
      )
      .toBe("Agent 已真实修改");
    expect(
      (await fetchDesign(request, accessToken, designId)).revision,
    ).toBeGreaterThan(beforeTextMutation.revision);

    await sendAgentPrompt(
      page,
      `只调用 search_design_resources：在 workspace_id=${workspaceId} 中精确搜索“${resourceName}”，不要修改设计。`,
    );
    await expect(page.getByText(/找到 1 个可用资源/u).last()).toBeVisible({
      timeout: 120_000,
    });

    const beforeTemplate = await fetchDesign(request, accessToken, designId);
    await sendAgentPrompt(
      page,
      `请调用 apply_design_template，把 template_id=${template.template.id}（expected_template_revision=${templateRevision}）以 replace 模式套用到 design_id=${designId}。先读取当前设计 revision，并使用新的 UUID 作为 idempotency_key。`,
    );
    const confirmTemplate = page
      .getByRole("button", { name: "确认套用" })
      .last();
    await expect(confirmTemplate).toBeVisible({ timeout: 120_000 });
    await confirmTemplate.click();
    await expect(
      page.getByText("已确认，正在应用设计更改").last(),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await fetchDesign(request, accessToken, designId)).revision,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(beforeTemplate.revision);

    const beforeExport = await fetchDesign(request, accessToken, designId);
    const exportIdempotencyKey = crypto.randomUUID();
    const exportPrompt = `只调用 export_design：导出 design_id=${designId}，expected_revision=${beforeExport.revision}，idempotency_key=${exportIdempotencyKey}，format=png，multiplier=1，transparent=false。不要调用其他工具。`;
    await sendAgentPrompt(page, exportPrompt);
    await expect(page.getByText(/设计导出/u).last()).toBeVisible({
      timeout: 120_000,
    });
    await waitForToolExecutionCount(
      admin,
      actorUserId,
      startedAt,
      "export_design",
      1,
    );
    await sendAgentPrompt(
      page,
      `${exportPrompt} 这是严格幂等重放，必须原样复用 idempotency_key，不得创建第二个导出任务。`,
    );
    await waitForToolExecutionCount(
      admin,
      actorUserId,
      startedAt,
      "export_design",
      2,
    );
    const exportJob = await waitForSucceededJob(
      admin,
      designId,
      "design_export",
    );
    fixture.jobIds.push(exportJob.id);
    expect(readString(readRecord(exportJob.payload)?.idempotency_key)).toBe(
      exportIdempotencyKey,
    );
    const exportAssetId =
      readString(readRecord(exportJob.result)?.asset_object_id) ??
      readString(readRecord(exportJob.result)?.asset_id);
    if (exportAssetId) fixture.generatedAssetIds.push(exportAssetId);
    const { count: exportJobCount, error: exportJobCountError } = await admin
      .from("background_jobs")
      .select("id", { count: "exact", head: true })
      .eq("design_id", designId)
      .eq("job_type", "design_export");
    expect(exportJobCountError).toBeNull();
    expect(exportJobCount).toBe(1);

    const beforeGeneration = await fetchDesign(request, accessToken, designId);
    const generationIdempotencyKey = crypto.randomUUID();
    const generationTitle = `stage6-blue-icon-${runId}`;
    const generationPrompt =
      "A single minimal blue circular geometric icon centered on a clean transparent background, no text, no extra objects.";
    const existingObjectIds = new Set(
      beforeGeneration.scene.objects.map((object) => object.objectId),
    );
    await sendAgentPrompt(
      page,
      `只调用一次 generate_image，并严格原样使用这些字段：title="${generationTitle}"；prompt="${generationPrompt}"；model="${imageModelRef}"；aspectRatio="1:1"；quality="standard"；outputFormat="png"；target={kind:"design",design_id:"${designId}",expected_revision:${beforeGeneration.revision},idempotency_key:"${generationIdempotencyKey}",placement:{x:360,y:80,width:180,height:180,fit:"contain",role:"decoration"}}。不要插入无限画布，不得改写字段。`,
    );
    const confirmGeneration = page.getByRole("button", {
      name: "确认方案，继续生成",
    });
    await expect(confirmGeneration).toBeVisible({ timeout: 120_000 });
    await confirmGeneration.click();

    const job = await waitForSucceededDesignJob(admin, designId);
    fixture.jobIds.push(job.id);
    expect(
      readString(readRecord(readRecord(job.payload)?.target)?.idempotency_key),
    ).toBe(generationIdempotencyKey);
    const finalized = await waitForCompletedFinalization(admin, job.id);
    await revealCompletedGeneration(page);
    const generatedObjectId = readString(finalized.result?.object_id);
    const generatedAssetId = readString(finalized.result?.asset_object_id);
    expect(generatedObjectId).toBeTruthy();
    expect(generatedAssetId).toBeTruthy();
    if (generatedAssetId) fixture.generatedAssetIds.push(generatedAssetId);

    const afterGeneration = await waitForDesignObject(
      request,
      accessToken,
      designId,
      generatedObjectId,
    );
    expect(afterGeneration.revision).toBeGreaterThan(beforeGeneration.revision);
    const generatedObject = afterGeneration.scene.objects.find(
      (object) => object.objectId === generatedObjectId,
    );
    expect(generatedObject).toMatchObject({
      type: "image",
      assetObjectId: generatedAssetId,
    });
    expect(existingObjectIds.has(generatedObjectId ?? "")).toBe(false);

    const { data: refs, error: refsError } = await admin
      .from("design_document_asset_refs")
      .select("object_id,asset_object_id,resource_id")
      .eq("design_id", designId)
      .eq("object_id", generatedObjectId ?? "");
    expect(refsError).toBeNull();
    expect(refs).toEqual([
      expect.objectContaining({
        object_id: generatedObjectId,
        asset_object_id: generatedAssetId,
      }),
    ]);

    await expect
      .poll(
        async () => {
          const design = await fetchDesign(request, accessToken, designId);
          return (
            design.preview_status === "ready" &&
            design.preview_revision === design.revision &&
            Boolean(design.preview_asset_object_id)
          );
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    const previewReady = await fetchDesign(request, accessToken, designId);
    if (previewReady.preview_asset_object_id)
      fixture.generatedAssetIds.push(previewReady.preview_asset_object_id);

    const beforeReplay = await fetchDesign(request, accessToken, designId);
    const { count: chargeCountBefore, error: chargeBeforeError } = await admin
      .from("credit_transactions")
      .select("id", { count: "exact", head: true })
      .eq("job_id", job.id)
      .eq("transaction_type", "generation_deduct");
    expect(chargeBeforeError).toBeNull();
    expect(chargeCountBefore).toBe(1);

    await sendAgentPrompt(
      page,
      `执行一次严格幂等重放：再次只调用 generate_image，并严格原样使用 title="${generationTitle}"；prompt="${generationPrompt}"；model="${imageModelRef}"；aspectRatio="1:1"；quality="standard"；outputFormat="png"；target={kind:"design",design_id:"${designId}",expected_revision:${beforeGeneration.revision},idempotency_key:"${generationIdempotencyKey}",placement:{x:360,y:80,width:180,height:180,fit:"contain",role:"decoration"}}。不得改写任何字段，不得生成第二张图。`,
    );
    const confirmReplay = page
      .getByRole("button", { name: "确认方案，继续生成" })
      .last();
    await expect(confirmReplay).toBeVisible({ timeout: 120_000 });
    await confirmReplay.click();
    await revealCompletedGeneration(page);

    const { count: designJobCount, error: designJobCountError } = await admin
      .from("background_jobs")
      .select("id", { count: "exact", head: true })
      .eq("design_id", designId)
      .eq("job_type", "image_generation");
    expect(designJobCountError).toBeNull();
    expect(designJobCount).toBe(1);

    // Replaying the finalizer claim independently protects the final delivery
    // path too; the Agent replay above is what proves provider/job/billing
    // idempotency at the public product boundary.
    const { data: replayClaim, error: replayError } = await admin.rpc(
      "loomic_job_finalization_claim",
      {
        p_job_id: job.id,
        p_command_id: finalized.command_id,
        p_now: new Date().toISOString(),
      },
    );
    expect(replayError).toBeNull();
    expect(readRecord(replayClaim)?.acquired).toBe(false);
    const afterReplay = await fetchDesign(request, accessToken, designId);
    expect(afterReplay.revision).toBe(beforeReplay.revision);
    expect(
      afterReplay.scene.objects.filter(
        (object) => object.objectId === generatedObjectId,
      ),
    ).toHaveLength(1);
    const { count: chargeCountAfter } = await admin
      .from("credit_transactions")
      .select("id", { count: "exact", head: true })
      .eq("job_id", job.id)
      .eq("transaction_type", "generation_deduct");
    expect(chargeCountAfter).toBe(1);

    await assertAgentDesignAudit(admin, {
      actorUserId,
      designId,
      startedAt,
    });

    const conflictBase = await fetchDesign(request, accessToken, designId);
    const concurrent = await Promise.all([
      request.post(`${serverURL}/api/designs/${designId}/mutations`, {
        headers: jsonHeaders(accessToken),
        data: mutationBody(designId, conflictBase.revision, [
          { action: "canvas.update", background: "#f7f7f7" },
        ]),
      }),
      request.post(`${serverURL}/api/designs/${designId}/mutations`, {
        headers: jsonHeaders(accessToken),
        data: mutationBody(designId, conflictBase.revision, [
          { action: "canvas.update", background: "#f0f4ff" },
        ]),
      }),
    ]);
    expect(concurrent.map((response) => response.status()).sort()).toEqual([
      200, 409,
    ]);

    await page.reload();
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    const reopened = await fetchDesign(request, accessToken, designId);
    expect(
      reopened.scene.objects.find(
        (object) => object.objectId === generatedObjectId,
      ),
    ).toMatchObject({ assetObjectId: generatedAssetId });
    const preview = page.locator(
      `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
    );
    await expect(preview).toBeVisible();
  } finally {
    if (worker) await stopWorker(worker);
    await cleanupLocalFixture(fixture, request);
  }
});

function textObject(objectId: string, text: string) {
  return {
    objectId,
    objectVersion: 1,
    type: "text",
    name: "Stage 6 text",
    role: "title",
    x: 40,
    y: 40,
    width: 480,
    height: 80,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    text,
    fontFaceId: null,
    fontFamily: "Arial",
    fontSize: 48,
    fontWeight: 700,
    fontStyle: "normal",
    textAlign: "left",
    lineHeight: 1.2,
    charSpacing: 0,
    fill: { kind: "solid", color: "#111111" },
  };
}

async function mutateDesign(
  request: APIRequestContext,
  accessToken: string,
  designId: string,
  input: { expectedRevision: number; commands: unknown[] },
) {
  return readJson(
    await request.post(`${serverURL}/api/designs/${designId}/mutations`, {
      headers: jsonHeaders(accessToken),
      data: mutationBody(designId, input.expectedRevision, input.commands),
    }),
    "mutate Stage 6 design",
  );
}

function mutationBody(
  designId: string,
  expectedRevision: number,
  commands: unknown[],
) {
  return {
    design_id: designId,
    expected_revision: expectedRevision,
    idempotency_key: crypto.randomUUID(),
    commands,
  };
}

async function publishCatalogEntry(
  request: APIRequestContext,
  accessToken: string,
  entityKind: "resource" | "template",
  entityId: string,
  initialRevision: number,
  requestIds: string[],
) {
  let revision = initialRevision;
  for (const status of ["pending_review", "published"] as const) {
    const requestId = crypto.randomUUID();
    requestIds.push(requestId);
    const response = designCatalogMutationResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/admin/design-catalog/status`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: requestId,
            entity_kind: entityKind,
            entity_id: entityId,
            expected_revision: revision,
            status,
          },
        }),
        `publish ${entityKind}`,
      ),
    );
    revision = response.revision;
  }
  return revision;
}

async function sendAgentPrompt(page: Page, prompt: string) {
  const input = page.getByLabel("输入消息");
  await expect(input).toBeVisible();
  await expect(
    page.getByText("连接已断开，正在重连...", { exact: true }),
  ).toBeHidden();
  const send = page.getByRole("button", { name: "发送消息" });
  await expect(send).toBeVisible({ timeout: 120_000 });
  await input.fill(prompt);
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
}

async function ensureLocalTestAccount(
  admin: ReturnType<typeof createClient>,
  runId: string,
) {
  if (configuredEmail && configuredPassword)
    return {
      email: configuredEmail,
      password: configuredPassword,
      createdUserId: null,
    };
  if (configuredEmail || configuredPassword)
    throw new Error(
      "LOOMIC_E2E_EMAIL and LOOMIC_E2E_PASSWORD must be provided together.",
    );

  const disposableEmail = `stage6-${runId}@example.test`;
  const disposablePassword = `Stage6-${crypto.randomUUID()}-aA1!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: disposableEmail,
    password: disposablePassword,
    email_confirm: true,
  });
  if (error || !data.user)
    throw error ?? new Error("Failed to create disposable Stage 6 user.");
  return {
    email: disposableEmail,
    password: disposablePassword,
    createdUserId: data.user.id,
  };
}

async function waitForToolExecutionCount(
  admin: ReturnType<typeof createClient>,
  actorUserId: string,
  startedAt: string,
  toolName: string,
  expectedCount: number,
) {
  await expect
    .poll(
      async () => {
        const { count, error } = await admin
          .from("tool_executions")
          .select("id", { count: "exact", head: true })
          .eq("requested_by", actorUserId)
          .eq("tool_name", toolName)
          .gte("created_at", startedAt);
        if (error) throw error;
        return count;
      },
      { timeout: 120_000 },
    )
    .toBe(expectedCount);
}

async function waitForSucceededJob(
  admin: ReturnType<typeof createClient>,
  designId: string,
  jobType: "design_export" | "image_generation",
) {
  let found: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from("background_jobs")
          .select("id,status,payload,result,error_code,error_message")
          .eq("design_id", designId)
          .eq("job_type", jobType)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        found = data as Record<string, unknown> | null;
        const status = readString(found?.status);
        if (["failed", "dead_letter", "canceled"].includes(status ?? ""))
          throw new Error(
            `${jobType} failed: ${readString(found?.error_code) ?? "unknown"} ${readString(found?.error_message) ?? ""}`,
          );
        return status;
      },
      { timeout: 240_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("succeeded");
  if (!found || !readString(found.id))
    throw new Error(`${jobType} job missing.`);
  return found as Record<string, unknown> & { id: string };
}

async function assertAgentDesignAudit(
  admin: ReturnType<typeof createClient>,
  input: { actorUserId: string; designId: string; startedAt: string },
) {
  const { data: executions, error: executionError } = await admin
    .from("tool_executions")
    .select("id,run_id,tool_name,status")
    .eq("requested_by", input.actorUserId)
    .gte("created_at", input.startedAt);
  expect(executionError).toBeNull();
  const toolExecutions = executions ?? [];
  const executedTools = new Set(
    toolExecutions.map((execution) => execution.tool_name),
  );
  for (const required of [
    "inspect_design",
    "get_design_objects",
    "manipulate_design",
    "search_design_resources",
    "apply_design_template",
    "export_design",
  ])
    expect(executedTools, `missing ${required} tool execution`).toContain(
      required,
    );

  const { data: requests, error: requestError } = await admin
    .from("design_agent_tool_requests")
    .select(
      "tool_execution_id,agent_run_id,design_id,operation,completed_at,result",
    )
    .eq("actor_user_id", input.actorUserId)
    .in("operation", ["manipulate_design", "apply_design_template"])
    .gte("created_at", input.startedAt);
  expect(requestError).toBeNull();
  const auditRows = requests ?? [];
  const operations = new Set(auditRows.map((row) => row.operation));
  expect(operations).toContain("manipulate_design");
  expect(operations).toContain("apply_design_template");
  expect(auditRows.every((row) => Boolean(row.completed_at))).toBe(true);

  const executionById = new Map(
    toolExecutions.map((execution) => [execution.id, execution]),
  );
  for (const audit of auditRows) {
    const execution = executionById.get(audit.tool_execution_id);
    expect(execution).toBeTruthy();
    expect(execution?.run_id).toBe(audit.agent_run_id);
    expect(execution?.tool_name).toBe(audit.operation);
    expect(execution?.status).toBe("completed");
  }

  const { data: versions, error: versionError } = await admin
    .from("design_document_versions")
    .select(
      "revision,actor_kind,agent_run_id,tool_execution_id,changed_object_ids",
    )
    .eq("design_id", input.designId)
    .eq("actor_kind", "agent")
    .gte("created_at", input.startedAt);
  expect(versionError).toBeNull();
  expect((versions ?? []).length).toBeGreaterThanOrEqual(2);
  const mutatingOperations = new Set<string>();
  for (const version of versions ?? []) {
    expect(version.agent_run_id).toBeTruthy();
    expect(version.tool_execution_id).toBeTruthy();
    const audit = auditRows.find(
      (candidate) =>
        candidate.tool_execution_id === version.tool_execution_id &&
        candidate.agent_run_id === version.agent_run_id,
    );
    expect(audit).toBeTruthy();
    if (audit) mutatingOperations.add(audit.operation);
  }
  expect(mutatingOperations).toContain("manipulate_design");
  expect(mutatingOperations).toContain("apply_design_template");
}

async function waitForSucceededDesignJob(
  admin: ReturnType<typeof createClient>,
  designId: string,
) {
  let found: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from("background_jobs")
          .select("id,status,design_id,payload,result")
          .eq("design_id", designId)
          .eq("job_type", "image_generation")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        found = data as Record<string, unknown> | null;
        return readString(found?.status);
      },
      { timeout: 240_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("succeeded");
  if (!found || !readString(found.id))
    throw new Error("Design image job missing.");
  return found as Record<string, unknown> & { id: string };
}

async function waitForCompletedFinalization(
  admin: ReturnType<typeof createClient>,
  jobId: string,
) {
  let found: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from("job_target_finalizations")
          .select("command_id,status,result")
          .eq("job_id", jobId)
          .maybeSingle();
        if (error) throw error;
        found = data as Record<string, unknown> | null;
        return readString(found?.status);
      },
      { timeout: 120_000 },
    )
    .toBe("completed");
  const commandId = readString(found?.command_id);
  if (!found || !commandId) throw new Error("Design finalization missing.");
  return {
    command_id: commandId,
    result: readRecord(found.result),
  };
}

async function waitForDesignObject(
  request: APIRequestContext,
  accessToken: string,
  designId: string,
  objectId: string | undefined,
) {
  let found = await fetchDesign(request, accessToken, designId);
  await expect
    .poll(
      async () => {
        found = await fetchDesign(request, accessToken, designId);
        return found.scene.objects.some(
          (object) => object.objectId === objectId,
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return found;
}

async function fetchCanvas(
  request: APIRequestContext,
  accessToken: string,
  canvasId: string,
): Promise<CanvasGetResponse> {
  return canvasGetResponseSchema.parse(
    await readJson(
      await request.get(`${serverURL}/api/canvases/${canvasId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      "get Stage 6 canvas",
    ),
  );
}

async function fetchDesign(
  request: APIRequestContext,
  accessToken: string,
  designId: string,
) {
  return designGetResponseSchema.parse(
    await readJson(
      await request.get(`${serverURL}/api/designs/${designId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      "get Stage 6 design",
    ),
  ).design;
}

async function loginSeededUser(
  page: Page,
  loginEmail: string,
  loginPassword: string,
) {
  const authResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/auth/v1/token"),
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(loginEmail);
  await page.getByLabel("Password").fill(loginPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await authResponsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = readString(body.access_token);
  if (!accessToken)
    throw new Error("Supabase login did not return an access token.");
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    ),
  );
  await page.goto("/home", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/home(?:[/?#]|$)/u);
  return accessToken;
}

async function readJson(response: APIResponse, operation: string) {
  if (!response.ok())
    throw new Error(
      `${operation} failed (${response.status()}): ${await response.text()}`,
    );
  return response.json();
}

function jsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function startWorker(runId: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "./src/worker.ts"],
    {
      cwd: new URL("../../server/", import.meta.url),
      env: {
        ...process.env,
        WORKER_ID: `stage6-agent-${runId.slice(0, 8)}`,
        WORKER_POLL_INTERVAL_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`Stage 6 worker did not start: ${output.slice(-2_000)}`),
        ),
      30_000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("Started.")) finish();
    };
    const onExit = (code: number | null) =>
      finish(new Error(`Stage 6 worker exited before ready (${code}).`));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
  return child;
}

async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
}

async function revealCompletedGeneration(page: Page) {
  const completed = page.getByText("图片已插入设计").last();
  if (await completed.isVisible()) return;
  const continueWaiting = page.getByRole("button", { name: "继续等待" }).last();
  await expect(continueWaiting).toBeVisible({ timeout: 30_000 });
  await continueWaiting.click();
  await expect(completed).toBeVisible({ timeout: 120_000 });
}

type CleanupFixture = {
  accessToken: string | null;
  projectId: string | null;
  resourceId: string | null;
  templateId: string | null;
  uploadedAssetId: string | null;
  generatedAssetIds: string[];
  jobIds: string[];
  catalogRequestIds: string[];
  createdAuthUserId: string | null;
  actorUserId: string | null;
  providerConfigId: string | null;
  startedAt: string;
};

async function cleanupLocalFixture(
  fixture: CleanupFixture,
  request: APIRequestContext,
) {
  const admin = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (fixture.actorUserId) {
    await admin
      .from("design_agent_tool_requests")
      .delete()
      .eq("actor_user_id", fixture.actorUserId)
      .gte("created_at", fixture.startedAt);
  }
  for (const jobId of fixture.jobIds) {
    await admin.from("credit_transactions").delete().eq("job_id", jobId);
    await admin.from("background_jobs").delete().eq("id", jobId);
  }
  if (fixture.templateId)
    await admin.from("design_templates").delete().eq("id", fixture.templateId);
  if (fixture.providerConfigId && fixture.accessToken) {
    const response = await request.delete(
      `${serverURL}/api/workspace/provider-configs/${fixture.providerConfigId}`,
      { headers: { Authorization: `Bearer ${fixture.accessToken}` } },
    );
    expect.soft(response.ok(), "Stage 6 provider cleanup failed").toBe(true);
  }
  if (fixture.projectId && fixture.accessToken) {
    const { data: projectDesigns } = await admin
      .from("design_documents")
      .select("id")
      .eq("project_id", fixture.projectId);
    for (const design of projectDesigns ?? []) {
      await admin
        .from("design_preview_requests")
        .delete()
        .eq("design_id", design.id);
    }
    const { data: projectJobs } = await admin
      .from("background_jobs")
      .select("id")
      .eq("project_id", fixture.projectId);
    for (const job of projectJobs ?? []) {
      await admin.from("credit_transactions").delete().eq("job_id", job.id);
      await admin.from("background_jobs").delete().eq("id", job.id);
    }
    const response = await request.delete(
      `${serverURL}/api/projects/${fixture.projectId}`,
      { headers: { Authorization: `Bearer ${fixture.accessToken}` } },
    );
    expect.soft(response.ok(), "Stage 6 project cleanup failed").toBe(true);
    const { error: purgeProjectError } = await admin
      .from("projects")
      .delete()
      .eq("id", fixture.projectId);
    expect
      .soft(purgeProjectError, "Stage 6 local project purge failed")
      .toBeNull();
  }
  if (fixture.resourceId)
    await admin.from("design_resources").delete().eq("id", fixture.resourceId);
  for (const requestId of fixture.catalogRequestIds)
    await admin
      .from("catalog_mutation_requests")
      .delete()
      .eq("request_id", requestId);
  for (const assetId of [
    fixture.uploadedAssetId,
    ...fixture.generatedAssetIds,
  ].filter((value): value is string => Boolean(value))) {
    const { data: asset } = await admin
      .from("asset_objects")
      .select("bucket,object_path")
      .eq("id", assetId)
      .maybeSingle();
    await admin.from("asset_objects").delete().eq("id", assetId);
    if (asset)
      await admin.storage.from(asset.bucket).remove([asset.object_path]);
  }
  if (fixture.createdAuthUserId) {
    const { error } = await admin.auth.admin.deleteUser(
      fixture.createdAuthUserId,
    );
    expect.soft(error, "Stage 6 auth user cleanup failed").toBeNull();
  }
}

function assertLocalFixtureEnvironment() {
  for (const [name, value] of [
    ["LOOMIC_E2E_SERVER_URL", serverURL],
    ["SUPABASE_URL", supabaseURL],
  ] as const) {
    if (!value) throw new Error(`${name} is required for Stage 6 E2E.`);
    if (!["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname))
      throw new Error(`${name} must target the disposable local stack.`);
  }
  if (!serviceRoleKey)
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for local cleanup.");
  if (!process.env.APIYI_API_KEY)
    throw new Error("APIYI_API_KEY is required for the real provider E2E.");
  if (process.env.LOOMIC_COMMERCIALIZATION_ENABLED !== "true")
    throw new Error(
      "LOOMIC_COMMERCIALIZATION_ENABLED=true is required to verify billing.",
    );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
