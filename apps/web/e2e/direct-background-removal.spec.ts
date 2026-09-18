import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp');
test.use({ trace: 'off', video: 'off', actionTimeout: 15000 });
test('one click removes background into a durable neighboring image with native GPT Image 2 API', async ({ page, request }, info) => {
 test.skip(process.env.SUPABASE_URL !== 'http://127.0.0.1:54421', 'Local only');
 test.setTimeout(480000);
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
      const realSample = process.env.LOOMIC_E2E_MATTING_SOURCE;
      const png = realSample ? await readFile(realSample) : await sharp(Buffer.from('<svg width="256" height="256"><rect width="256" height="256" fill="white"/><circle cx="128" cy="128" r="80" fill="red" stroke="blue" stroke-width="12"/></svg>')).png().toBuffer();
      const sourceMetadata = await sharp(png).metadata();
      let assetId: string | undefined;
      if (true) {
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

      const previewCalls: string[] = [];
      page.on('request', r => { if(r.url().includes('/subject-preview')) previewCalls.push(r.url()); });
      await page.goto(`/canvas?id=${id}`);
      await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
      await expect.poll(() => page.locator('canvas').evaluateAll(canvases => canvases.some(c => {
        const ctx = c.getContext('2d'); if (!ctx) return false;
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 200 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 80) return true;
        return false;
      })), { timeout: 30000 }).toBe(true);
      await page.mouse.click(80, 150);
      await page.keyboard.press('Control+a');
      const responsePromise = page.waitForResponse(r => r.url().includes('/api/jobs/image-generation') && r.request().method() === 'POST');
      await page.getByRole('button', { name: '去除背景', exact: true }).click();
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      const submitted = await response.json();
      const jobId = submitted.job.id;
      await expect(page.getByLabel('抠图主体选择区域')).toHaveCount(0);
      let job: any;
      await expect.poll(async () => {
        job = (await (await request.get(`${server}/api/jobs/${jobId}`, { headers })).json()).job;
        if(job.status === 'failed' || job.status === 'canceled') throw new Error(job.error_message || job.status);
        return job.status === 'succeeded' && Boolean(job.result?.canvas_element_id);
      }, { timeout: 420000, intervals: [1000, 2000, 5000] }).toBe(true);
      expect(job.result.model).toBe('gpt-image-2');
      expect(job.payload.model).toMatch(/^workspace:/);
      const readCanvas = async () => (await (await request.get(`${server}/api/canvases/${id}`, { headers })).json()).canvas;
      const saved = await readCanvas();
      const source = saved.content.elements.find((e: any) => e.id === 'source-image');
      const result = saved.content.elements.find((e: any) => e.id === job.result.canvas_element_id);
      expect(source.isDeleted).toBe(false);
      expect(result).toMatchObject({ x: 530, y: 150, width: 390, height: 390, isDeleted: false });
      const outputAsset = result.customData.assetId;
      expect(outputAsset).toBeTruthy();
      const download = await request.get(`${server}/api/uploads/${outputAsset}/content`, { headers });
      expect(download.ok()).toBe(true);
      const bytes = await download.body();
      expect(await sharp(bytes).metadata()).toMatchObject({ width: sourceMetadata.width, height: sourceMetadata.height, format: 'png', hasAlpha: true });
      const alpha = await sharp(bytes).extractChannel('alpha').raw().toBuffer();
      expect(alpha.some((v: number) => v < 200)).toBe(true);
      expect(alpha.some((v: number) => v > 200)).toBe(true);
      await page.reload();
      await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
      const reloaded = await readCanvas();
      expect(reloaded.content.elements.filter((e: any) => !e.isDeleted && e.type === 'image')).toHaveLength(2);
      expect(previewCalls).toEqual([]);
      await expect.poll(() => page.locator('canvas').evaluateAll(canvases => canvases.some(c => {
        const ctx = c.getContext('2d'); if (!ctx) return false;
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        let left = false, right = false;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 200 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 80) {
            if ((i / 4) % c.width < 500) left = true; else right = true;
          }
        }
        return left && right;
      })), { timeout: 30000 }).toBe(true);
      await page.screenshot({ path: info.outputPath('direct-background-removal.png') });
      console.log(JSON.stringify({ jobId, canvasId: id, model: job.result.model, sourcePreserved: true, outputAsset, durable: true }));
    } finally { await client.auth.signOut({ scope: 'local' }); }
});
