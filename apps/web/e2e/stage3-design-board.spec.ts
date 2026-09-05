import {
  type CanvasGetResponse,
  canvasGetResponseSchema,
  createDesignResponseSchema,
  designGetResponseSchema,
} from "@loomic/shared";
import {
  type APIRequestContext,
  type Locator,
  type Page,
  expect,
  test,
} from "@playwright/test";

const serverURL = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
const email = process.env.LOOMIC_E2E_EMAIL;
const password = process.env.LOOMIC_E2E_PASSWORD;

test("Stage 3 design board survives real create, reload and 20 editor lifecycles", async ({
  page,
  request,
}) => {
  if (!email || !password) {
    throw new Error(
      "Set LOOMIC_E2E_EMAIL and LOOMIC_E2E_PASSWORD for a seeded local test account.",
    );
  }

  const authResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/auth/v1/token"),
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const authResponse = await authResponsePromise;
  expect(authResponse.ok()).toBe(true);
  const accessToken = readAccessToken(await authResponse.json());
  await expect(page).toHaveURL(/\/home(?:[/?#]|$)/u);

  let projectId: string | null = null;
  try {
    const projectResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/projects",
    );
    await page.getByRole("button", { name: "新建项目" }).click();
    const projectResponse = await projectResponsePromise;
    if (!projectResponse.ok()) {
      throw new Error(
        `Project creation failed (${projectResponse.status()}): ${await projectResponse.text()}`,
      );
    }
    await expect(page).toHaveURL(/\/canvas\?[^#]*\bid=/u, {
      timeout: 60_000,
    });
    const canvasId = new URL(page.url()).searchParams.get("id");
    expect(canvasId).toBeTruthy();
    const editor = page.getByTestId("canvas-editor");
    await expect(editor).toBeVisible();

    const initialCanvas = await fetchCanvas(
      request,
      accessToken,
      canvasId as string,
    );
    projectId = initialCanvas.canvas.projectId;

    await editor.getByRole("button", { name: "设计画板" }).click();
    const createPanel = page.getByRole("form", { name: "创建空白设计" });
    await expect(createPanel).toBeVisible();
    await createPanel.getByLabel("设计宽度").fill("640");
    await createPanel.getByLabel("设计高度").fill("360");

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/designs",
    );
    await createPanel.getByRole("button", { name: "创建设计" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const created = createDesignResponseSchema.parse(
      await createResponse.json(),
    );
    await expect(createPanel).toBeHidden();

    await expect
      .poll(async () => {
        const result = await fetchCanvas(
          request,
          accessToken,
          canvasId as string,
        );
        return liveDesignNodes(result.canvas.content.elements).length;
      })
      .toBe(1);

    const initialDialog = await openSelectedDesign(editor, created.design_id);
    const backgroundInput = initialDialog.getByLabel("背景颜色");
    await expect(backgroundInput).toHaveValue("#ffffff");
    await backgroundInput.fill("#123456");
    await expect(
      initialDialog.getByText("未保存", { exact: true }),
    ).toBeVisible();
    const backgroundMutation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/designs/${created.design_id}/mutations`,
    );
    await initialDialog
      .getByRole("button", { name: "保存", exact: true })
      .click();
    expect((await backgroundMutation).ok()).toBe(true);
    await expect(backgroundInput).toHaveValue("#123456");
    await expect(
      initialDialog.getByText("已保存", { exact: true }),
    ).toBeVisible();

    const objectMutation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/designs/${created.design_id}/mutations`,
    );
    await initialDialog
      .getByRole("button", { name: "文字", exact: true })
      .click();
    await expect(initialDialog.getByLabel("文字")).toHaveValue("文字");
    await initialDialog
      .getByRole("button", { name: "圆形", exact: true })
      .click();
    await initialDialog
      .getByRole("button", { name: "保存", exact: true })
      .click();
    expect((await objectMutation).ok()).toBe(true);
    await closeDesign(page, created.design_id);

    await page.reload();
    const editorAfterBackgroundReload = page.getByTestId("canvas-editor");
    await expect(editorAfterBackgroundReload).toBeVisible();
    const persistedDialog = await openSelectedDesign(
      editorAfterBackgroundReload,
      created.design_id,
    );
    await expect(persistedDialog.getByLabel("背景颜色")).toHaveValue("#123456");
    await expect(persistedDialog.getByText("text 1", { exact: true })).toBeVisible();

    await persistedDialog.getByLabel("宽度 px").fill("800");
    await persistedDialog.getByLabel("高度 px").fill("600");
    await persistedDialog.getByLabel("尺寸处理").selectOption("scale");
    await persistedDialog.getByRole("button", { name: "应用尺寸" }).click();
    await expect(
      persistedDialog.getByLabel("800 × 600 像素设计画板"),
    ).toBeVisible();
    await persistedDialog.getByRole("button", { name: "撤销" }).click();
    await expect(
      persistedDialog.getByLabel("640 × 360 像素设计画板"),
    ).toBeVisible();
    await persistedDialog.getByRole("button", { name: "重做" }).click();
    await expect(
      persistedDialog.getByLabel("800 × 600 像素设计画板"),
    ).toBeVisible();
    const resizeMutation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/designs/${created.design_id}/mutations`,
    );
    await persistedDialog
      .getByRole("button", { name: "保存", exact: true })
      .click();
    expect((await resizeMutation).ok()).toBe(true);
    const resizedDesignResponse = await request.get(
      `${serverURL}/api/designs/${created.design_id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(resizedDesignResponse.ok()).toBe(true);
    const resizedDesign = designGetResponseSchema.parse(
      await resizedDesignResponse.json(),
    ).design;
    const resizedCircle = resizedDesign.scene.objects.find(
      (object) => object.type === "circle",
    );
    expect(resizedCircle).toMatchObject({ width: 200, height: 200 });
    expect(resizedCircle?.objectVersion).toBeGreaterThan(1);
    await closeDesign(page, created.design_id);

    await selectDesignNode(editorAfterBackgroundReload, created.design_id);
    const copyResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/designs/${created.design_id}/copy`,
    );
    await page.getByRole("button", { name: "复制设计", exact: true }).click();
    const copyResponse = await copyResponsePromise;
    expect(copyResponse.status()).toBe(201);
    const copied = createDesignResponseSchema.parse(await copyResponse.json());
    expect(copied.design_id).not.toBe(created.design_id);
    await expect(page.getByText("已复制设计", { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const result = await fetchCanvas(
          request,
          accessToken,
          canvasId as string,
        );
        return liveDesignNodes(result.canvas.content.elements)
          .map((node) => node.designId)
          .sort();
      })
      .toEqual([copied.design_id, created.design_id].sort());

    const persistedCopyRejection = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/canvases/${canvasId}` &&
        response.ok(),
    );
    await selectDesignNode(editorAfterBackgroundReload, copied.design_id);
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect(
      page.getByText("设计节点不能直接复制，请使用“复制设计”命令。"),
    ).toBeVisible();
    await persistedCopyRejection;

    await page.reload();
    await expect(page.getByTestId("canvas-editor")).toBeVisible();
    const reloaded = await fetchCanvas(
      request,
      accessToken,
      canvasId as string,
    );
    const liveNodes = liveDesignNodes(reloaded.canvas.content.elements);
    expect(liveNodes.map((node) => node.designId).sort()).toEqual(
      [created.design_id, copied.design_id].sort(),
    );

    const reloadedEditor = page.getByTestId("canvas-editor");
    const fabricViewports = page.getByTestId("design-fabric-viewport");
    const fabricContainers = page.locator(
      '[data-testid="design-fabric-viewport"] .canvas-container',
    );
    const fabricCanvases = page.locator(
      '[data-testid="design-fabric-viewport"] canvas',
    );
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await openSelectedDesign(reloadedEditor, copied.design_id);
      await expect(fabricViewports).toHaveCount(1);
      await expect(fabricContainers).toHaveCount(1);
      await expect(fabricCanvases).toHaveCount(2);
      await expect(
        fabricViewports.getByLabel("800 × 600 像素设计画板"),
      ).toBeVisible();
      await expect(page.getByLabel("背景颜色")).toHaveValue("#123456");
      await closeDesign(page, copied.design_id);
      await expect(fabricViewports).toHaveCount(0);
      await expect(fabricContainers).toHaveCount(0);
      await expect(fabricCanvases).toHaveCount(0);
    }

    const finalCanvas = await fetchCanvas(
      request,
      accessToken,
      canvasId as string,
    );
    expect(liveDesignNodes(finalCanvas.canvas.content.elements)).toHaveLength(
      2,
    );
  } finally {
    if (projectId) {
      const cleanup = await request.delete(
        `${serverURL}/api/projects/${encodeURIComponent(projectId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const cleanupFailure = cleanup.ok()
        ? ""
        : ` (${cleanup.status()}): ${await cleanup.text()}`;
      expect
        .soft(cleanup.ok(), `E2E project cleanup failed${cleanupFailure}`)
        .toBe(true);
    }
  }
});

async function openSelectedDesign(
  editor: Locator,
  designId: string,
): Promise<Locator> {
  const preview = editor
    .page()
    .locator(
      `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
    );
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  await editor
    .page()
    .mouse.dblclick(
      (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
      (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
    );
  const dialog = editor.page().locator(`dialog[data-design-id="${designId}"]`);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDesign(page: Page, designId: string): Promise<void> {
  const dialog = page.locator(`dialog[data-design-id="${designId}"]`);
  await dialog.getByRole("button", { name: "返回画布" }).click();
  await expect(dialog).toBeHidden();
}

async function selectDesignNode(
  editor: Locator,
  designId: string,
): Promise<void> {
  const preview = editor
    .page()
    .locator(
      `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
    );
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  await editor
    .page()
    .mouse.click(
      (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
      (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
    );
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
  if (!response.ok()) {
    throw new Error(
      `Canvas fetch failed (${response.status()}): ${await response.text()}`,
    );
  }
  return canvasGetResponseSchema.parse(await response.json());
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

function liveDesignNodes(
  elements: readonly Record<string, unknown>[],
): { designId: string }[] {
  return elements.flatMap((element) => {
    if (element.isDeleted === true || !isRecord(element.customData)) return [];
    return element.customData.kind === "loomic-design" &&
      typeof element.customData.designId === "string"
      ? [{ designId: element.customData.designId }]
      : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
