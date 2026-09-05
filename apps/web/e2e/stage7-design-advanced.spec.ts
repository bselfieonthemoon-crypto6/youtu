import { type ChildProcess, spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  canvasGetResponseSchema,
  createDesignResponseSchema,
  designGetResponseSchema,
  designTemplateDetailDtoSchema,
  projectCreateResponseSchema,
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

try {
  loadEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url)));
} catch {
  // The local-only assertion below provides a secret-safe error.
}

const serverURL = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
const supabaseURL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const databaseURL = process.env.SUPABASE_DB_URL ?? "";

test("Stage 7 persists image effects, local operations, template replacements and a >32 MP export", async ({
  page,
  request,
}) => {
  test.setTimeout(20 * 60_000);
  assertLocalEnvironment();
  const runId = crypto.randomUUID();
  const fixture: Fixture = {
    accessToken: null,
    actorUserId: null,
    createdAuthUserId: null,
    projectId: null,
    templateId: null,
    assetIds: [],
    jobIds: [],
    catalogRequestIds: [],
  };
  let worker: ChildProcess | null = null;
  const admin = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const account = await createLocalAccount(admin, runId);
    fixture.createdAuthUserId = account.userId;
    const accessToken = await login(page, account.email, account.password);
    fixture.accessToken = accessToken;
    const authenticated = await admin.auth.getUser(accessToken);
    if (authenticated.error || !authenticated.data.user)
      throw authenticated.error ?? new Error("Stage 7 user lookup failed.");
    fixture.actorUserId = authenticated.data.user.id;

    const project = projectCreateResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/projects`, {
          headers: jsonHeaders(accessToken),
          data: {
            name: `Stage 7 Advanced ${runId}`,
            description: "Disposable local-only Stage 7 acceptance fixture.",
          },
        }),
        "create project",
      ),
    ).project;
    fixture.projectId = project.id;
    const canvasId = project.primaryCanvas.id;

    await page.goto(`/canvas?id=${canvasId}`);
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    const sourcePng = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 96, height: 96 },
    });
    const uploaded = uploadResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/uploads`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          multipart: {
            file: {
              name: `stage7-source-${runId}.png`,
              mimeType: "image/png",
              buffer: sourcePng,
            },
          },
        }),
        "upload local operation source",
      ),
    );
    fixture.assetIds.push(uploaded.asset.id);

    const initialCanvas = canvasGetResponseSchema.parse(
      await readJson(
        await request.get(`${serverURL}/api/canvases/${canvasId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        "load initial canvas",
      ),
    );
    const created = createDesignResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/designs`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: crypto.randomUUID(),
            canvas_id: canvasId,
            expected_canvas_revision: initialCanvas.canvas.revision,
            canvas_element_id: `stage7-advanced-${runId}`,
            name: `Stage 7 Advanced ${runId}`,
            width: 640,
            height: 480,
            background: "#ffffff",
            node: { x: 40, y: 40, width: 640, height: 480 },
          },
        }),
        "create advanced design",
      ),
    );
    const designId = created.design_id;
    const textObjectId = crypto.randomUUID();
    const imageObjectId = crypto.randomUUID();
    const advancedMutation = await mutateDesign(
      request,
      accessToken,
      designId,
      created.design_revision,
      [
        {
          action: "object.add",
          object: textObject(textObjectId),
        },
        {
          action: "object.add",
          object: imageObject(imageObjectId, uploaded.asset.id),
        },
      ],
    );
    expect(advancedMutation.revision).toBe(created.design_revision + 1);

    await page.reload();
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    let design = await fetchDesign(request, accessToken, designId);
    expect(
      design.scene.objects.find((item) => item.objectId === imageObjectId),
    ).toMatchObject({
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      mask: {
        shape: "rounded_rect",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        radius: 0.2,
      },
      filters: { brightness: 0.2, contrast: -0.1, saturation: 0.3, blur: 0.1 },
      stroke: { kind: "solid", color: "#2255ff" },
      strokeWidth: 4,
      shadow: {
        color: "#000000",
        blur: 12,
        offsetX: 3,
        offsetY: 5,
        opacity: 0.4,
      },
    });

    worker = await startWorker(runId, "image");
    const sourceObject = design.scene.objects.find(
      (item) => item.objectId === imageObjectId,
    );
    if (!sourceObject || sourceObject.type !== "image")
      throw new Error("Stage 7 source image missing.");
    const imageJob = readRecord(
      (
        await readJson(
          await request.post(`${serverURL}/api/jobs/image-generation`, {
            headers: jsonHeaders(accessToken),
            data: {
              project_id: project.id,
              prompt: "Erase the selected pixels locally",
              operation: "erase_transparent",
              model: "local:feynobg",
              // Reuse the valid local screenshot as a deterministic luminance
              // mask. Transparent erase follows the real PIL/OpenCV worker
              // path without loading a paid provider or a large ML checkpoint.
              mask_image: `data:image/png;base64,${sourcePng.toString("base64")}`,
              target: {
                kind: "design",
                design_id: designId,
                expected_revision: design.revision,
                idempotency_key: crypto.randomUUID(),
                source_object_id: imageObjectId,
                expected_object_version: sourceObject.objectVersion,
                source_asset_object_id: sourceObject.assetObjectId,
                placement: {
                  x: sourceObject.x,
                  y: sourceObject.y,
                  replace_object_id: imageObjectId,
                },
              },
            },
          }),
          "queue local image operation",
        )
      ).job,
    );
    const imageJobId = readString(imageJob.id);
    if (!imageJobId) throw new Error("Local image job id missing.");
    fixture.jobIds.push(imageJobId);
    const completedImageJob = await waitForJob(admin, imageJobId, 10 * 60_000);
    const generatedAssetId = readString(
      readRecord(completedImageJob.result).asset_id,
    );
    if (!generatedAssetId) throw new Error("Local image result asset missing.");
    fixture.assetIds.push(generatedAssetId);
    await expect
      .poll(
        async () => {
          const result = await admin
            .from("job_target_finalizations")
            .select("status,result")
            .eq("job_id", imageJobId)
            .maybeSingle();
          if (result.error) throw result.error;
          return result.data?.status;
        },
        { timeout: 120_000 },
      )
      .toBe("completed");
    design = await fetchDesign(request, accessToken, designId);
    const finalizedImage = design.scene.objects.find(
      (item) => item.objectId === imageObjectId,
    );
    expect(finalizedImage).toMatchObject({
      type: "image",
      assetObjectId: generatedAssetId,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    const recoveredImageJob = readRecord(
      (
        await readJson(
          await request.get(`${serverURL}/api/jobs/${imageJobId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          "recover local image job",
        )
      ).job,
    );
    expect(readString(recoveredImageJob.status)).toBe("succeeded");
    expect(
      readRecord(recoveredImageJob.result).target_finalization,
    ).toBeTruthy();
    await stopWorker(worker);
    worker = null;

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
              workspace_id: project.workspace.id,
              name: `Stage 7 variables ${runId}`,
              description: null,
              preview_asset_object_id: null,
              category_id: null,
              tag_ids: [],
              source_url: null,
              author: null,
              license_name: null,
              license_url: null,
              attribution: null,
              usage_restrictions: "Local E2E only",
            },
          },
        ),
        "create template",
      ),
    );
    fixture.templateId = template.template.id;
    const variablesRequestId = crypto.randomUUID();
    fixture.catalogRequestIds.push(variablesRequestId);
    const variables = [
      {
        key: "headline",
        label: "Headline",
        type: "text",
        required: true,
        target: { object_id: textObjectId, property: "text" },
      },
      {
        key: "headline_color",
        label: "Headline color",
        type: "color",
        required: false,
        target: { object_id: textObjectId, property: "fill" },
        default_value: "#ff3366",
      },
    ];
    await readJson(
      await request.put(
        `${serverURL}/api/admin/design-catalog/templates/${template.template.id}/variables`,
        {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: variablesRequestId,
            expected_revision: 0,
            variables,
          },
        },
      ),
      "save template variables",
    );
    const storedTemplate = designTemplateDetailDtoSchema.parse(
      await readJson(
        await request.get(
          `${serverURL}/api/design-templates/${template.template.id}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        ),
        "reload template variables",
      ),
    );
    expect(storedTemplate.template.variables).toEqual(variables);
    expect(storedTemplate.template.revision).toBe(1);

    const replaceInput = {
      design_id: designId,
      template_id: template.template.id,
      expected_revision: design.revision,
      expected_template_revision: 1,
      bindings: [{ key: "headline", type: "text", value: "Stage 7 persisted" }],
      smart_bindings: [],
    };
    const preview = readRecord(
      await readJson(
        await request.post(
          `${serverURL}/api/design-templates/${template.template.id}/replace-preview`,
          { headers: jsonHeaders(accessToken), data: replaceInput },
        ),
        "preview template replacement",
      ),
    );
    expect(readArray(preview.commands)).toHaveLength(1);
    expect(readArray(preview.commands)[0]).toMatchObject({
      action: "object.update",
    });
    expect(readArray(preview.differences)).toMatchObject([
      {
        variable_key: "headline",
        source: "binding",
        before: "Stage 7 before",
        after: "Stage 7 persisted",
      },
      { variable_key: "headline_color", source: "default" },
    ]);
    const applied = readRecord(
      await readJson(
        await request.post(
          `${serverURL}/api/design-templates/${template.template.id}/replace-apply`,
          {
            headers: jsonHeaders(accessToken),
            data: { ...replaceInput, idempotency_key: crypto.randomUUID() },
          },
        ),
        "apply template replacement",
      ),
    );
    expect(readRecord(applied.mutation).revision).toBe(design.revision + 1);
    await page.reload();
    design = await fetchDesign(request, accessToken, designId);
    expect(
      design.scene.objects.find((item) => item.objectId === textObjectId),
    ).toMatchObject({
      text: "Stage 7 persisted",
      fill: { kind: "solid", color: "#ff3366" },
    });

    const canvasBeforeExportDesign = canvasGetResponseSchema.parse(
      await readJson(
        await request.get(`${serverURL}/api/canvases/${canvasId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        "load canvas for export design",
      ),
    );
    const exportDesign = createDesignResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/designs`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: crypto.randomUUID(),
            canvas_id: canvasId,
            expected_canvas_revision: canvasBeforeExportDesign.canvas.revision,
            canvas_element_id: `stage7-export-${runId}`,
            name: `Stage 7 36MP Export ${runId}`,
            width: 3000,
            height: 3000,
            background: "#ffffff",
            node: { x: 800, y: 40, width: 600, height: 600 },
          },
        }),
        "create large export design",
      ),
    );
    const exportJob = readRecord(
      (
        await readJson(
          await request.post(
            `${serverURL}/api/designs/${exportDesign.design_id}/exports`,
            {
              headers: jsonHeaders(accessToken),
              data: {
                design_id: exportDesign.design_id,
                revision: exportDesign.design_revision,
                idempotency_key: crypto.randomUUID(),
                format: "png",
                multiplier: 2,
                transparent: false,
              },
            },
          ),
          "queue 36 MP export",
        )
      ).job,
    );
    const exportJobId = readString(exportJob.id);
    if (!exportJobId) throw new Error("Export job id missing.");
    fixture.jobIds.push(exportJobId);
    await page.reload();
    worker = await startWorker(runId, "export-recovery");
    const completedExport = await waitForJob(admin, exportJobId, 8 * 60_000);
    const exportResult = readRecord(completedExport.result);
    expect(exportResult).toMatchObject({
      width: 6000,
      height: 6000,
      format: "png",
    });
    const exportAssetId = readString(exportResult.asset_object_id);
    if (!exportAssetId) throw new Error("Export asset id missing.");
    fixture.assetIds.push(exportAssetId);
    const recoveredExport = readRecord(
      (
        await readJson(
          await request.get(`${serverURL}/api/jobs/${exportJobId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          "recover export job",
        )
      ).job,
    );
    const signedUrl = readString(readRecord(recoveredExport.result).signed_url);
    if (!signedUrl) throw new Error("Recovered export signed URL missing.");
    const downloaded = await request.get(signedUrl);
    expect(downloaded.ok()).toBe(true);
    expect(downloaded.headers()["content-type"]).toContain("image/png");
    expect((await downloaded.body()).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  } finally {
    if (worker) await stopWorker(worker);
    await cleanupFixture(admin, request, fixture);
  }
});

function textObject(objectId: string) {
  return {
    objectId,
    objectVersion: 1,
    type: "text",
    name: "Main headline",
    role: "title",
    x: 40,
    y: 30,
    width: 320,
    height: 70,
    rotation: 0,
    opacity: 1,
    zIndex: 0,
    locked: false,
    visible: true,
    text: "Stage 7 before",
    fontFamily: "Arial",
    fontSize: 42,
    fontWeight: 700,
    fontStyle: "normal",
    textAlign: "left",
    lineHeight: 1.2,
    charSpacing: 0,
    fill: { kind: "solid", color: "#111111" },
  };
}

function imageObject(objectId: string, assetObjectId: string) {
  return {
    objectId,
    objectVersion: 1,
    type: "image",
    name: "Product hero",
    role: "product",
    x: 80,
    y: 120,
    width: 320,
    height: 260,
    rotation: 0,
    opacity: 1,
    zIndex: 1,
    locked: false,
    visible: true,
    assetObjectId,
    fit: "cover",
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    mask: {
      shape: "rounded_rect",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      radius: 0.2,
    },
    filters: { brightness: 0.2, contrast: -0.1, saturation: 0.3, blur: 0.1 },
    stroke: { kind: "solid", color: "#2255ff" },
    strokeWidth: 4,
    shadow: {
      color: "#000000",
      blur: 12,
      offsetX: 3,
      offsetY: 5,
      opacity: 0.4,
    },
  };
}

async function mutateDesign(
  request: APIRequestContext,
  accessToken: string,
  designId: string,
  expectedRevision: number,
  commands: unknown[],
) {
  return readRecord(
    await readJson(
      await request.post(`${serverURL}/api/designs/${designId}/mutations`, {
        headers: jsonHeaders(accessToken),
        data: {
          design_id: designId,
          expected_revision: expectedRevision,
          idempotency_key: crypto.randomUUID(),
          commands,
        },
      }),
      "mutate design",
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
      "fetch design",
    ),
  ).design;
}

async function waitForJob(
  admin: ReturnType<typeof createClient>,
  jobId: string,
  timeout: number,
) {
  let row: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const result = await admin
          .from("background_jobs")
          .select("id,status,result,error_code,error_message")
          .eq("id", jobId)
          .maybeSingle();
        if (result.error) throw result.error;
        row = result.data as Record<string, unknown> | null;
        const status = readString(row?.status);
        if (["failed", "dead_letter", "canceled"].includes(status ?? "")) {
          throw new Error(
            `Job ${jobId} failed: ${readString(row?.error_code) ?? "unknown"} ${readString(row?.error_message) ?? ""}`,
          );
        }
        return status;
      },
      { timeout, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("succeeded");
  if (!row) throw new Error(`Job ${jobId} disappeared.`);
  return row;
}

async function startWorker(runId: string, phase: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "./src/worker.ts"],
    {
      cwd: new URL("../../server/", import.meta.url),
      env: {
        ...process.env,
        WORKER_ID: `stage7-${phase}-${runId.slice(0, 8)}`,
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
          new Error(`Stage 7 worker did not start: ${output.slice(-3_000)}`),
        ),
      30_000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("Started.")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(`Stage 7 worker exited before ready (${code}): ${output}`),
      );
    };
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

async function createLocalAccount(
  admin: ReturnType<typeof createClient>,
  runId: string,
) {
  const email = `stage7-${runId}@example.test`;
  const password = `Stage7-${crypto.randomUUID()}-aA1!`;
  const result = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (result.error || !result.data.user)
    throw result.error ?? new Error("Failed to create Stage 7 user.");
  return { email, password, userId: result.data.user.id };
}

async function login(page: Page, email: string, password: string) {
  const authResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/auth/v1/token"),
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await authResponse;
  expect(response.ok()).toBe(true);
  const token = readString(readRecord(await response.json()).access_token);
  if (!token) throw new Error("Stage 7 login token missing.");
  await expect(page).toHaveURL(/\/home(?:[/?#]|$)/u);
  return token;
}

type Fixture = {
  accessToken: string | null;
  actorUserId: string | null;
  createdAuthUserId: string | null;
  projectId: string | null;
  templateId: string | null;
  assetIds: string[];
  jobIds: string[];
  catalogRequestIds: string[];
};

async function cleanupFixture(
  admin: ReturnType<typeof createClient>,
  request: APIRequestContext,
  fixture: Fixture,
) {
  // Preview jobs are enqueued as a production side effect and therefore are
  // not all known to the test body. Resolve every disposable actor-owned job
  // before deleting the user so no FK can turn cleanup into a silent no-op.
  const actorJobs = fixture.actorUserId
    ? await admin
        .from("background_jobs")
        .select("id")
        .eq("created_by", fixture.actorUserId)
    : { data: [] };
  const allJobIds = [
    ...new Set([
      ...fixture.jobIds,
      ...(actorJobs.data ?? []).map((job) => job.id),
    ]),
  ];
  if (allJobIds.length > 0) {
    await admin.from("credit_transactions").delete().in("job_id", allJobIds);
    await admin.from("background_jobs").delete().in("id", allJobIds);
  }
  if (fixture.templateId) {
    await admin.from("design_templates").delete().eq("id", fixture.templateId);
  }
  if (fixture.projectId && fixture.accessToken) {
    const projectAssets = await admin
      .from("asset_objects")
      .select("id,bucket,object_path")
      .eq("project_id", fixture.projectId);
    for (const asset of projectAssets.data ?? []) {
      await admin.storage.from(asset.bucket).remove([asset.object_path]);
    }
    const designs = await admin
      .from("design_documents")
      .select("id")
      .eq("project_id", fixture.projectId);
    for (const design of designs.data ?? []) {
      await admin
        .from("design_preview_requests")
        .delete()
        .eq("design_id", design.id);
    }
    await request.delete(`${serverURL}/api/projects/${fixture.projectId}`, {
      headers: { Authorization: `Bearer ${fixture.accessToken}` },
    });
    // Project deletion can otherwise visit project-scoped asset cascades before
    // the design-reference cascades and be rejected by the asset RESTRICT FK.
    await admin
      .from("design_documents")
      .delete()
      .eq("project_id", fixture.projectId);
    await admin.from("projects").delete().eq("id", fixture.projectId);
  }
  for (const requestId of fixture.catalogRequestIds) {
    await admin
      .from("catalog_mutation_requests")
      .delete()
      .eq("request_id", requestId);
  }
  for (const assetId of [...new Set(fixture.assetIds)]) {
    const asset = await admin
      .from("asset_objects")
      .select("bucket,object_path")
      .eq("id", assetId)
      .maybeSingle();
    if (asset.data) {
      await admin.storage
        .from(asset.data.bucket)
        .remove([asset.data.object_path]);
    }
    await admin.from("asset_objects").delete().eq("id", assetId);
  }
  if (fixture.createdAuthUserId) {
    const deleted = await admin.auth.admin.deleteUser(
      fixture.createdAuthUserId,
    );
    if (deleted.error) throw deleted.error;
  }
}

async function readJson(response: APIResponse, operation: string) {
  if (!response.ok()) {
    throw new Error(
      `${operation} failed (${response.status()}): ${await response.text()}`,
    );
  }
  return response.json();
}

function jsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assertLocalEnvironment() {
  for (const [name, value] of [
    ["LOOMIC_E2E_SERVER_URL", serverURL],
    ["SUPABASE_URL", supabaseURL],
    ["SUPABASE_DB_URL", databaseURL],
  ] as const) {
    if (!value) throw new Error(`${name} is required for Stage 7 E2E.`);
    if (!["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname)) {
      throw new Error(`${name} must target the disposable local stack.`);
    }
  }
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for cleanup.");
  }
}
