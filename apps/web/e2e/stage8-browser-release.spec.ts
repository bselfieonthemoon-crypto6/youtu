import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canvasGetResponseSchema,
  createDesignResponseSchema,
  designCatalogMutationResponseSchema,
  designGetResponseSchema,
  designResourceDtoSchema,
  projectCreateResponseSchema,
  uploadResponseSchema,
} from "@loomic/shared";
import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const serverURL = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
const webURL = process.env.LOOMIC_E2E_BASE_URL ?? "http://localhost:3000";
const supabaseURL =
  process.env.LOOMIC_E2E_SUPABASE_URL ??
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "";
const serviceRoleKey =
  process.env.LOOMIC_E2E_SUPABASE_ADMIN_KEY ??
  process.env.LOOMIC_E2E_SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "";
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zx7sAAAAASUVORK5CYII=",
  "base64",
);
const FONT_FIXTURE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../skills/canvas-design/canvas-fonts/GeistMono-Regular.ttf",
      import.meta.url,
    ),
  ),
);

test("double-click opens the hit design instead of a stale selected design", async ({
  page,
  request,
}) => {
  assertLocalEnvironment();
  const runId = crypto.randomUUID();
  const fixture: Fixture = emptyFixture();
  const admin = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const account = await createLocalAccount(admin, `double-click-${runId}`);
    fixture.authUserId = account.userId;
    const accessToken = await login(page, account.email, account.password);
    fixture.accessToken = accessToken;
    const project = projectCreateResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/projects`, {
          headers: jsonHeaders(accessToken),
          data: { name: `Stage 8 double-click ${runId}` },
        }),
        "create double-click project",
      ),
    ).project;
    fixture.projectId = project.id;
    const first = await createDesign(
      request,
      accessToken,
      project.primaryCanvas.id,
      `stage8-double-a-${runId}`,
      "Stage 8 design A",
      { x: 80, y: 80, width: 320, height: 180 },
    );
    const second = await createDesign(
      request,
      accessToken,
      project.primaryCanvas.id,
      `stage8-double-b-${runId}`,
      "Stage 8 design B",
      { x: 460, y: 80, width: 320, height: 180 },
    );
    await page.goto(`/canvas?id=${project.primaryCanvas.id}`);
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    console.log("[stage8] two-design canvas hydrated");
    await clickDesignPreview(page, first.design_id);
    await expect(page.getByRole("button", { name: "打开设计" })).toBeVisible();
    const secondDialog = await openDesign(page, second.design_id);
    await expect(secondDialog).toContainText("Stage 8 design B");
  } finally {
    await cleanupFixture(admin, request, fixture);
  }
});

test("Stage 8 exercises the non-paid release stress and recovery matrix", async ({
  context,
  page,
  request,
}, testInfo) => {
  test.setTimeout(12 * 60_000);
  assertLocalEnvironment();
  const runId = crypto.randomUUID();
  const fixture: Fixture = emptyFixture();
  const admin = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let secondPage: Page | null = null;

  try {
    const account = await createLocalAccount(admin, runId);
    fixture.authUserId = account.userId;
    const accessToken = await login(page, account.email, account.password);
    fixture.accessToken = accessToken;

    const project = projectCreateResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/projects`, {
          headers: jsonHeaders(accessToken),
          data: {
            name: `Stage 8 Release ${runId}`,
            description: "Disposable local non-paid browser release fixture.",
          },
        }),
        "create Stage 8 project",
      ),
    ).project;
    fixture.projectId = project.id;
    const canvasId = project.primaryCanvas.id;

    // Warm both Next and the browser before taking the baseline. This keeps
    // route compilation/cache growth separate from the 1,100-node fixture.
    await page.goto(`/canvas?id=${canvasId}`);
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    console.log("[stage8] 1,000 images and 100 design previews hydrated");
    const memory: MemoryEvidence = {
      nextBaselineBytes: readListeningProcessMemory(new URL(webURL).port),
      browserBaseline: await readBrowserMemory(context, page),
      nextAfterStressBytes: null,
      browserAfterStress: null,
      nextAfterCyclesBytes: null,
      browserAfterCycles: null,
      measuredPanFps: null,
      panViewportDeltaPx: null,
      panFrameCount: null,
      panLongTaskCount: null,
      panLongTaskTotalMs: null,
    };

    await page.getByRole("button", { name: "设计画板" }).click();
    const createPanel = page.getByRole("form", { name: "创建空白设计" });
    await createPanel.getByLabel("设计宽度").fill("0");
    await createPanel.getByLabel("设计高度").fill("32769");
    await createPanel.getByRole("button", { name: "创建设计" }).click();
    await expect(createPanel).toContainText("宽高必须是 1–32768 的整数像素");
    await createPanel.getByRole("button", { name: "关闭" }).click();
    // Unmount the warmed editor before API seeding. Otherwise its stale local
    // scene can autosave after the fixture PUT and overwrite the stress data.
    await page.goto("/home");

    const uploaded = uploadResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/uploads`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          multipart: {
            file: {
              name: `stage8-pixel-${runId}.png`,
              mimeType: "image/png",
              buffer: PNG_FIXTURE,
            },
          },
        }),
        "upload Stage 8 image",
      ),
    );
    fixture.assetId = uploaded.asset.id;
    const workspaceResourceName = `Stage 8 workspace resource ${runId}`;
    const resourceCreateRequestId = crypto.randomUUID();
    fixture.resourceCreateRequestId = resourceCreateRequestId;
    fixture.catalogRequestIds.push(resourceCreateRequestId);
    const workspaceResource = designResourceDtoSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/admin/design-catalog/resources`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: resourceCreateRequestId,
            scope: "workspace",
            workspace_id: project.workspace.id,
            kind: "image",
            name: workspaceResourceName,
            description: "Disposable Stage 8 catalog fixture.",
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
        }),
        "create Stage 8 workspace resource",
      ),
    );
    fixture.resourceId = workspaceResource.id;
    await publishCatalogEntry(
      request,
      accessToken,
      "resource",
      workspaceResource.id,
      workspaceResource.revision,
      fixture.catalogRequestIds,
    );

    const main = await createDesign(
      request,
      accessToken,
      canvasId,
      `stage8-main-${runId}`,
      "Stage 8 missing-font design",
      { x: 30, y: 60, width: 300, height: 169 },
    );
    const exportDesign = await createDesign(
      request,
      accessToken,
      canvasId,
      `stage8-export-${runId}`,
      "Stage 8 export design",
      { x: 380, y: 60, width: 300, height: 169 },
    );
    const fontUpload = readFontFileUpload(
      await readJson(
        await request.post(`${serverURL}/api/admin/design-catalog/font-files`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          multipart: {
            workspace_id: project.workspace.id,
            file: {
              name: "GeistMono-Regular.ttf",
              mimeType: "font/ttf",
              buffer: FONT_FIXTURE,
            },
          },
        }),
        "upload Stage 8 font",
      ),
    );
    fixture.fontAssetId = fontUpload.asset_object_id;
    const fontFamilyName = `Stage8Font-${runId}`;
    const familyRequestId = crypto.randomUUID();
    fixture.catalogRequestIds.push(familyRequestId);
    const family = designCatalogMutationResponseSchema.parse(
      await readJson(
        await request.post(
          `${serverURL}/api/admin/design-catalog/font-families`,
          {
            headers: jsonHeaders(accessToken),
            data: {
              request_id: familyRequestId,
              scope: "workspace",
              workspace_id: project.workspace.id,
              name: fontFamilyName,
              source_url: null,
              author: "Loomic E2E",
              license_name: "Test fixture",
              license_url: null,
              attribution: "Local automated browser fixture",
              usage_restrictions: "Local automated test use only",
            },
          },
        ),
        "create Stage 8 font family",
      ),
    );
    fixture.fontFamilyId = family.entity_id;
    const faceRequestId = crypto.randomUUID();
    fixture.catalogRequestIds.push(faceRequestId);
    const face = designCatalogMutationResponseSchema.parse(
      await readJson(
        await request.post(`${serverURL}/api/admin/design-catalog/font-faces`, {
          headers: jsonHeaders(accessToken),
          data: {
            request_id: faceRequestId,
            scope: "workspace",
            workspace_id: project.workspace.id,
            family_id: family.entity_id,
            asset_object_id: fontUpload.asset_object_id,
            style: fontUpload.style,
            weight: fontUpload.weight,
            format: fontUpload.format,
            checksum_sha256: fontUpload.checksum_sha256,
            allow_web_embed: false,
          },
        }),
        "create Stage 8 font face",
      ),
    );
    fixture.fontFaceId = face.entity_id;
    await mutateDesign(
      request,
      accessToken,
      main.design_id,
      main.design_revision,
      [
        {
          action: "object.add",
          object: {
            objectId: crypto.randomUUID(),
            objectVersion: 1,
            type: "text",
            name: "Missing font title",
            x: 30,
            y: 30,
            width: 320,
            height: 64,
            rotation: 0,
            opacity: 1,
            zIndex: 0,
            locked: false,
            visible: true,
            text: "Stage 8 keeps missing fonts explicit",
            fontFaceId: face.entity_id,
            fontFamily: fontFamilyName,
            fontSize: 36,
            fontWeight: 400,
            fontStyle: "normal",
            textAlign: "left",
            lineHeight: 1.2,
            charSpacing: 0,
            fill: { kind: "solid", color: "#111111" },
          },
        },
      ],
    );

    const stressContent = buildStressCanvas({
      runId,
      imageAssetId: uploaded.asset.id,
    });
    await readJson(
      await request.put(`${serverURL}/api/canvases/${canvasId}`, {
        headers: jsonHeaders(accessToken),
        data: { content: stressContent },
      }),
      "seed 1,000 images and 100 design previews",
    );

    await page.goto(`/canvas?id=${canvasId}`);
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    await expect(page.getByText("预览加载失败", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("生成失败", { exact: true })).toBeVisible();
    const visiblePreviews = page.getByTestId("design-node-preview");
    await expect(visiblePreviews).not.toHaveCount(100);
    expect(await visiblePreviews.count()).toBeLessThanOrEqual(6);

    const panEvidence = await measurePanPerformance(
      page,
      exportDesign.design_id,
    );
    memory.measuredPanFps = panEvidence.fps;
    memory.panViewportDeltaPx = panEvidence.viewportDeltaPx;
    memory.panFrameCount = panEvidence.frameCount;
    memory.panLongTaskCount = panEvidence.longTaskCount;
    memory.panLongTaskTotalMs = panEvidence.longTaskTotalMs;
    expect(panEvidence.viewportDeltaPx).toBeGreaterThan(20);
    expect(panEvidence.frameCount).toBeGreaterThan(30);
    expect(panEvidence.fps).toBeGreaterThanOrEqual(30);
    expect(panEvidence.longTaskSupported).toBe(true);
    expect(panEvidence.longTaskTotalMs / panEvidence.durationMs).toBeLessThan(
      0.25,
    );
    await collectBrowserGarbage(context, page);
    memory.browserAfterStress = await readBrowserMemory(context, page);
    memory.nextAfterStressBytes = readListeningProcessMemory(
      new URL(webURL).port,
    );
    expect(
      memory.browserAfterStress.jsHeapUsedSize -
        memory.browserBaseline.jsHeapUsedSize,
    ).toBeLessThan(512 * 1024 * 1024);
    assertNextMemoryBound(
      memory.nextBaselineBytes,
      memory.nextAfterStressBytes,
    );

    const mainDialog = await openDesign(page, main.design_id);
    await expect(mainDialog.getByRole("alert")).toContainText(
      `字体「${fontFamilyName}」禁止网页嵌入`,
    );
    await expect(
      mainDialog.getByRole("button", { name: "选择替代字体" }),
    ).toBeVisible();
    await expect(page.getByTestId("design-fabric-viewport")).toHaveCount(1);
    await expect(
      page.locator('[data-testid="design-fabric-viewport"] .canvas-container'),
    ).toHaveCount(1);
    console.log("[stage8] main design and font failure verified");

    await context.setOffline(true);
    await mainDialog.getByLabel("背景颜色").fill("#223344");
    await mainDialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      mainDialog.getByText("保存失败", { exact: true }),
    ).toBeVisible();
    await expect(
      mainDialog.getByText(/保存失败，本地修改仍保留/u),
    ).toBeVisible();
    await context.setOffline(false);
    await mainDialog.getByRole("button", { name: "重试保存" }).click();
    await expect(mainDialog.getByText("已保存", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await closeDesign(mainDialog);
    await page.reload();
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    const reopenedMain = await openDesign(page, main.design_id);
    await expect(reopenedMain.getByLabel("背景颜色")).toHaveValue("#223344");
    await closeDesign(reopenedMain);
    console.log("[stage8] offline dirty recovery verified");

    const exportDialog = await openDesign(page, exportDesign.design_id);
    console.log("[stage8] export design opened by exact preview hit");
    const publicSearch = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/design-resources" &&
        new URL(response.url()).searchParams.get("query") ===
          workspaceResourceName,
    );
    await exportDialog
      .getByPlaceholder("搜索名称、标签或分类")
      .fill(workspaceResourceName);
    expect((await publicSearch).ok()).toBe(true);
    const publicCard = exportDialog
      .locator("article")
      .filter({ hasText: workspaceResourceName });
    await expect(publicCard).toHaveCount(1);
    await publicCard.getByRole("button").first().click();
    console.log("[stage8] published workspace resource inserted");
    await expect(
      exportDialog.getByRole("button", { name: /^选择图层：image \d+$/u }),
    ).toBeVisible({ timeout: 30_000 });
    await exportDialog
      .locator('button[title="文字"]')
      .click({ timeout: 15_000 });
    console.log("[stage8] textbox added");
    await exportDialog.getByLabel("字形").selectOption("italic");
    await exportDialog.getByLabel("对齐").selectOption("center");
    await exportDialog.getByLabel("对象填充色").fill("#2255ff");
    const fontSizeInput = exportDialog.getByLabel("字号");
    await fontSizeInput.fill("52");
    await expect(fontSizeInput).toHaveValue("52");
    await fontSizeInput.press("Enter");
    await expect
      .poll(
        async () => {
          const design = await fetchDesign(
            request,
            accessToken,
            exportDesign.design_id,
          );
          const text = design.scene.objects.find(
            (object) => object.type === "text",
          );
          return text
            ? {
                fontSize: text.fontSize,
                fontStyle: text.fontStyle,
                textAlign: text.textAlign,
                fill: text.fill,
              }
            : null;
        },
        { timeout: 30_000 },
      )
      .toEqual({
        fontSize: 52,
        fontStyle: "italic",
        textAlign: "center",
        fill: { kind: "solid", color: "#2255ff" },
      });
    console.log("[stage8] textbox properties updated");
    await exportDialog
      .getByRole("button", { name: "矩形", exact: true })
      .click({ timeout: 15_000 });
    await exportDialog
      .getByRole("button", { name: "圆形", exact: true })
      .click({ timeout: 15_000 });
    console.log("[stage8] rectangle and circle added");
    await exportDialog
      .getByRole("button", { name: /^选择图层：text \d+$/u })
      .click({ timeout: 15_000 });
    await exportDialog
      .getByRole("button", { name: /^选择图层：circle \d+$/u })
      .click({ modifiers: ["Control"], timeout: 15_000 });
    console.log("[stage8] textbox and circle selected");
    await exportDialog
      .getByRole("button", { name: "左对齐" })
      .click({ timeout: 15_000 });
    console.log("[stage8] left alignment applied");
    await exportDialog
      .getByRole("button", { name: /^选择图层：circle \d+$/u })
      .click({ timeout: 15_000 });
    await exportDialog
      .getByRole("button", { name: "置于顶层" })
      .click({ timeout: 15_000 });
    console.log("[stage8] style, alignment and layer gestures completed");
    await exportDialog
      .getByRole("button", { name: "保存", exact: true })
      .click({ timeout: 30_000 });
    await expect(exportDialog.getByText("已保存", { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect
      .poll(
        async () => {
          const design = await fetchDesign(
            request,
            accessToken,
            exportDesign.design_id,
          );
          const text = design.scene.objects.find(
            (object) => object.type === "text",
          );
          const circle = design.scene.objects.find(
            (object) => object.type === "circle",
          );
          return {
            fontSize: text?.fontSize,
            fontStyle: text?.fontStyle,
            textAlign: text?.textAlign,
            fill: text?.fill,
            aligned: circle?.x === text?.x,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        fontSize: 52,
        fontStyle: "italic",
        textAlign: "center",
        fill: { kind: "solid", color: "#2255ff" },
        aligned: true,
      });
    const persistedStyledDesign = await fetchDesign(
      request,
      accessToken,
      exportDesign.design_id,
    );
    const persistedImage = persistedStyledDesign.scene.objects.find(
      (object) =>
        object.type === "image" && object.resourceId === workspaceResource.id,
    );
    expect(persistedImage).toMatchObject({
      type: "image",
      assetObjectId: uploaded.asset.id,
      resourceId: workspaceResource.id,
    });
    const persistedText = persistedStyledDesign.scene.objects.find(
      (object) => object.type === "text",
    );
    const persistedRectangle = persistedStyledDesign.scene.objects.find(
      (object) => object.type === "rect",
    );
    const persistedCircle = persistedStyledDesign.scene.objects.find(
      (object) => object.type === "circle",
    );
    expect(persistedText).toMatchObject({
      type: "text",
      fontSize: 52,
      fontStyle: "italic",
      textAlign: "center",
      fill: { kind: "solid", color: "#2255ff" },
    });
    expect(persistedText).toBeDefined();
    expect(persistedCircle).toBeDefined();
    expect(persistedRectangle).toBeDefined();
    expect(persistedCircle?.x).toBe(persistedText?.x);
    expect(persistedCircle?.zIndex).toBe(
      Math.max(
        ...persistedStyledDesign.scene.objects.map((object) => object.zIndex),
      ),
    );
    console.log("[stage8] styled object mutation saved");

    for (const format of ["png", "jpeg", "transparent-png"] as const) {
      await exportDialog.getByRole("button", { name: "导出" }).click();
      await exportDialog.getByLabel("导出格式").selectOption(format);
      const download = page.waitForEvent("download");
      await exportDialog.getByRole("button", { name: "下载" }).click();
      const artifact = await download;
      expect(artifact.suggestedFilename()).toMatch(
        format === "jpeg" ? /\.jpe?g$/iu : /\.png$/iu,
      );
      const bytes = await readDownloadBytes(artifact);
      expect(bytes.byteLength).toBeGreaterThan(64);
      expectImageMagic(bytes, format);
      const decoded = await decodeImageEvidence(
        page,
        bytes,
        format === "jpeg" ? "image/jpeg" : "image/png",
      );
      expect(decoded).toMatchObject({ width: 640, height: 360 });
      if (format === "transparent-png") {
        expect(decoded.hasTransparentPixel).toBe(true);
      }
      console.log(`[stage8] local ${format} export downloaded`);
    }
    await closeDesign(exportDialog);

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const dialog = await openDesign(page, exportDesign.design_id);
      await expect(page.getByTestId("design-fabric-viewport")).toHaveCount(1);
      await closeDesign(dialog);
      await expect(page.getByTestId("design-fabric-viewport")).toHaveCount(0);
      await expect(
        page.locator('[data-testid="design-fabric-viewport"] canvas'),
      ).toHaveCount(0);
      if ((cycle + 1) % 5 === 0)
        console.log(`[stage8] completed ${cycle + 1}/20 editor destroy cycles`);
    }
    await collectBrowserGarbage(context, page);
    memory.browserAfterCycles = await readBrowserMemory(context, page);
    memory.nextAfterCyclesBytes = readListeningProcessMemory(
      new URL(webURL).port,
    );
    expect(
      memory.browserAfterCycles.jsHeapUsedSize -
        memory.browserAfterStress.jsHeapUsedSize,
    ).toBeLessThan(128 * 1024 * 1024);
    if (
      memory.nextAfterStressBytes !== null &&
      memory.nextAfterCyclesBytes !== null
    ) {
      expect(
        memory.nextAfterCyclesBytes - memory.nextAfterStressBytes,
      ).toBeLessThan(256 * 1024 * 1024);
    }

    secondPage = await context.newPage();
    console.log("[stage8] 20 editor destroy cycles and memory verified");
    await secondPage.goto(`/canvas?id=${canvasId}`);
    await expect(secondPage.getByTestId("canvas-editor")).toBeVisible();
    const firstWriter = await openDesign(page, main.design_id);
    const secondWriter = await openDesign(secondPage, main.design_id);
    await secondWriter.getByLabel("背景颜色").fill("#334455");
    await firstWriter.getByLabel("背景颜色").fill("#556677");
    const firstSave = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/designs/${main.design_id}/mutations`,
    );
    await firstWriter
      .getByRole("button", { name: "保存", exact: true })
      .click();
    expect((await firstSave).ok()).toBe(true);
    const conflictAlert = secondWriter.getByText(
      /服务器设计已更新到版本 \d+，本地修改已暂停保存/u,
    );
    if (
      !(await conflictAlert.isVisible({ timeout: 4_000 }).catch(() => false))
    ) {
      const saveButton = secondWriter.getByRole("button", {
        name: "保存",
        exact: true,
      });
      if (await saveButton.isEnabled()) await saveButton.click();
    }
    await expect(conflictAlert).toBeVisible({ timeout: 20_000 });
    await secondWriter.getByRole("button", { name: "放弃本地并重载" }).click();
    await expect(secondWriter.getByLabel("背景颜色")).toHaveValue("#556677");
    console.log(
      "[stage8] two-window conflict and authoritative reload verified",
    );
    await closeDesign(secondWriter);
    await closeDesign(firstWriter);

    const deletedElementId = `stage8-design-0-${runId}`;
    const targetPreview = page
      .getByTestId("design-node-preview")
      .filter({ hasText: "预览加载失败" });
    const targetBounds = await targetPreview.boundingBox();
    expect(targetBounds).not.toBeNull();
    const tombstoneSave = page.waitForResponse((response) => {
      if (
        response.request().method() !== "PUT" ||
        new URL(response.url()).pathname !== `/api/canvases/${canvasId}` ||
        !response.ok()
      ) {
        return false;
      }
      const body = response.request().postDataJSON() as {
        content?: { elements?: Array<{ id?: string; isDeleted?: boolean }> };
      };
      return Boolean(
        body.content?.elements?.some(
          (element) =>
            element.id === deletedElementId && element.isDeleted === true,
        ),
      );
    });
    await page.mouse.click(
      (targetBounds?.x ?? 0) + (targetBounds?.width ?? 0) / 2,
      (targetBounds?.y ?? 0) + (targetBounds?.height ?? 0) / 2,
    );
    await page.keyboard.press("Delete");
    await tombstoneSave;
    const persistedCanvas = canvasGetResponseSchema.parse(
      await readJson(
        await request.get(`${serverURL}/api/canvases/${canvasId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        "verify canvas tombstone",
      ),
    );
    expect(
      persistedCanvas.canvas.content.elements.find(
        (element) => element.id === deletedElementId,
      ),
    ).toMatchObject({ isDeleted: true });
    console.log("[stage8] canvas tombstone persisted");
    console.log(`[stage8] memory evidence ${JSON.stringify(memory)}`);

    await testInfo.attach("stage8-memory-evidence.json", {
      body: Buffer.from(JSON.stringify(memory, null, 2)),
      contentType: "application/json",
    });
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await secondPage?.close().catch(() => undefined);
    await cleanupFixture(admin, request, fixture);
  }
});

