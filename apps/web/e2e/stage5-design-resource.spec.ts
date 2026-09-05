import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CanvasGetResponse,
  type DesignCatalogEntityKind,
  type DesignImportItemDto,
  canvasGetResponseSchema,
  createDesignImportResponseSchema,
  createDesignResponseSchema,
  designCatalogMutationResponseSchema,
  designGetResponseSchema,
  designImportItemDtoSchema,
  designImportJobDtoSchema,
  designResourceDtoSchema,
  designTemplateDetailDtoSchema,
  projectCreateResponseSchema,
  uploadResponseSchema,
} from "@loomic/shared";
import {
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const serverURL = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
const supabaseURL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const email = process.env.LOOMIC_E2E_EMAIL;
const password = process.env.LOOMIC_E2E_PASSWORD;

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const FONT_FIXTURE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../skills/canvas-design/canvas-fonts/GeistMono-Regular.ttf",
  ),
);

test("Stage 5 inserts a real catalog resource and clones it through a template", async ({
  page,
  request,
}) => {
  assertLocalFixtureEnvironment();
  if (!email || !password) {
    throw new Error(
      "Set LOOMIC_E2E_EMAIL and LOOMIC_E2E_PASSWORD for a seeded local test account.",
    );
  }

  const cleanup: LocalFixtureCleanup = {
    assetObjectId: null,
    projectId: null,
    resourceId: null,
    resourceCreateRequestId: null,
    templateId: null,
    templateCreateRequestId: null,
    catalogRequestIds: [],
  };
  const runId = crypto.randomUUID();
  const resourceName = `stage5-resource-${runId}`;
  const templateName = `stage5-template-${runId}`;

  try {
    const accessToken = await loginSeededUser(page, email, password);

    const projectResponse = await request.post(`${serverURL}/api/projects`, {
      headers: jsonHeaders(accessToken),
      data: {
        name: `Stage 5 E2E ${runId}`,
        description: "Disposable local Stage 5 browser acceptance fixture.",
      },
    });
    const project = projectCreateResponseSchema.parse(
      await readJson(projectResponse, "create project"),
    ).project;
    cleanup.projectId = project.id;
    const canvasId = project.primaryCanvas.id;
    const workspaceId = project.workspace.id;

    const uploadResponse = await request.post(`${serverURL}/api/uploads`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      multipart: {
        file: {
          name: `${resourceName}.png`,
          mimeType: "image/png",
          buffer: PNG_FIXTURE,
        },
      },
    });
    const uploaded = uploadResponseSchema.parse(
      await readJson(uploadResponse, "upload resource image"),
    );
    cleanup.assetObjectId = uploaded.asset.id;

    const resourceCreateRequestId = crypto.randomUUID();
    cleanup.resourceCreateRequestId = resourceCreateRequestId;
    cleanup.catalogRequestIds.push(resourceCreateRequestId);
    const resourceResponse = await request.post(
      `${serverURL}/api/admin/design-catalog/resources`,
      {
        headers: jsonHeaders(accessToken),
        data: {
          request_id: resourceCreateRequestId,
          scope: "workspace",
          workspace_id: workspaceId,
          kind: "image",
          name: resourceName,
          description: "Stage 5 real upload browser fixture.",
          asset_object_id: uploaded.asset.id,
          preview_asset_object_id: uploaded.asset.id,
          category_id: null,
          tag_ids: [],
          source_url: null,
          author: null,
          license_name: "Test fixture",
          license_url: null,
          attribution: null,
          usage_restrictions: "Local automated test use only",
        },
      },
    );
    const resource = designResourceDtoSchema.parse(
      await readJson(resourceResponse, "create workspace resource"),
    );
    cleanup.resourceId = resource.id;
    const resourceRevision = await publishCatalogEntry(
      request,
      accessToken,
      "resource",
      resource.id,
      resource.revision,
      cleanup.catalogRequestIds,
    );
    expect(resourceRevision).toBe(resource.revision + 2);

    const initialCanvas = await fetchCanvas(request, accessToken, canvasId);
    const originalCreateResponse = await request.post(
      `${serverURL}/api/designs`,
      {
        headers: jsonHeaders(accessToken),
        data: {
          request_id: crypto.randomUUID(),
          canvas_id: canvasId,
          expected_canvas_revision: initialCanvas.canvas.revision,
          canvas_element_id: `stage5-design-${runId}`,
          name: "Stage 5 resource source",
          width: 640,
          height: 360,
          background: "#ffffff",
          node: { x: 0, y: 0, width: 640, height: 360 },
        },
      },
    );
    const originalDesign = createDesignResponseSchema.parse(
      await readJson(originalCreateResponse, "create source design"),
    );

    await page.goto(`/canvas?id=${encodeURIComponent(canvasId)}`);
    const editor = page.getByTestId("canvas-editor");
    await expect(editor).toBeVisible();
    const dialog = await openSelectedDesign(editor, originalDesign.design_id);

    const resourceSearchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/design-resources" &&
        new URL(response.url()).searchParams.get("query") === resourceName,
    );
    await dialog.getByPlaceholder("搜索名称、标签或分类").fill(resourceName);
    expect((await resourceSearchResponse).ok()).toBe(true);
    const resourceCard = dialog
      .locator("article")
      .filter({ hasText: resourceName });
    await expect(resourceCard).toHaveCount(1);

    const contentResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/design-resources/${resource.id}/content`,
    );
    const recentResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/design-resources/${resource.id}/recent`,
    );
    await resourceCard.getByRole("button").first().click();
    expect((await contentResponse).ok()).toBe(true);
    expect((await recentResponse).ok()).toBe(true);

    const saveButton = dialog.getByRole("button", {
      name: "保存",
      exact: true,
    });
    await expect(saveButton).toBeEnabled();
    const saveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/designs/${originalDesign.design_id}/mutations`,
    );
    await saveButton.click();
    expect((await saveResponse).ok()).toBe(true);

    const savedSource = await fetchDesign(
      request,
      accessToken,
      originalDesign.design_id,
    );
    const inserted = savedSource.scene.objects.find(
      (object) => object.type === "image" && object.resourceId === resource.id,
    );
    expect(inserted).toMatchObject({
      assetObjectId: uploaded.asset.id,
      resourceId: resource.id,
    });
    const originalObjectId = inserted?.objectId;
    expect(originalObjectId).toBeTruthy();

    await closeDesign(page, originalDesign.design_id);
    await page.reload();
    const reloadedEditor = page.getByTestId("canvas-editor");
    await expect(reloadedEditor).toBeVisible();
    await openSelectedDesign(reloadedEditor, originalDesign.design_id);
    const reopenedSource = await fetchDesign(
      request,
      accessToken,
      originalDesign.design_id,
    );
    expect(
      reopenedSource.scene.objects.find(
        (object) => object.objectId === originalObjectId,
      ),
    ).toMatchObject({
      assetObjectId: uploaded.asset.id,
      resourceId: resource.id,
    });
    await closeDesign(page, originalDesign.design_id);

    const templateCreateRequestId = crypto.randomUUID();
    cleanup.templateCreateRequestId = templateCreateRequestId;
    cleanup.catalogRequestIds.push(templateCreateRequestId);
    const templateResponse = await request.post(
      `${serverURL}/api/admin/design-catalog/templates/from-design`,
      {
        headers: jsonHeaders(accessToken),
        data: {
          request_id: templateCreateRequestId,
          design_id: originalDesign.design_id,
          scope: "workspace",
          workspace_id: workspaceId,
          name: templateName,
          description: "Stage 5 template clone browser fixture.",
          preview_asset_object_id: uploaded.asset.id,
          category_id: null,
          tag_ids: [],
          source_url: null,
          author: null,
          license_name: "Test fixture",
          license_url: null,
          attribution: null,
          usage_restrictions: "Local automated test use only",
        },
      },
    );
    const template = designTemplateDetailDtoSchema.parse(
      await readJson(templateResponse, "create template from design"),
    );
    cleanup.templateId = template.template.id;
    await publishCatalogEntry(
      request,
      accessToken,
      "template",
      template.template.id,
      template.template.revision,
      cleanup.catalogRequestIds,
    );

    const templateListResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/design-templates",
    );
    await editor.getByRole("button", { name: "设计画板" }).click();
    expect((await templateListResponse).ok()).toBe(true);
    const createPanel = page.getByRole("form", { name: "创建空白设计" });
    await createPanel
      .getByRole("button", { name: "模板", exact: true })
      .click();
    const templateCard = createPanel
      .getByRole("button")
      .filter({ hasText: templateName });
    await expect(templateCard).toHaveCount(1);
    await templateCard.click();

    const clonedCreateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/designs",
    );
    await createPanel
      .getByRole("button", { name: "使用模板创建", exact: true })
      .click();
    const clonedDesign = createDesignResponseSchema.parse(
      await (await clonedCreateResponse).json(),
    );
    expect(clonedDesign.design_id).not.toBe(originalDesign.design_id);

    await expect
      .poll(async () => {
        const canvas = await fetchCanvas(request, accessToken, canvasId);
        return liveDesignIds(canvas).sort();
      })
      .toEqual([originalDesign.design_id, clonedDesign.design_id].sort());

    const cloned = await fetchDesign(
      request,
      accessToken,
      clonedDesign.design_id,
    );
    const clonedResourceObject = cloned.scene.objects.find(
      (object) => object.type === "image" && object.resourceId === resource.id,
    );
    expect(clonedResourceObject).toMatchObject({
      assetObjectId: uploaded.asset.id,
      resourceId: resource.id,
    });
    expect(clonedResourceObject?.objectId).not.toBe(originalObjectId);
    expect(
      new Set(cloned.scene.objects.map((object) => object.objectId)),
    ).not.toContain(originalObjectId);

    await openSelectedDesign(editor, clonedDesign.design_id);
    await closeDesign(page, clonedDesign.design_id);
    await page.reload();
    const finalEditor = page.getByTestId("canvas-editor");
    await expect(finalEditor).toBeVisible();
    await openSelectedDesign(finalEditor, clonedDesign.design_id);
    const persistedClone = await fetchDesign(
      request,
      accessToken,
      clonedDesign.design_id,
    );
    expect(
      persistedClone.scene.objects.find(
        (object) => object.objectId === clonedResourceObject?.objectId,
      ),
    ).toMatchObject({
      assetObjectId: uploaded.asset.id,
      resourceId: resource.id,
    });
  } finally {
    await cleanupLocalFixture(cleanup);
  }
});

test("Stage 5 reopens a persisted custom font in a fresh browser document", async ({
  page,
  request,
}) => {
  assertLocalFixtureEnvironment();
  if (!email || !password)
    throw new Error("Seeded local E2E account is required.");
  const cleanup: LocalFixtureCleanup = {
    assetObjectId: null,
    projectId: null,
    resourceId: null,
    resourceCreateRequestId: null,
    templateId: null,
    templateCreateRequestId: null,
    catalogRequestIds: [],
    fontFaceId: null,
    fontFamilyId: null,
  };
  const runId = crypto.randomUUID();
  const familyName = `Stage5Font-${runId}`;
  try {
    const accessToken = await loginSeededUser(page, email, password);
    const projectResponse = await request.post(`${serverURL}/api/projects`, {
      headers: jsonHeaders(accessToken),
      data: {
        name: `Stage 5 font ${runId}`,
        description: "Disposable font fixture.",
      },
    });
    const project = projectCreateResponseSchema.parse(
      await readJson(projectResponse, "create font project"),
    ).project;
    cleanup.projectId = project.id;

    const uploadResponse = await request.post(
      `${serverURL}/api/admin/design-catalog/font-files`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        multipart: {
          workspace_id: project.workspace.id,
          file: {
            name: "GeistMono-Regular.ttf",
            mimeType: "font/ttf",
            buffer: FONT_FIXTURE,
          },
        },
      },
    );
    const uploaded = readFontFileUpload(
      await readJson(uploadResponse, "upload font"),
    );
    cleanup.assetObjectId = uploaded.asset_object_id;

    const familyRequestId = crypto.randomUUID();
    cleanup.catalogRequestIds.push(familyRequestId);
    const familyMutation = designCatalogMutationResponseSchema.parse(
      await readJson(
        await request.post(
          `${serverURL}/api/admin/design-catalog/font-families`,
          {
            headers: jsonHeaders(accessToken),
            data: {
              request_id: familyRequestId,
              scope: "workspace",
              workspace_id: project.workspace.id,
              name: familyName,
              source_url: null,
              author: "Loomic E2E",
              license_name: "Test fixture",
              license_url: null,
              attribution: "Local automated browser fixture",
              usage_restrictions: "Local automated test use only",
            },
          },
        ),
        "create font family",
      ),
    );
    cleanup.fontFamilyId = familyMutation.entity_id;

    const faceRequestId = crypto.randomUUID();
    cleanup.catalogRequestIds.push(faceRequestId);
    const faceMutation = designCatalogMutationResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/admin/design-catalog/font-faces`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: faceRequestId,
            scope: "workspace",
            workspace_id: project.workspace.id,
            family_id: familyMutation.entity_id,
            asset_object_id: uploaded.asset_object_id,
            style: uploaded.style,
            weight: uploaded.weight,
            format: uploaded.format,
            checksum_sha256: uploaded.checksum_sha256,
            allow_web_embed: uploaded.allow_web_embed,
          },
        }),
        "create font face",
      ),
    );
    cleanup.fontFaceId = faceMutation.entity_id;
    await publishCatalogEntry(
      request,
      accessToken,
      "font_face",
      faceMutation.entity_id,
      faceMutation.revision,
      cleanup.catalogRequestIds,
    );
    await publishCatalogEntry(
      request,
      accessToken,
      "font_family",
      familyMutation.entity_id,
      familyMutation.revision,
      cleanup.catalogRequestIds,
    );

    const initialCanvas = await fetchCanvas(
      request,
      accessToken,
      project.primaryCanvas.id,
    );
    const createResponse = createDesignResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/designs`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: crypto.randomUUID(),
            canvas_id: project.primaryCanvas.id,
            expected_canvas_revision: initialCanvas.canvas.revision,
            canvas_element_id: `stage5-font-design-${runId}`,
            name: "Stage 5 font source",
            width: 640,
            height: 360,
            background: "#ffffff",
            node: { x: 0, y: 0, width: 640, height: 360 },
          },
        }),
        "create font design",
      ),
    );
    await readJson(
      await request.post(
        `${serverURL}/api/designs/${createResponse.design_id}/mutations`,
        {
          headers: jsonHeaders(accessToken),
          data: {
            design_id: createResponse.design_id,
            expected_revision: createResponse.design_revision,
            idempotency_key: crypto.randomUUID(),
            commands: [
              {
                action: "object.add",
                object: {
                  objectId: crypto.randomUUID(),
                  objectVersion: 1,
                  type: "text",
                  name: "Custom font title",
                  x: 40,
                  y: 40,
                  width: 480,
                  height: 80,
                  rotation: 0,
                  opacity: 1,
                  visible: true,
                  locked: false,
                  zIndex: 0,
                  text: "Custom font survives reopen",
                  fontFaceId: faceMutation.entity_id,
                  fontFamily: familyName,
                  fontSize: 48,
                  fontWeight: 400,
                  fontStyle: "normal",
                  textAlign: "left",
                  lineHeight: 1.2,
                  charSpacing: 0,
                  fill: { kind: "solid", color: "#111111" },
                },
              },
            ],
          },
        },
      ),
      "persist font text object",
    );

    await page.goto(
      `/canvas?id=${encodeURIComponent(project.primaryCanvas.id)}`,
    );
    const fontResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/design-fonts/faces/${faceMutation.entity_id}/content`,
    );
    await openSelectedDesign(
      page.getByTestId("canvas-editor"),
      createResponse.design_id,
    );
    expect((await fontResponse).ok()).toBe(true);
    expect(
      await page.evaluate(
        (family) => document.fonts.check(`400 48px "${family}"`),
        familyName,
      ),
    ).toBe(true);

    const reopenedPage = await page.context().newPage();
    await reopenedPage.goto(
      `/canvas?id=${encodeURIComponent(project.primaryCanvas.id)}`,
    );
    const reopenedFontResponse = reopenedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/design-fonts/faces/${faceMutation.entity_id}/content`,
    );
    const reopenedDialog = await openSelectedDesign(
      reopenedPage.getByTestId("canvas-editor"),
      createResponse.design_id,
    );
    expect((await reopenedFontResponse).ok()).toBe(true);
    await expect(reopenedDialog.getByText(/个字体未正确加载/)).toHaveCount(0);
    expect(
      await reopenedPage.evaluate(
        (family) => document.fonts.check(`400 48px "${family}"`),
        familyName,
      ),
    ).toBe(true);
    await reopenedPage.close();
  } finally {
    await cleanupLocalFixture(cleanup);
  }
});

test("Stage 5 imports a mixed ZIP package and shows its completed report", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  assertLocalFixtureEnvironment();
  if (!email || !password)
    throw new Error("Seeded local E2E account is required.");
  const runId = crypto.randomUUID();
  const categoryKey = `category/stage5-${runId}`;
  const tagKey = `tag/stage5-${runId}`;
  const resourceKey = `resource/stage5-${runId}.png`;
  let projectId: string | null = null;
  let importJobId: string | null = null;
  let accessToken: string | null = null;
  let worker: ChildProcess | null = null;
  let reportItems: DesignImportItemDto[] = [];

  try {
    accessToken = await loginSeededUser(page, email, password);
    const project = projectCreateResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/projects`, {
          headers: jsonHeaders(accessToken),
          data: {
            name: `Stage 5 import ${runId}`,
            description: "Disposable mixed ZIP import fixture.",
          },
        }),
        "create import project",
      ),
    ).project;
    projectId = project.id;

    const manifest = {
      version: 1,
      items: [
        {
          source_key: categoryKey,
          entity_kind: "category",
          payload: {
            parent_id: null,
            name: `Stage5 category ${runId}`,
            slug: `stage5-category-${runId}`,
            sort_order: 0,
          },
        },
        {
          source_key: tagKey,
          entity_kind: "tag",
          payload: {
            name: `Stage5 tag ${runId}`,
            slug: `stage5-tag-${runId}`,
          },
        },
        {
          source_key: resourceKey,
          entity_kind: "resource",
          path: "pixel.png",
          depends_on: [categoryKey, tagKey],
          payload: {
            name: `Stage5 imported resource ${runId}`,
            category_path: categoryKey,
            tag_paths: [tagKey],
            license_name: "Test fixture",
            usage_restrictions: "Local automated test use only",
          },
        },
      ],
    };
    const zip = createStoredZip([
      { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
      { path: "pixel.png", data: PNG_FIXTURE },
    ]);

    worker = await startImportWorker(runId);
    await page.goto("/admin");
    await page.getByRole("button", { name: "设计资源" }).click();
    await expect(
      page.getByRole("heading", { name: "资源目录", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "批量导入" }).click();
    await page.getByLabel("ZIP/JSON 清单包").setInputFiles({
      name: `stage5-${runId}.zip`,
      mimeType: "application/zip",
      buffer: zip,
    });
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          "/api/admin/design-catalog/imports",
    );
    await page.getByRole("button", { name: "创建导入任务" }).click();
    const createResponse = await createResponsePromise;
    const created = createDesignImportResponseSchema.parse(
      await readJson(createResponse, "create ZIP import"),
    );
    importJobId = created.import_job_id;

    const jobRow = page
      .locator("tbody tr")
      .filter({ hasText: importJobId.slice(0, 8) });
    await expect(jobRow).toContainText("3/3", { timeout: 45_000 });
    await expect(jobRow).toContainText("completed");
    await jobRow.getByRole("button", { name: "报告" }).click();
    const reportDialog = page.getByRole("dialog");
    await expect(reportDialog.getByText("完成 3，失败 0")).toBeVisible();
    for (const sourceKey of [categoryKey, tagKey, resourceKey]) {
      await expect(
        reportDialog.getByText(sourceKey, { exact: true }),
      ).toBeVisible();
    }

    const reportResponse = await request.get(
      `${serverURL}/api/admin/design-catalog/imports/${importJobId}/report`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const rawReport = await readJson(reportResponse, "read ZIP import report");
    if (!isRecord(rawReport) || !Array.isArray(rawReport.items))
      throw new Error("Import report response was malformed.");
    expect(designImportJobDtoSchema.parse(rawReport.job).status).toBe(
      "completed",
    );
    reportItems = rawReport.items.map((item) =>
      designImportItemDtoSchema.parse(item),
    );
    expect(reportItems).toHaveLength(3);
    expect(reportItems.every((item) => item.status === "imported")).toBe(true);
  } finally {
    if (worker) await stopImportWorker(worker);
    await cleanupMixedImportFixture({
      importJobId,
      projectId,
      reportItems,
    });
  }
});

