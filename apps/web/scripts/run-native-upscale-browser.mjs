import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

assert(process.argv.includes('--submit'), 'Explicit paid-test approval required');
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const manifest = JSON.parse(await readFile('../../artifacts/paid-dialogue-live/native-size-20260914.json', 'utf8'));
const { fixture } = manifest;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY, options);
const owner = await db.from('chat_sessions').select('created_by').eq('id', fixture.sessionId).single();
assert.ifError(owner.error);
const account = await db.auth.admin.getUserById(owner.data.created_by);
const link = await db.auth.admin.generateLink({ type: 'magiclink', email: account.data.user.email });
const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
assert(login.data.session);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const report = { startedAt: new Date().toISOString(), canvasId: fixture.canvasId, transport: 'production_browser_toolbar' };
try {
  await page.addInitScript(session => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    localStorage.setItem('loomic:image-model-preference', JSON.stringify({ mode: 'manual', models: ['workspace:0a23c8b6-ce4c-46ca-9ac3-e0ffd37b5e51'], aspectRatio: 'auto' }));
  }, login.data.session);
  await page.goto(`http://localhost:3020/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeEnabled({ timeout: 30000 });
  await page.mouse.click(500, 800);
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(1500);
  // This dedicated QA canvas contains exactly one delivered image at this point.
  await page.mouse.click(320, 220);
  await expect(page.getByRole('button', { name: '高清', exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: '高清', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '高清分辨率' })).toHaveValue('hd');
  report.preview = await page.locator('[data-image-action-popover="upscale"]').innerText();
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/jobs/image-generation'), { timeout: 60000 });
  await page.getByRole('button', { name: '确认高清', exact: true }).click();
  const response = await submitted;
  const request = response.request().postDataJSON();
  report.request = { model: request.model, quality: request.quality, resolution: request.resolution, aspectRatio: request.aspect_ratio, referenceCount: request.input_images?.length };
  assert.equal(request.quality, 'standard');
  assert.equal(request.resolution, '2k');
  assert.equal(request.input_images?.length, 1);
  const payload = await response.json();
  assert(response.ok(), JSON.stringify(payload));
  const jobId = payload.job.id;
  report.jobId = jobId;
  let job;
  await expect.poll(async () => {
    const query = await db.from('background_jobs').select('status,result,error_message').eq('id', jobId).single();
    assert.ifError(query.error);
    job = query.data;
    return ['succeeded', 'failed', 'dead_letter', 'canceled'].includes(job.status);
  }, { timeout: 12 * 60000, intervals: [2500] }).toBe(true);
  report.status = job.status;
  report.result = JSON.parse(JSON.stringify(job.result, (key, value) => /url|token/i.test(key) ? '[redacted]' : value));
  assert.equal(job.status, 'succeeded', job.error_message);
  assert.equal(job.result.width, 2048);
  assert.equal(job.result.height, 1152);
  // Read the freshly persisted canvas and check that the live view received it.
  await expect.poll(async () => {
    const canvas = await db.from('canvases').select('content').eq('id', fixture.canvasId).single();
    assert.ifError(canvas.error);
    return canvas.data.content.elements.filter(e => !e.isDeleted && e.type === 'image').length;
  }, { timeout: 30000 }).toBe(2);
  await page.mouse.click(500, 850);
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(1500);
  report.canvasDelivery = true;
  await page.screenshot({ path: '../../artifacts/paid-dialogue-live/native-upscale-20260914.png' });
} catch (error) {
  report.error = error.message;
  await page.screenshot({ path: '../../artifacts/paid-dialogue-live/native-upscale-failure-20260914.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile('../../artifacts/paid-dialogue-live/native-upscale-20260914.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
