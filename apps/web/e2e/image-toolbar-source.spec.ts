import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp');
test.use({ trace: 'off', video: 'off', actionTimeout: 15000 });

for (const assetBacked of [false, true]) {
  test(`toolbar submits original pixels after reload (${assetBacked ? 'asset preview' : 'unannotated upload'})`, async ({ page, request }) => {
    test.skip(process.env.SUPABASE_URL !== 'http://127.0.0.1:54421', 'Local replica only');
    test.setTimeout(120000);
    const url = process.env.SUPABASE_URL!;
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
    const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user!.email! });
    const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { data: auth } = await client.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: 'magiclink' });
    const headers = { Authorization: `Bearer ${auth.session!.access_token}` };
    const server = 'http://127.0.0.1:3002';
    try {
      const created = await request.post(`${server}/api/projects`, { headers, data: { name: `Toolbar original regression ${Date.now()}` } });
      expect(created.ok()).toBe(true);
      const { project } = await created.json();
      const id = project.primaryCanvas.id;
      const size = assetBacked ? 1536 : 1024;
      const png = await sharp(Buffer.from(`<svg width="${size}" height="${size}"><rect width="100%" height="100%" fill="red"/><rect x="${size / 2}" width="${size / 2}" height="${size}" fill="blue"/><rect y="${size / 2}" width="${size / 2}" height="${size / 2}" fill="lime"/></svg>`)).png().toBuffer();
      let assetId: string | undefined;
      if (assetBacked) {
        const uploaded = await request.post(`${server}/api/uploads`, { headers, multipart: { file: { name: 'source.png', mimeType: 'image/png', buffer: png } } });
        expect(uploaded.ok()).toBe(true);
        assetId = (await uploaded.json()).asset.id;
      }
      const content = {
        elements: [{ id: 'source-image', type: 'image', x: 100, y: 150, width: 390, height: 390, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, fileId: 'source-file', status: 'saved', scale: [1, 1], crop: null, customData: assetId ? { assetId } : {} }],
        files: { 'source-file': { id: 'source-file', mimeType: 'image/png', created: Date.now(), dataURL: `data:image/png;base64,${png.toString('base64')}`, ...(assetId ? { assetId } : {}) } },
        appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff' },
      };
      expect((await request.put(`${server}/api/canvases/${id}`, { headers, data: { content } })).ok()).toBe(true);
      await page.addInitScript(({ key, session }) => {
        localStorage.setItem(key, JSON.stringify(session));
        localStorage.setItem('loomic:image-toolbar:v2', JSON.stringify({ pinned: ['remove-background', 'region-matting', 'split-layers', 'erase', 'download'], showLabels: true }));
      }, { key: `sb-${new URL(url).hostname.split('.')[0]}-auth-token`, session: auth.session });
      const payloads: any[] = [];
      const previewRequests: string[] = [];
      page.on('request', r => { if (r.url().includes('/subject-preview')) previewRequests.push(r.url()); });
      await page.route('**/api/jobs/image-generation', async route => {
        payloads.push(route.request().postDataJSON());
        // Inspect the real UI request without starting a model job or billing.
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_capture', message: 'Test request captured' } }) });
      });
      await page.goto(`/canvas?id=${id}`);
      await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
      await page.reload();
      await expect.poll(async () => page.locator('canvas').evaluateAll(cs => cs.some(c => {
        const ctx = c.getContext('2d'); if (!ctx) return false;
        const p = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < p.length; i += 4) if (p[i + 3] && p[i] > 200 && p[i + 1] < 70 && p[i + 2] < 70) return true;
        return false;
      })), { timeout: 30000 }).toBe(true);
      await page.mouse.click(80, 150);
      await page.keyboard.press('Control+a');
      await expect(page.getByRole('button', { name: '去除背景', exact: true })).toBeVisible();
      for (const name of ['去除背景', '图层拆分']) {
        const before = payloads.length;
        await page.getByRole('button', { name, exact: true }).click();
        await expect.poll(() => payloads.length).toBe(before + 1);
      }
      expect(previewRequests).toEqual([]);
      expect(payloads[0]).toMatchObject({ operation: 'remove_background', model: 'local:feynobg', placement_x: 530, placement_y: 150 });
      await expect(page.getByRole('button', { name: '主体选取', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('抠图主体选择区域')).toHaveCount(0);
      await page.getByRole('button', { name: '橡皮', exact: true }).click();
      const erase = (await page.getByLabel('橡皮涂抹区域').boundingBox())!;
      await page.mouse.move(erase.x + erase.width * 0.6, erase.y + erase.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(erase.x + erase.width * 0.8, erase.y + erase.height * 0.7, { steps: 8 });
      await page.mouse.up();
      await page.getByRole('button', { name: '应用', exact: true }).click();
      await expect.poll(() => payloads.length).toBe(3);
      for (const payload of payloads) {
        const bytes = Buffer.from(payload.input_images[0].split(',')[1], 'base64');
        expect(bytes.equals(png)).toBe(true);
        expect(await sharp(bytes).metadata()).toMatchObject({ width: size, height: size });
      }
      const mask = Buffer.from(payloads[2].mask_image.split(',')[1], 'base64');
      expect(await sharp(mask).metadata()).toMatchObject({ width: size, height: size });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '下载', exact: true }).click();
      const download = await downloadPromise;
      expect((await readFile((await download.path())!)).equals(png)).toBe(true);
      // A local crop must use original pixels and acquire a new file identity,
      // not snap back to the source asset on a subsequent operation.
      await page.getByRole('button', { name: '更多图片工具', exact: true }).click();
      await page.getByRole('button', { name: '裁剪', exact: true }).click();
      await expect(page.getByLabel('裁剪宽度')).toHaveValue(String(size));
      await page.getByLabel('裁剪宽度').fill(String(size / 2));
      await page.getByLabel('裁剪高度').fill(String(size / 2));
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByLabel('裁剪宽度')).toBeHidden();
      await page.getByRole('button', { name: '去除背景', exact: true }).click();
      await expect.poll(() => payloads.length).toBe(4);
      const cropped = Buffer.from(payloads[3].input_images[0].split(',')[1], 'base64');
      expect(await sharp(cropped).metadata()).toMatchObject({ width: size / 2, height: size / 2, format: 'png' });
      const expected = await sharp(png).extract({ left: size / 4, top: size / 4, width: size / 2, height: size / 2 }).ensureAlpha().raw().toBuffer();
      expect((await sharp(cropped).ensureAlpha().raw().toBuffer()).equals(expected)).toBe(true);
    } finally { await client.auth.signOut({ scope: 'local' }); }
  });
}