async function startImportWorker(runId: string): Promise<ChildProcess> {
  const serverRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../server",
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "./src/worker.ts"],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        WORKER_ID: `stage5-import-${runId.slice(0, 8)}`,
        WORKER_POLL_INTERVAL_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Import worker did not start in time: ${output}`));
    }, 30_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolveReady();
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("Started.")) finish();
    };
    const onExit = (code: number | null) =>
      finish(new Error(`Import worker exited (${code}): ${output}`));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
  return child;
}

async function stopImportWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 10_000)),
  ]);
}

function createStoredZip(entries: Array<{ path: string; data: Buffer }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function cleanupMixedImportFixture(input: {
  importJobId: string | null;
  projectId: string | null;
  reportItems: DesignImportItemDto[];
}) {
  const byKind = (kind: DesignCatalogEntityKind) =>
    input.reportItems.filter(
      (item) => item.result_entity_kind === kind && item.result_entity_id,
    );
  for (const item of byKind("resource")) {
    await expectLocalRestDelete(
      "design_resources",
      "id",
      item.result_entity_id as string,
    );
  }
  for (const item of byKind("category")) {
    await expectLocalRestDelete(
      "resource_categories",
      "id",
      item.result_entity_id as string,
    );
  }
  for (const item of byKind("tag")) {
    await expectLocalRestDelete(
      "resource_tags",
      "id",
      item.result_entity_id as string,
    );
  }
  const assetIds = new Set(
    input.reportItems.flatMap((item) =>
      item.asset_object_id ? [item.asset_object_id] : [],
    ),
  );
  if (input.importJobId)
    await expectLocalRestDelete(
      "resource_import_jobs",
      "id",
      input.importJobId,
    );
  if (input.projectId)
    await expectLocalRestDelete("projects", "id", input.projectId);
  for (const assetId of assetIds) await expectLocalAssetDelete(assetId);
}

async function publishCatalogEntry(
  request: APIRequestContext,
  accessToken: string,
  entityKind: DesignCatalogEntityKind,
  entityId: string,
  initialRevision: number,
  cleanupRequestIds: string[],
): Promise<number> {
  let revision = initialRevision;
  for (const status of ["pending_review", "published"] as const) {
    const requestId = crypto.randomUUID();
    cleanupRequestIds.push(requestId);
    const response = await request.post(
      `${serverURL}/api/admin/design-catalog/status`,
      {
        headers: jsonHeaders(accessToken),
        data: {
          request_id: requestId,
          entity_kind: entityKind,
          entity_id: entityId,
          expected_revision: revision,
          status,
        },
      },
    );
    const mutation = designCatalogMutationResponseSchema.parse(
      await readJson(response, `set ${entityKind} status to ${status}`),
    );
    expect(mutation).toMatchObject({
      entity_kind: entityKind,
      entity_id: entityId,
      status,
      replayed: false,
    });
    revision = mutation.revision;
  }
  return revision;
}

async function loginSeededUser(
  page: Page,
  loginEmail: string,
  loginPassword: string,
): Promise<string> {
  const authResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/auth/v1/token"),
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(loginEmail);
  await page.getByLabel("Password").fill(loginPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const authResponse = await authResponsePromise;
  expect(authResponse.ok()).toBe(true);
  const accessToken = readAccessToken(await authResponse.json());
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    ),
  );
  await page.goto("/home", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/home(?:[/?#]|$)/u);
  return accessToken;
}

async function openSelectedDesign(
  editor: Locator,
  designId: string,
): Promise<Locator> {
  const page = editor.page();
  const preview = page.locator(
    `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
  );
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.dblclick(
    (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
    (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
  );
  const dialog = page.locator(`dialog[data-design-id="${designId}"]`);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDesign(page: Page, designId: string): Promise<void> {
  const dialog = page.locator(`dialog[data-design-id="${designId}"]`);
  await dialog.getByRole("button", { name: "返回画布" }).click();
  await expect(dialog).toBeHidden();
}

async function fetchCanvas(
  request: APIRequestContext,
  accessToken: string,
  canvasId: string,
): Promise<CanvasGetResponse> {
  const response = await request.get(
    `${serverURL}/api/canvases/${encodeURIComponent(canvasId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return canvasGetResponseSchema.parse(await readJson(response, "get canvas"));
}

async function fetchDesign(
  request: APIRequestContext,
  accessToken: string,
  designId: string,
) {
  const response = await request.get(
    `${serverURL}/api/designs/${encodeURIComponent(designId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return designGetResponseSchema.parse(await readJson(response, "get design"))
    .design;
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

function readAccessToken(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { access_token?: unknown }).access_token !== "string"
  ) {
    throw new Error("Supabase login response did not contain an access token.");
  }
  return (value as { access_token: string }).access_token;
}

function readFontFileUpload(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.asset_object_id !== "string" ||
    typeof value.family_name !== "string" ||
    (value.style !== "normal" && value.style !== "italic") ||
    typeof value.weight !== "number" ||
    (value.format !== "woff" &&
      value.format !== "ttf" &&
      value.format !== "otf") ||
    typeof value.checksum_sha256 !== "string" ||
    typeof value.allow_web_embed !== "boolean"
  ) {
    throw new Error("Font upload response was malformed.");
  }
  return {
    asset_object_id: value.asset_object_id,
    family_name: value.family_name,
    style: value.style,
    weight: value.weight,
    format: value.format,
    checksum_sha256: value.checksum_sha256,
    allow_web_embed: value.allow_web_embed,
  };
}

function liveDesignIds(canvas: CanvasGetResponse): string[] {
  return canvas.canvas.content.elements.flatMap((element) => {
    if (element.isDeleted === true || !isRecord(element.customData)) return [];
    return element.customData.kind === "loomic-design" &&
      typeof element.customData.designId === "string"
      ? [element.customData.designId]
      : [];
  });
}

type LocalFixtureCleanup = {
  assetObjectId: string | null;
  projectId: string | null;
  resourceId: string | null;
  resourceCreateRequestId: string | null;
  templateId: string | null;
  templateCreateRequestId: string | null;
  catalogRequestIds: string[];
  fontFaceId?: string | null;
  fontFamilyId?: string | null;
};

async function cleanupLocalFixture(fixture: LocalFixtureCleanup) {
  // Production catalog deletion intentionally preserves referenced objects. The
  // service-role is used only after this local-only test to purge its exact IDs;
  // all behavior under test still travels through the public production APIs.
  const templateId =
    fixture.templateId ??
    (await resolveCatalogCreateId(fixture.templateCreateRequestId, "template"));
  const resourceId =
    fixture.resourceId ??
    (await resolveCatalogCreateId(fixture.resourceCreateRequestId, "resource"));
  if (templateId) {
    await expectLocalRestDelete("design_templates", "id", templateId);
  }
  if (fixture.projectId) {
    await expectLocalRestDelete("projects", "id", fixture.projectId);
  }
  if (resourceId) {
    await expectLocalRestDelete("design_resources", "id", resourceId);
  }
  if (fixture.fontFaceId)
    await expectLocalRestDelete("font_faces", "id", fixture.fontFaceId);
  if (fixture.fontFamilyId)
    await expectLocalRestDelete("font_families", "id", fixture.fontFamilyId);
  if (fixture.assetObjectId) {
    await expectLocalAssetDelete(fixture.assetObjectId);
  }
  for (const requestId of fixture.catalogRequestIds) {
    await expectLocalRestDelete(
      "catalog_mutation_requests",
      "request_id",
      requestId,
    );
  }
}

async function resolveCatalogCreateId(
  requestId: string | null,
  entityKind: "resource" | "template",
): Promise<string | null> {
  if (!requestId) return null;
  const admin = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin
    .from("catalog_mutation_requests")
    .select("entity_kind, result")
    .eq("request_id", requestId)
    .maybeSingle();
  expect
    .soft(!error, `local E2E catalog cleanup lookup failed: ${error?.message}`)
    .toBe(true);
  if (!data || data.entity_kind !== entityKind || !isRecord(data.result)) {
    return null;
  }
  return typeof data.result.entity_id === "string"
    ? data.result.entity_id
    : null;
}

async function expectLocalAssetDelete(assetObjectId: string) {
  const admin = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: asset, error: queryError } = await admin
    .from("asset_objects")
    .select("bucket, object_path")
    .eq("id", assetObjectId)
    .maybeSingle();
  expect
    .soft(!queryError, `local E2E asset lookup failed: ${queryError?.message}`)
    .toBe(true);
  if (!asset) return;
  const { error: rowError } = await admin
    .from("asset_objects")
    .delete()
    .eq("id", assetObjectId);
  expect
    .soft(!rowError, `local E2E asset row cleanup failed: ${rowError?.message}`)
    .toBe(true);
  if (rowError) return;
  const { error: storageError } = await admin.storage
    .from(asset.bucket)
    .remove([asset.object_path]);
  expect
    .soft(
      !storageError,
      `local E2E storage cleanup failed: ${storageError?.message}`,
    )
    .toBe(true);
}

async function expectLocalRestDelete(
  table:
    | "catalog_mutation_requests"
    | "design_resources"
    | "design_templates"
    | "font_faces"
    | "font_families"
    | "resource_categories"
    | "resource_import_jobs"
    | "resource_tags"
    | "projects",
  column: "id" | "request_id",
  value: string,
) {
  const url = new URL(`/rest/v1/${table}`, supabaseURL);
  url.searchParams.set(column, `eq.${value}`);
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
  });
  expect
    .soft(
      response.ok,
      `local E2E ${table} cleanup failed (${response.status}): ${await response.text()}`,
    )
    .toBe(true);
}

function assertLocalFixtureEnvironment() {
  for (const [name, value] of [
    ["LOOMIC_E2E_SERVER_URL", serverURL],
    ["SUPABASE_URL", supabaseURL],
  ] as const) {
    if (!value) throw new Error(`${name} is required for the Stage 5 E2E.`);
    const hostname = new URL(value).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error(
        `${name} must point to a local stack because this E2E purges its fixtures.`,
      );
    }
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to purge exact local E2E fixture rows.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
