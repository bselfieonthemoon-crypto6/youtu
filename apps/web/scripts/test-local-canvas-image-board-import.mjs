import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

assert.equal(
  process.env.BOARD_FLOW_AUDIT,
  "1",
  "Set BOARD_FLOW_AUDIT=1 to acknowledge the isolated QA canvas.",
);
assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");

const canvasId =
  process.env.LOCAL_IMAGE_BOARD_QA_CANVAS_ID ??
  "c43800f8-bfa2-4c30-a86c-5786a80922e2";
assert.equal(
  canvasId,
  "c43800f8-bfa2-4c30-a86c-5786a80922e2",
  "This script is restricted to the isolated local-image QA canvas.",
);
const web = process.env.LOCAL_IMAGE_BOARD_QA_WEB_URL ?? "http://localhost:3020";
const api = process.env.LOCAL_IMAGE_BOARD_QA_API_URL ?? "http://localhost:3002";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  opts,
);
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const localName = `qa-local-board-${runId}.png`;
const reportPath = `../../artifacts/paid-dialogue-live/local-canvas-image-board-${runId}.json`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

const initial = await db
  .from("canvases")
  .select("project_id,created_by,content")
  .eq("id", canvasId)
  .single();
assert.ifError(initial.error);
const board = initial.data.content.elements.find(
  (element) => element.customData?.designId && !element.isDeleted,
);
assert(
  board,
  "The isolated QA canvas must already contain a live design board.",
);
const designId = board.customData.designId;
const sessionRow = await db
  .from("chat_sessions")
  .select("id")
  .eq("canvas_id", canvasId)
  .order("created_at", { ascending: false })
  .limit(1)
  .single();
assert.ifError(sessionRow.error);
const account = await db.auth.admin.getUserById(initial.data.created_by);
assert(account.data.user?.email);
const link = await db.auth.admin.generateLink({
  type: "magiclink",
  email: account.data.user.email,
});
const auth = createClient(
  process.env.SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
  opts,
);
const login = await auth.auth.verifyOtp({
  type: "magiclink",
  token_hash: link.data.properties.hashed_token,
});
assert(login.data.session);
const token = login.data.session.access_token;

const readCanvas = async () => {
  const query = await db
    .from("canvases")
    .select("content,revision")
    .eq("id", canvasId)
    .single();
  assert.ifError(query.error);
  return query.data;
};
const readDesign = async () => {
  const query = await db
    .from("design_documents")
    .select("scene,revision")
    .eq("id", designId)
    .single();
  assert.ifError(query.error);
  return query.data;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
});
const createdElementIds = new Set();
const receipts = [];
const report = {
  canvasId,
  designId,
  runId,
  startedAt: new Date().toISOString(),
  cases: [],
};

async function selectCanvasElement(element) {
  await page.mouse.click(
    element.x + element.width / 2,
    element.y + element.height / 2,
  );
  await expect(
    page.getByRole("button", { name: /^(添加到画板|加入此画板)$/ }).first(),
  ).toBeVisible();
}

async function addSelectedImage(caseName, expectedSourceId) {
  const before = await readDesign();
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/uploads",
    { timeout: 60_000 },
  );
  const importResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/canvas-image-imports$/.test(new URL(response.url()).pathname),
    { timeout: 60_000 },
  );
  const add = page
    .getByRole("button", { name: /^(添加到画板|加入此画板)$/ })
    .first();
  await add.click();
  const picker = page.getByRole("dialog", { name: "选择图片目标画板" });
  await expect(picker).toBeVisible();
  await picker
    .getByRole("button", { name: /^(添加到画板|加入此画板)$/ })
    .first()
    .click();
  const [uploaded, imported] = await Promise.all([
    uploadResponse,
    importResponse,
  ]);
  const uploadBody = await uploaded.json();
  const receipt = await imported.json();
  assert(uploaded.ok(), JSON.stringify(uploadBody));
  assert(imported.ok(), JSON.stringify(receipt));
  assert.equal(receipt.source_element_id, expectedSourceId);
  receipts.push(receipt);
  await expect
    .poll(async () => (await readDesign()).scene.objects.length, {
      timeout: 30_000,
    })
    .toBe(before.scene.objects.length + 1);
  const canvas = await readCanvas();
  const source = canvas.content.elements.find(
    (element) => element.id === expectedSourceId,
  );
  assert.match(source?.customData?.assetId ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(source.customData.assetId, uploadBody.asset.id);
  const asset = await db
    .from("asset_objects")
    .select("id,project_id,workspace_id")
    .eq("id", source.customData.assetId)
    .single();
  assert.ifError(asset.error);
  assert.equal(asset.data.project_id, initial.data.project_id);
  await page.getByRole("button", { name: "撤销加入", exact: true }).click();
  await expect
    .poll(async () => (await readDesign()).scene.objects.length, {
      timeout: 30_000,
    })
    .toBe(before.scene.objects.length);
  report.cases.push({
    caseName,
    sourceElementId: expectedSourceId,
    assetId: source.customData.assetId,
    uploadStatus: uploaded.status(),
    importStatus: imported.status(),
    undo: true,
  });
}

