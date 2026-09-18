import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

test.use({ trace: 'off', video: 'off' });
test('template CR text auto-saves and updates preview without pressing save', async ({ page, request }, info) => {
  test.skip(process.env.SUPABASE_URL !== 'http://127.0.0.1:54421', 'Local replica only');
  test.setTimeout(150000);
  const url = process.env.SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user!.email! });
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: auth } = await client.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: 'magiclink' });
  const headers = { Authorization: `Bearer ${auth.session!.access_token}` };
  const server = 'http://127.0.0.1:3002';
  try {
    const created = await request.post(`${server}/api/projects`, { headers, data: { name: `Finish preview regression ${Date.now()}` } });
    expect(created.ok()).toBe(true);
    const { project } = await created.json();
    const id = project.primaryCanvas.id;
    const canvas = (await (await request.get(`${server}/api/canvases/${id}`, { headers })).json()).canvas;
    const create = await request.post(`${server}/api/designs`, { headers, data: {
      request_id: crypto.randomUUID(), canvas_id: id, expected_canvas_revision: canvas.revision,
      canvas_element_id: crypto.randomUUID(), name: 'Preview regression', width: 640, height: 360,
      background: '#ffffff', node: { x: 100, y: 150, width: 640, height: 360 },
    } });
    expect(create.ok()).toBe(true);
    const designId = (await create.json()).design_id;
    const readDesign = async () => (await (await request.get(`${server}/api/designs/${designId}`, { headers })).json()).design;
    const source = (await (await request.get(`${server}/api/designs/4e9585ba-2f23-41d6-86aa-4fe01436511d`, { headers })).json()).design;
    const originalText = source.scene.objects.find((object: any) => object.fontFaceId && object.type === 'textbox');
    const seed = await request.post(`${server}/api/designs/${designId}/mutations`, { headers, data: {
      design_id: designId, expected_revision: (await readDesign()).revision, idempotency_key: crypto.randomUUID(),
      commands: [{ action: 'scene.replace', scene: { schemaVersion: 1, engine: 'fabric', canvas: { width: 640, height: 360, background: '#ffffff' }, objects: [
        { ...originalText, objectId: crypto.randomUUID(), objectVersion: 1, x: 20, y: 20, width: 550, height: 250, fontSize: 60, text: '元旦\rHAPPY NEW YEAR\r\r', zIndex: 0 }
      ] } }]
    } });
    expect(seed.ok()).toBe(true);
    await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
      key: `sb-${new URL(url).hostname.split('.')[0]}-auth-token`, session: auth.session,
    });
    await page.goto(`/canvas?id=${id}`);
    const board = page.locator(`[data-testid="design-node-preview"][data-design-id="${designId}"]`);
    await expect(board).toBeVisible();
    await board.dblclick({ force: true });
    const editor = page.getByTestId('design-inline-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('canvas').first()).toBeVisible();
    // Establish an old preview, then edit and finish from a saved document.
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(editor).toBeHidden({ timeout: 75000 });
    await expect(board.locator('img')).toBeVisible();
    const pixels = () => board.locator('img').evaluate((image: HTMLImageElement) => {
      if (!image.complete || !image.naturalWidth) return '';
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d')!.drawImage(image, 0, 0); return canvas.toDataURL();
    });
    const before = await pixels();
    expect(before.length).toBeGreaterThan(100);
    // Reproduce a long-lived canvas that keeps serving the old preview
    // metadata even after the authoritative design has advanced.
    const saved = (await (await request.get(`${server}/api/canvases/${id}`, { headers })).json()).canvas;
    const staleMetadata = saved.content.elements.find((e: any) => e.customData?.designId === designId).customData;
    await page.route(`**/api/canvases/${id}`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      data.canvas.content.elements = data.canvas.content.elements.map((e: any) => e.customData?.designId === designId ? { ...e, customData: staleMetadata } : e);
      await route.fulfill({ response, json: data });
    });
    await board.dblclick({ force: true });
    await expect(editor).toBeVisible();
    await expect(editor.locator('canvas').first()).toBeVisible();
    const beforeEditRevision = (await readDesign()).revision;
    await editor.getByRole('button', { name: '添加文字', exact: true }).click();
    // No save or finish action until both auto-save and background preview succeed.
    await expect.poll(async () => {
      const document = await readDesign();
      return document.revision > beforeEditRevision && document.preview_revision === document.revision && document.preview_status === 'ready';
    }, { timeout: 45000 }).toBe(true);
    expect((await readDesign()).scene.objects.find((object: any) => object.fontFaceId).fontFaceId).toBe(originalText.fontFaceId);
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    if (await editor.getByText('保存并退出', { exact: true }).isVisible()) await editor.getByText('保存并退出', { exact: true }).click();
    await expect(editor).toBeHidden({ timeout: 75000 });
    await expect.poll(pixels).not.toBe(before);
    const after = await pixels();
    expect(after.length).toBeGreaterThan(100);
    await page.screenshot({ path: info.outputPath('finished-preview.png') });
    await page.reload();
    await expect(board.locator('img')).toBeVisible();
    await expect.poll(pixels).toBe(after);
  } finally { await client.auth.signOut({ scope: 'local' }); }
});


