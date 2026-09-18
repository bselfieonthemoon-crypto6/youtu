// Read-only visual check of the dedicated paid-dialogue QA fixture.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
const file = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10);
assert(file, '--fixture=<manifest> required');
const manifest = JSON.parse(await readFile(resolve(file), 'utf8'));
const fixture = manifest.fixture ?? manifest;
assert(fixture.canvasId && fixture.sessionId, 'QA canvas/session required');
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY, opts);
const { data: session, error: sessionReadError, status: sessionReadStatus } = await admin.from('chat_sessions').select('canvas_id,created_by').eq('id', fixture.sessionId).single();
assert(!sessionReadError, `QA session lookup failed (HTTP ${sessionReadStatus}, code ${sessionReadError?.code || 'transport'}); check local services before interpreting this as missing data`);
assert.equal(session?.canvas_id, fixture.canvasId, 'Session must belong to QA canvas');
const { data: canvas } = await admin.from('canvases').select('name,content').eq('id', fixture.canvasId).single();
const { data: latestMessage } = await admin.from('chat_messages').select('content').eq('session_id', fixture.sessionId)
  .eq('role', 'user').order('created_at', { ascending: false }).limit(1).maybeSingle();
const { data: account } = await admin.auth.admin.getUserById(session.created_by);
assert(account.user?.email && canvas);
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.user.email });
const { data: login } = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
assert(login.session);
const label = (process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? 'latest').replace(/[^a-zA-Z0-9_-]/g, '_');
const directory = resolve('../../artifacts/paid-dialogue-browser');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  const failedRequests = [];
  const safeLocation = text => text.replace(/https?:\/\/[^\s"<>]+/g, value => {
    try { const url = new URL(value); return url.pathname.startsWith('/_next/static/') ? url.pathname : '[url]'; }
    catch { return '[url]'; }
  });
  page.on('requestfailed', request => failedRequests.push({ method: request.method(),
    path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  page.on('pageerror', error => pageErrors.push({ name: error.name,
    message: safeLocation(error.message), stack: error.stack && safeLocation(error.stack).slice(0, 1800) }));
  await page.addInitScript(value => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)), login.session);
  await page.goto(`http://localhost:3020/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByText('连接已断开，正在重连...', { exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  if (process.argv.includes('--offline-unload')) {
    await page.waitForTimeout(3000);
    await page.context().setOffline(true);
    await page.mouse.click(500, 850);
    // Guarantee a pending save in this dedicated QA scene; undo before reconnect.
    await page.keyboard.press('r');
    await page.mouse.move(420, 840);
    await page.mouse.down();
    await page.mouse.move(480, 880);
    await page.mouse.up();
    await page.waitForTimeout(150);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.waitForTimeout(1500);
    await page.keyboard.press('Control+z');
    await page.context().setOffline(false);
  }
  if (process.argv.includes('--offline-idle')) {
    await page.context().setOffline(true);
    await page.waitForTimeout(10000);
    await page.context().setOffline(false);
  }
  const disconnectJob = process.argv.find(arg => arg.startsWith('--disconnect-job='))?.slice(17);
  let disconnectEvidence;
  if (disconnectJob) {
    const readJob = async () => {
      const result = await admin.from('background_jobs').select('id,status').eq('id', disconnectJob).eq('session_id', fixture.sessionId).single();
      assert.ifError(result.error); return result.data;
    };
    const before = await readJob();
    assert(!['succeeded', 'dead_letter', 'failed', 'canceled'].includes(before.status), `Already terminal: ${before.status}`);
    disconnectEvidence = { jobId: disconnectJob, beforeStatus: before.status, offlineAt: new Date().toISOString() };
    await page.context().setOffline(true);
    console.log(`Browser offline during ${disconnectJob}`);
    let terminal;
    await expect.poll(async () => {
      terminal = await readJob();
      return ['succeeded', 'dead_letter', 'failed', 'canceled'].includes(terminal.status);
    }, { timeout: 900000, intervals: [5000] }).toBe(true);
    disconnectEvidence.terminalStatus = terminal.status;
    assert.equal(terminal.status, 'succeeded');
    await page.context().setOffline(false);
  }
  const historyLoaded = page.waitForResponse(response => response.url().includes(`/api/sessions/${fixture.sessionId}/messages`)
    && response.request().method() === 'GET' && response.ok());
  await page.reload();
  await historyLoaded;
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByText('连接已断开，正在重连...', { exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  if (latestMessage?.content?.trim()) await expect(page.getByText(latestMessage.content, { exact: true }).last()).toBeVisible({ timeout: 30000 });
  // Asset decoding/job-state hydration follow the history response. This is a
  // bounded visual settling delay, not an assertion that generation succeeded.
  await page.waitForTimeout(2500);
  const settleMs = Number(process.argv.find(arg => arg.startsWith('--settle-ms='))?.slice(12) ?? 0);
  assert(Number.isFinite(settleMs) && settleMs >= 0 && settleMs <= 30000);
  if (settleMs) await page.waitForTimeout(settleMs);
  if (process.argv.includes('--fit')) {
    // Viewport-only QA action: Excalidraw zoom-to-content. No object edits.
    await page.mouse.click(600, 850);
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(500);
  }
  // Scroll only the message list; never scroll the canvas/root ancestors.
  if (process.argv.includes('--latest')) {
    await page.locator('div.overflow-y-auto.overflow-x-hidden.flex.flex-col.gap-6').evaluateAll(nodes => {
      for (const node of nodes) node.scrollTop = node.scrollHeight;
    });
    await page.waitForTimeout(300);
  }
  const previewJob = process.argv.find(arg => arg.startsWith('--preview-job='))?.slice(14);
  if (previewJob) {
    assert(/^[0-9a-f-]{36}$/.test(previewJob));
    const preview = page.locator(`img[src*="${previewJob}"]`).first();
    await expect(preview).toBeVisible({ timeout: 30000 });
    await preview.click();
    await page.waitForTimeout(500);
  }
  const showErrorText = process.argv.find(arg => arg.startsWith('--show-error-text='))?.slice(18);
  const showErrorJob = process.argv.find(arg => arg.startsWith('--show-error-job='))?.slice(17);
  if (showErrorJob) {
    assert(/^[0-9a-f-]{36}$/.test(showErrorJob));
    const card = page.locator(`#tool-execution-job-result-${showErrorJob}`);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('图片生成失败');
    await expect(card.getByRole('button', { name: '继续等待', exact: true })).toHaveCount(0);
  }
  if (showErrorText) {
    const failure = page.getByText(showErrorText, { exact: false }).first();
    await failure.scrollIntoViewIfNeeded();
    await expect(failure).toBeVisible();
  }
  await page.screenshot({ path: resolve(directory, `${fixture.canvasId}-${label}.png`) });
  // Read after reconnect: the initial snapshot may still contain a running placeholder.
  const refreshedCanvas = await admin.from('canvases').select('content').eq('id', fixture.canvasId).single();
  assert.ifError(refreshedCanvas.error);
  const elements = (refreshedCanvas.data.content?.elements ?? []).filter(element => !element.isDeleted);
  if (disconnectJob) {
    const recovered = page.locator(`img[src*="${disconnectJob}"]`).first();
    await expect.poll(() => recovered.evaluate(img => img.complete && img.naturalWidth > 0), { timeout: 30000 }).toBe(true);
    assert(elements.some(element => element.id === disconnectJob && element.type === 'image'), 'Delivered image must replace canvas placeholder');
  }
  const imageDecoding = await page.locator('img').evaluateAll(images => images.map(image => ({
    alt: image.alt, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
  })));
  if (process.argv.includes('--offline-unload')) {
    assert(failedRequests.some(request => request.method === 'PUT' && request.path === `/api/canvases/${fixture.canvasId}`
      && request.error === 'net::ERR_INTERNET_DISCONNECTED'), 'Probe must exercise the offline canvas save, not just an idle unload');
    assert.equal(pageErrors.length, 0, 'Offline best-effort save must not leak an unhandled rejection');
  }
  const evidence = { canvasId: fixture.canvasId, sessionId: fixture.sessionId,
    pageReloaded: true, composerVisible: true, ...(showErrorJob ? { failedJobId: showErrorJob, failedCardVisible: true } : {}), ...(showErrorText ? { visibleErrorText: showErrorText } : {}), disconnectEvidence, canvasElements: elements.map(element => ({
      id: element.id, type: element.type, width: element.width, height: element.height,
    })), imageDecoding, pageErrors, failedRequests,
    screenshot: resolve(directory, `${fixture.canvasId}-${label}.png`), generationRequestsSubmitted: 0 };
  await writeFile(resolve(directory, `${fixture.canvasId}-${label}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