try {
  await page.addInitScript(
    (session) =>
      localStorage.setItem("sb-127-auth-token", JSON.stringify(session)),
    login.data.session,
  );
  await page.goto(`${web}/canvas?id=${canvasId}&session=${sessionRow.data.id}`);
  await expect(
    page.getByRole("textbox", { name: "输入消息", exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(1_500);

  await page.getByRole("button", { name: "菜单", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /导入图片/ }).click();
  await (await chooser).setFiles({
    name: localName,
    mimeType: "image/png",
    buffer: png,
  });
  const local = await expect
    .poll(
      async () =>
        (await readCanvas()).content.elements.find(
          (element) =>
            element.customData?.title === localName && !element.isDeleted,
        ),
      { timeout: 30_000 },
    )
    .toBeTruthy()
    .then(async () =>
      (await readCanvas()).content.elements.find(
        (element) =>
          element.customData?.title === localName && !element.isDeleted,
      ),
    );
  assert(local);
  createdElementIds.add(local.id);
  assert.equal(
    local.customData?.assetId,
    undefined,
    "The fixture must exercise the unbound local-image path.",
  );
  await selectCanvasElement(local);
  await addSelectedImage("local-upload", local.id);

  await selectCanvasElement(
    (await readCanvas()).content.elements.find(
      (element) => element.id === local.id,
    ),
  );
  const cropButton = page.getByTitle("裁剪");
  if (!(await cropButton.count())) {
    await page.getByRole("button", { name: "更多图片工具" }).click();
  }
  await page.getByTitle("裁剪").click();
  const cropPanel = page
    .getByRole("textbox", { name: "裁剪宽度" })
    .locator("..")
    .locator("..");
  await cropPanel.getByRole("button", { name: "保存", exact: true }).click();
  const croppedTitle = `${localName}（裁剪）`;
  const cropped = await expect
    .poll(
      async () =>
        (await readCanvas()).content.elements.find(
          (element) =>
            element.customData?.title === croppedTitle && !element.isDeleted,
        ),
      { timeout: 30_000 },
    )
    .toBeTruthy()
    .then(async () =>
      (await readCanvas()).content.elements.find(
        (element) =>
          element.customData?.title === croppedTitle && !element.isDeleted,
      ),
    );
  assert(cropped);
  createdElementIds.add(cropped.id);
  assert.equal(
    cropped.customData?.assetId,
    undefined,
    "The fixture must exercise the unbound cropped-image path.",
  );
  await selectCanvasElement(cropped);
  await addSelectedImage("cropped-copy", cropped.id);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  await page
    .screenshot({
      path: `../../artifacts/paid-dialogue-live/local-canvas-image-board-${runId}-failure.png`,
    })
    .catch(() => undefined);
} finally {
  for (const receipt of receipts.reverse()) {
    const design = await readDesign().catch(() => null);
    const object = design?.scene.objects.find(
      (candidate) => candidate.objectId === receipt.object_id,
    );
    if (!object) continue;
    await fetch(
      `${api}/api/designs/${designId}/canvas-image-imports/${receipt.operation_id}/undo`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: randomUUID(),
          expected_design_revision: design.revision,
          expected_object_version: object.objectVersion,
        }),
      },
    ).catch(() => undefined);
  }
  if (createdElementIds.size) {
    const canvas = await readCanvas().catch(() => null);
    if (canvas) {
      const content = {
        ...canvas.content,
        elements: canvas.content.elements.map((element) =>
          createdElementIds.has(element.id)
            ? {
                ...element,
                isDeleted: true,
                version: Number(element.version ?? 0) + 1,
                updated: Date.now(),
              }
            : element,
        ),
      };
      await fetch(`${api}/api/canvases/${canvasId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      }).catch(() => undefined);
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
