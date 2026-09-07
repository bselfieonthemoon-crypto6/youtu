import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

// Explicit opt-in: writes one isolated test project, never an existing canvas.
test.use({ trace: "off", video: "off" });
test("inline editing persists a real authenticated document and undo", async ({
  page,
  request,
}) => {
  test.skip(
    !process.env.LOOMIC_INLINE_LIVE_USER_ID,
    "Requires an explicitly selected test actor",
  );
  test.setTimeout(180_000);
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data: actor } = await admin.auth.admin.getUserById(
    process.env.LOOMIC_INLINE_LIVE_USER_ID!,
  );
  if (!actor.user?.email) throw new Error("Test actor unavailable");
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: actor.user.email,
  });
  if (linkError) throw new Error("Cannot establish isolated test session");
  const client = createClient(
    url,
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { data: auth, error: authError } = await client.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (authError || !auth.session) throw new Error("Test authentication failed");
  const headers = { Authorization: `Bearer ${auth.session.access_token}` };
  const server = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
  const projectResponse = await request.post(`${server}/api/projects`, {
    headers,
    data: {
      name: `原位画板联调 ${new Date().toISOString()}`,
      description: "Isolated inline acceptance fixture",
    },
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();
  const canvasId = project.primaryCanvas.id;
  const snapshot = await request.get(`${server}/api/canvases/${canvasId}`, {
    headers,
  });
  expect(snapshot.ok()).toBe(true);
  const { canvas } = await snapshot.json();
  const created = await request.post(`${server}/api/designs`, {
    headers,
    data: {
      request_id: crypto.randomUUID(),
      canvas_id: canvasId,
      expected_canvas_revision: canvas.revision,
      canvas_element_id: crypto.randomUUID(),
      name: "原位保存验收",
      width: 640,
      height: 480,
      background: "#ffffff",
      node: { x: 100, y: 130, width: 640, height: 480 },
    },
  });
  expect(created.ok()).toBe(true);
  const { design_id: designId } = await created.json();
  const key = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  await page.addInitScript(
    ({ key, session }) => {
      localStorage.setItem(key, JSON.stringify(session));
    },
    { key, session: auth.session },
  );
  await page.goto(`/canvas?id=${canvasId}&inlineArtboard=1`);
  const preview = page.locator(
    `[data-testid="design-node-preview"][data-design-id="${designId}"]`,
  );
  const open = async () => {
    await expect(preview).toBeVisible({ timeout: 60_000 });
    const box = (await preview.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId("design-inline-editor")).toBeVisible();
    await expect(
      page.locator("[data-testid='design-inline-editor'] .upper-canvas"),
    ).toBeVisible();
  };
  const read = async () => {
    const response = await request.get(`${server}/api/designs/${designId}`, {
      headers,
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).design;
  };
  await open();
  await page.getByRole("button", { name: "添加文字", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await read()).scene.objects.length).toBe(1);
  const first = (await read()).scene.objects[0];
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await read()).scene.objects.length).toBe(0);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await read()).scene.objects.length).toBe(1);
  await page.reload();
  await open();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await read()).scene.objects[0]).toMatchObject({
    objectId: first.objectId,
    x: first.x,
    y: first.y,
  });
  await page.getByRole("button", { name: "资源", exact: true }).click();
  const resource = page
    .locator("[aria-label='设计资源中心'] button[draggable=true]")
    .first();
  await expect(resource).toBeVisible();
  const surface = page.getByTestId("design-fabric-viewport");
  const surfaceBounds = (await surface.boundingBox())!;
  await resource.dragTo(surface, {
    targetPosition: {
      x: surfaceBounds.width * 0.75,
      y: surfaceBounds.height * 0.7,
    },
  });
  await page.getByRole("button", { name: "资源", exact: true }).click();
  await expect
    .poll(async () => (await read()).scene.objects.length, { timeout: 30000 })
    .toBe(2);
  await expect
    .poll(
      async () =>
        (await read()).scene.objects.find(
          (o: { type: string }) => o.type === "image" || o.type === "svg",
        )?.x,
      { timeout: 30000 },
    )
    .toBeCloseTo(480, -1);
  const image = (await read()).scene.objects.find(
    (o: { type: string }) => o.type === "image" || o.type === "svg",
  );
  expect(image.assetObjectId).toBeTruthy();
  expect(image.resourceId).toBeTruthy();
  expect(image.x).toBeCloseTo(480, -1);
  expect(image.y).toBeCloseTo(336, -1);
  await page.reload();
  await open();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(
    (await read()).scene.objects.find(
      (o: { objectId: string }) => o.objectId === image.objectId,
    ),
  ).toMatchObject({ x: image.x, y: image.y });
  await page.screenshot({ path: "test-results/inline-artboard-live.png" });
  console.log(
    JSON.stringify({
      projectId: project.id,
      canvasId,
      designId,
      result: "saved-undone-redone-resource-dropped-reloaded",
    }),
  );
  await client.auth.signOut({ scope: "local" });
});