async function createDesign(
  request: APIRequestContext,
  accessToken: string,
  canvasId: string,
  canvasElementId: string,
  name: string,
  node: { x: number; y: number; width: number; height: number },
) {
  const current = canvasGetResponseSchema.parse(
    await readJson(
      await request.get(`${serverURL}/api/canvases/${canvasId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      "load canvas before design create",
    ),
  );
  return createDesignResponseSchema.parse(
    await readJson(
      await request.post(`${serverURL}/api/designs`, {
        headers: jsonHeaders(accessToken),
        data: {
          request_id: crypto.randomUUID(),
          canvas_id: canvasId,
          expected_canvas_revision: current.canvas.revision,
          canvas_element_id: canvasElementId,
          name,
          width: 640,
          height: 360,
          background: "#ffffff",
          node,
        },
      }),
      `create ${name}`,
    ),
  );
}

async function mutateDesign(
  request: APIRequestContext,
  accessToken: string,
  designId: string,
  expectedRevision: number,
  commands: readonly Record<string, unknown>[],
) {
  return readJson(
    await request.post(`${serverURL}/api/designs/${designId}/mutations`, {
      headers: jsonHeaders(accessToken),
      data: {
        design_id: designId,
        expected_revision: expectedRevision,
        idempotency_key: crypto.randomUUID(),
        commands,
      },
    }),
    "mutate Stage 8 design",
  );
}

async function publishCatalogEntry(
  request: APIRequestContext,
  accessToken: string,
  entityKind: "resource",
  entityId: string,
  initialRevision: number,
  cleanupRequestIds: string[],
) {
  let revision = initialRevision;
  for (const status of ["pending_review", "published"] as const) {
    const requestId = crypto.randomUUID();
    cleanupRequestIds.push(requestId);
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
        `set ${entityKind} status to ${status}`,
      ),
    );
    revision = response.revision;
  }
  return revision;
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
      "fetch Stage 8 design",
    ),
  ).design;
}

function readFontFileUpload(value: unknown) {
  const input = readRecord(value);
  const format = input.format;
  if (
    typeof input.asset_object_id !== "string" ||
    (input.style !== "normal" && input.style !== "italic") ||
    typeof input.weight !== "number" ||
    (format !== "woff" && format !== "ttf" && format !== "otf") ||
    typeof input.checksum_sha256 !== "string"
  ) {
    throw new Error("Stage 8 font upload response was malformed.");
  }
  return {
    asset_object_id: input.asset_object_id,
    style: input.style,
    weight: input.weight,
    format,
    checksum_sha256: input.checksum_sha256,
  };
}

function buildStressCanvas(input: {
  runId: string;
  imageAssetId: string;
}) {
  const fileId = `stage8-file-${input.runId}`;
  const images = Array.from({ length: 1_000 }, (_, index) =>
    imageElement({
      id: `stage8-image-${index}-${input.runId}`,
      fileId,
      assetId: input.imageAssetId,
      x: index < 80 ? 20 + (index % 16) * 72 : 20_000 + (index % 40) * 72,
      y:
        index < 80
          ? 620 + Math.floor(index / 16) * 72
          : Math.floor(index / 40) * 72,
    }),
  );
  const missingPreviewId = crypto.randomUUID();
  // Two real design nodes are already present from createDesign(). Add 98
  // unique preview nodes so the merged canvas contains exactly 100 designs.
  const designs = Array.from({ length: 98 }, (_, index) => {
    const isVisible = index === 0;
    return rectangleElement({
      id: `stage8-design-${index}-${input.runId}`,
      x: isVisible ? 730 : 30_000 + (index % 20) * 340,
      y: isVisible ? 60 : Math.floor(index / 20) * 220,
      width: 300,
      height: 169,
      customData: {
        kind: "loomic-design",
        schemaVersion: 1,
        designId: crypto.randomUUID(),
        revision: 1,
        previewAssetObjectId:
          index === 0 ? missingPreviewId : input.imageAssetId,
        previewRevision: 1,
      },
    });
  });
  const failedGeneration = rectangleElement({
    id: `stage8-failed-generation-${input.runId}`,
    x: 1_070,
    y: 60,
    width: 260,
    height: 169,
    customData: {
      type: "image-generator",
      status: "error",
      prompt: "Stage 8 deterministic failure fixture",
      model: "local:test-no-provider",
      aspectRatio: "16:9",
      quality: "standard",
      errorMessage: "Intentional non-paid release failure",
    },
  });
  return {
    elements: [...images, ...designs, failedGeneration],
    appState: {
      viewBackgroundColor: "#ffffff",
      gridModeEnabled: false,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    },
    files: {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        created: Date.now(),
        assetId: input.imageAssetId,
      },
    },
  };
}

function imageElement(input: {
  id: string;
  fileId: string;
  assetId: string;
  x: number;
  y: number;
}) {
  return {
    ...baseElement(input.id, "image", input.x, input.y, 64, 64),
    fileId: input.fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      source: "stage8-stress",
      assetId: input.assetId,
      mimeType: "image/png",
    },
  };
}

function rectangleElement(input: {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData: Record<string, unknown>;
}) {
  return {
    ...baseElement(
      input.id,
      "rectangle",
      input.x,
      input.y,
      input.width,
      input.height,
    ),
    customData: input.customData,
  };
}

function baseElement(
  id: string,
  type: "image" | "rectangle",
  x: number,
  y: number,
  width: number,
  height: number,
) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#d1d5db",
    backgroundColor: type === "rectangle" ? "#f3f4f6" : "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: type === "rectangle" ? { type: 3 } : null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: stableSeed(id),
    version: 1,
    versionNonce: stableSeed(`${id}-version`),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function stableSeed(value: string) {
  let result = 0;
  for (const character of value)
    result = (result * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(result) || 1;
}

async function openDesign(page: Page, designId: string): Promise<Locator> {
  const preview = page
    .locator(
      `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
    )
    .first();
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  const point = {
    x: (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
    y: (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
  };
  const hitSnapshot = await page.evaluate(({ x, y }) => {
    const hits = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="design-node-preview"]',
      ),
    )
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        );
      })
      .map((element) => ({
        designId: element.dataset.designId,
        canvasElementId: element.dataset.canvasElementId,
        rect: element.getBoundingClientRect().toJSON(),
      }));
    return {
      point: { x, y },
      eventTarget: document.elementFromPoint(x, y)?.tagName ?? null,
      hits,
    };
  }, point);
  expect(
    hitSnapshot.hits.map((hit) => hit.designId),
    JSON.stringify(hitSnapshot),
  ).toEqual([designId]);
  await page.mouse.dblclick(point.x, point.y);
  const dialog = page.locator(`dialog[data-design-id="${designId}"]`);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function clickDesignPreview(page: Page, designId: string) {
  const preview = page
    .locator(
      `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
    )
    .first();
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.click(
    (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
    (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
  );
}

async function closeDesign(dialog: Locator) {
  await dialog.getByRole("button", { name: "返回画布" }).click();
  await expect(dialog).toBeHidden();
}

async function measurePanPerformance(page: Page, trackedDesignId: string) {
  const canvas = page.locator('[data-testid="canvas-editor"] canvas').last();
  await expect(canvas).toBeVisible();
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Stage 8 canvas bounds are unavailable.");
  const trackedPreview = page.locator(
    `[data-testid="design-node-preview"][data-design-id="${trackedDesignId}"]`,
  );
  const before = await trackedPreview.boundingBox();
  if (!before)
    throw new Error("Stage 8 tracked preview is outside the viewport.");

  await page.mouse.move(
    canvasBounds.x + canvasBounds.width / 2,
    canvasBounds.y + canvasBounds.height / 2,
  );
  const frameEvidence = page.evaluate(
    () =>
      new Promise<{
        durationMs: number;
        frameCount: number;
        fps: number;
        longTaskSupported: boolean;
        longTaskCount: number;
        longTaskTotalMs: number;
      }>((resolve) => {
        const started = performance.now();
        const frameTimes: number[] = [];
        const longTasks: number[] = [];
        const longTaskSupported =
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes.includes("longtask");
        const observer = longTaskSupported
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries())
                longTasks.push(entry.duration);
            })
          : null;
        observer?.observe({ entryTypes: ["longtask"] });
        const tick = (now: number) => {
          frameTimes.push(now);
          if (now - started < 2_000) {
            requestAnimationFrame(tick);
            return;
          }
          observer?.disconnect();
          const durationMs = Math.max(1, now - started);
          resolve({
            durationMs,
            frameCount: frameTimes.length,
            fps: (frameTimes.length * 1_000) / durationMs,
            longTaskSupported,
            longTaskCount: longTasks.length,
            longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0),
          });
        };
        requestAnimationFrame(tick);
      }),
  );

  for (let index = 0; index < 80; index += 1) {
    await page.mouse.wheel(2, 1);
    await page.waitForTimeout(12);
  }
  const measured = await frameEvidence;
  await page.waitForTimeout(100);
  const after = await trackedPreview.boundingBox();
  if (!after) {
    throw new Error(
      "Stage 8 tracked preview unexpectedly left the viewport during the bounded pan.",
    );
  }
  const viewportDeltaPx = Math.hypot(after.x - before.x, after.y - before.y);

  // Restore the viewport so subsequent exact-preview interactions are stable.
  for (let index = 0; index < 80; index += 1) await page.mouse.wheel(-2, -1);
  await expect(trackedPreview).toBeVisible();
  return { ...measured, viewportDeltaPx };
}

async function readDownloadBytes(download: Download): Promise<Buffer> {
  const failure = await download.failure();
  if (failure) throw new Error(`Stage 8 download failed: ${failure}`);
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Stage 8 download stream is unavailable.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function expectImageMagic(
  bytes: Buffer,
  format: "png" | "jpeg" | "transparent-png",
) {
  if (format === "jpeg") {
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    return;
  }
  expect([...bytes.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
}

async function decodeImageEvidence(
  page: Page,
  bytes: Buffer,
  mimeType: string,
) {
  return page.evaluate(
    async ({ base64, mimeType: type }) => {
      const binary = atob(base64);
      const data = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(new Blob([data], { type }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context)
        throw new Error("Stage 8 image decoder canvas is unavailable.");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let hasTransparentPixel = false;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if ((pixels[offset] ?? 255) < 255) {
          hasTransparentPixel = true;
          break;
        }
      }
      return {
        width: canvas.width,
        height: canvas.height,
        hasTransparentPixel,
      };
    },
    { base64: bytes.toString("base64"), mimeType },
  );
}

async function collectBrowserGarbage(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage");
  } finally {
    await session.detach();
  }
}

async function readBrowserMemory(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  try {
    await session.send("Performance.enable");
    const result = await session.send("Performance.getMetrics");
    const metric = (name: string) => {
      const value = result.metrics.find(
        (candidate) => candidate.name === name,
      )?.value;
      if (value === undefined || !Number.isFinite(value)) {
        throw new Error(
          `Stage 8 CDP memory evidence is unavailable: missing ${name}.`,
        );
      }
      return value;
    };
    return {
      jsHeapUsedSize: metric("JSHeapUsedSize"),
      jsHeapTotalSize: metric("JSHeapTotalSize"),
      documents: metric("Documents"),
      nodes: metric("Nodes"),
    };
  } finally {
    await session.detach();
  }
}

function readListeningProcessMemory(rawPort: string): number | null {
  if (process.platform !== "win32") return null;
  const port = Number(rawPort || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ownerId=(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess); (Get-Process -Id $ownerId -ErrorAction Stop).WorkingSet64`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    const bytes = Number(output);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function assertNextMemoryBound(before: number | null, after: number | null) {
  if (before === null || after === null) return;
  expect(after).toBeLessThan(4 * 1024 * 1024 * 1024);
  expect(after - before).toBeLessThan(768 * 1024 * 1024);
}

async function createLocalAccount(
  admin: ReturnType<typeof createClient>,
  runId: string,
) {
  const email = `stage8-${runId}@example.test`;
  const password = `Stage8-${crypto.randomUUID()}-aA1!`;
  const result = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (result.error || !result.data.user)
    throw result.error ?? new Error("Failed to create Stage 8 user.");
  return { email, password, userId: result.data.user.id };
}

async function login(page: Page, email: string, password: string) {
  const authResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/auth/v1/token"),
  );
  const viewerResponse = page
    .waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/viewer",
    )
    .catch(() => null);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await authResponse;
  if (!response.ok()) {
    throw new Error(
      `Stage 8 login failed (${response.status()}): ${await response.text()}`,
    );
  }
  const token = readString(readRecord(await response.json()).access_token);
  if (!token) throw new Error("Stage 8 login token missing.");
  const viewer = await viewerResponse;
  if (!viewer) throw new Error("Stage 8 workspace bootstrap did not start.");
  if (!viewer.ok()) {
    throw new Error(
      `Stage 8 workspace bootstrap failed (${viewer.status()}): ${await viewer.text()}`,
    );
  }
  // Stage 8 validates downstream canvas behavior, while the dedicated auth
  // specs own the router transition. Navigate explicitly after both real auth
  // and workspace bootstrap succeed so a cold /home compilation is not timed
  // against the login component's redirect effect.
  await page.goto("/home");
  await expect(page).toHaveURL(/\/home(?:[/?#]|$)/u);
  return token;
}

async function cleanupFixture(
  admin: ReturnType<typeof createClient>,
  request: APIRequestContext,
  fixture: Fixture,
) {
  if (fixture.projectId && fixture.accessToken) {
    const response = await request.delete(
      `${serverURL}/api/projects/${fixture.projectId}`,
      {
        headers: { Authorization: `Bearer ${fixture.accessToken}` },
      },
    );
    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `Stage 8 project cleanup failed (${response.status()}): ${await response.text()}`,
      );
    }
    assertCleanupResult(
      await admin.from("projects").delete().eq("id", fixture.projectId),
      "project row",
    );
  }
  if (fixture.resourceId)
    assertCleanupResult(
      await admin
        .from("design_resources")
        .delete()
        .eq("id", fixture.resourceId),
      "design resource",
    );
  if (fixture.fontFaceId)
    assertCleanupResult(
      await admin.from("font_faces").delete().eq("id", fixture.fontFaceId),
      "font face",
    );
  if (fixture.fontFamilyId)
    assertCleanupResult(
      await admin.from("font_families").delete().eq("id", fixture.fontFamilyId),
      "font family",
    );
  for (const requestId of fixture.catalogRequestIds) {
    assertCleanupResult(
      await admin
        .from("catalog_mutation_requests")
        .delete()
        .eq("request_id", requestId),
      `catalog request ${requestId}`,
    );
  }
  if (fixture.assetId) {
    const asset = await admin
      .from("asset_objects")
      .select("bucket,object_path")
      .eq("id", fixture.assetId)
      .maybeSingle();
    assertCleanupResult(asset, "image asset lookup");
    if (asset.data) {
      assertCleanupResult(
        await admin.storage
          .from(asset.data.bucket)
          .remove([asset.data.object_path]),
        "image storage object",
      );
    }
    assertCleanupResult(
      await admin.from("asset_objects").delete().eq("id", fixture.assetId),
      "image asset row",
    );
  }
  if (fixture.fontAssetId) {
    const asset = await admin
      .from("asset_objects")
      .select("bucket,object_path")
      .eq("id", fixture.fontAssetId)
      .maybeSingle();
    assertCleanupResult(asset, "font asset lookup");
    if (asset.data) {
      assertCleanupResult(
        await admin.storage
          .from(asset.data.bucket)
          .remove([asset.data.object_path]),
        "font storage object",
      );
    }
    assertCleanupResult(
      await admin.from("asset_objects").delete().eq("id", fixture.fontAssetId),
      "font asset row",
    );
  }
  if (fixture.authUserId) {
    const deleted = await admin.auth.admin.deleteUser(fixture.authUserId);
    if (deleted.error) {
      throw new Error(`Stage 8 auth cleanup failed: ${deleted.error.message}`);
    }
  }
}

function assertCleanupResult(
  result: { error: { message: string } | null },
  operation: string,
) {
  if (result.error) {
    throw new Error(
      `Stage 8 ${operation} cleanup failed: ${result.error.message}`,
    );
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

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assertLocalEnvironment() {
  for (const [name, value] of [
    ["LOOMIC_E2E_SERVER_URL", serverURL],
    ["LOOMIC_E2E_BASE_URL", webURL],
    ["SUPABASE_URL", supabaseURL],
  ] as const) {
    if (!value) throw new Error(`${name} is required for Stage 8 E2E.`);
    if (!["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname))
      throw new Error(`${name} must target the disposable local stack.`);
  }
  if (!serviceRoleKey)
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for local cleanup.");
  if (!serviceRoleKey.startsWith("sb_secret_")) {
    const claims = readRecord(
      JSON.parse(
        Buffer.from(serviceRoleKey.split(".")[1] ?? "", "base64url").toString(
          "utf8",
        ),
      ),
    );
    if (
      !["supabase-demo", "surabase-demo"].includes(readString(claims.iss)) ||
      claims.role !== "service_role"
    ) {
      throw new Error(
        "The Supabase admin key must belong to the disposable local stack.",
      );
    }
  }
}

type Fixture = {
  accessToken: string | null;
  authUserId: string | null;
  projectId: string | null;
  assetId: string | null;
  resourceId: string | null;
  resourceCreateRequestId: string | null;
  fontAssetId: string | null;
  fontFamilyId: string | null;
  fontFaceId: string | null;
  catalogRequestIds: string[];
};

function emptyFixture(): Fixture {
  return {
    accessToken: null,
    authUserId: null,
    projectId: null,
    assetId: null,
    resourceId: null,
    resourceCreateRequestId: null,
    fontAssetId: null,
    fontFamilyId: null,
    fontFaceId: null,
    catalogRequestIds: [],
  };
}

type BrowserMemory = Awaited<ReturnType<typeof readBrowserMemory>>;
type MemoryEvidence = {
  nextBaselineBytes: number | null;
  browserBaseline: BrowserMemory;
  nextAfterStressBytes: number | null;
  browserAfterStress: BrowserMemory | null;
  nextAfterCyclesBytes: number | null;
  browserAfterCycles: BrowserMemory | null;
  measuredPanFps: number | null;
  panViewportDeltaPx: number | null;
  panFrameCount: number | null;
  panLongTaskCount: number | null;
  panLongTaskTotalMs: number | null;
};
