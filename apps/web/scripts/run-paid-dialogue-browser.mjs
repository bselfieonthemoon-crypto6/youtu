// Sends one real user turn through the production UI. Requires explicit --submit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert(process.argv.includes('--submit'), 'Explicit --submit required: real model/image fees may occur');
const file = arg('fixture'), prompt = arg('prompt');
assert(file && prompt, '--fixture and --prompt required');
const attachmentPaths = (() => {
  const raw = arg('attachments');
  if (raw === undefined) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--attachments must be a JSON array of local file paths'); }
  assert(Array.isArray(parsed) && parsed.length > 0 && parsed.every(path => typeof path === 'string' && path.trim()),
    '--attachments must be a non-empty JSON array of local file paths');
  return parsed.map(path => resolve(path));
})();
for (const attachmentPath of attachmentPaths) {
  const info = await stat(attachmentPath);
  assert(info.isFile(), `Attachment is not a file: ${basename(attachmentPath)}`);
}
const autonomy = arg('autonomy');
assert(autonomy === undefined || autonomy === 'off', 'Unattended execution has been removed');
const timeoutMinutes = Number(arg('timeout-minutes') ?? 15);
assert(Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= 60);
const manifest = JSON.parse(await readFile(resolve(file), 'utf8'));
const productDefaults = process.argv.includes('--product-defaults');
if (productDefaults) {
  for (const name of ['text-model', 'image-model', 'image-mode', 'ratio'])
    assert.equal(arg(name), undefined, `--product-defaults forbids --${name} overrides`);
}
const fixture = manifest.fixture ?? manifest;
assert(fixture.canvasId && fixture.sessionId);
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY, opts);
const { data: session, error: sessionReadError, status: sessionReadStatus } = await admin.from('chat_sessions').select('canvas_id,created_by').eq('id', fixture.sessionId).single();
assert(!sessionReadError, `QA session lookup failed (HTTP ${sessionReadStatus}, code ${sessionReadError?.code || 'transport'}); check local services before interpreting this as missing data`);
assert.equal(session?.canvas_id, fixture.canvasId);
const { data: account } = await admin.auth.admin.getUserById(session.created_by);
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.user.email });
const { data: login } = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
assert(login.session);
const imageModel = productDefaults ? undefined : arg('image-model') ?? manifest.models?.image?.id ?? manifest.models?.image;
const imageMode = productDefaults ? 'auto' : arg('image-mode') ?? 'manual';
assert(['auto', 'manual'].includes(imageMode), '--image-mode must be auto or manual');
const textModel = productDefaults ? undefined : arg('text-model') ?? manifest.models?.text?.id ?? manifest.models?.text;
const raceStaleHistory = process.argv.includes('--race-stale-history');
const startedAt = new Date().toISOString();
const report = { startedAt, canvasId: fixture.canvasId, sessionId: fixture.sessionId, prompt,
  transport: 'production_browser_ui', runId: null, status: null, assistant: '', tools: [], toolStarts: [], plans: [], sentRunCommands: 0,
  textDeltaCount: 0, firstTextAt: null, lastTextAt: null,
  ...(raceStaleHistory ? { staleHistoryRace: {
    enabled: true, initialHistoryObserved: false, snapshotCapturedBeforeSend: false,
    releasedAfterFirstDelta: false, currentAssistantVisible: false,
  } } : {}) };
const attachmentEvidence = attachments => ({
  count: attachments.length,
  ordered: attachments.map((attachment, index) => ({
    position: index + 1,
    assetIdDigest: createHash('sha256').update(String(attachment.assetId)).digest('hex').slice(0, 16),
    name: typeof attachment.name === 'string' ? attachment.name.slice(0, 160) : undefined,
    mimeType: attachment.mimeType,
  })),
});
const clean = value => JSON.parse(JSON.stringify(value, (key, nested) => {
  if (/token|secret|password|authorization|signed.?url/i.test(key)) return '[redacted]';
  if (typeof nested === 'string') return nested.replace(/https?:\/\/[^\s"<>]+/g, '[url]').replace(/data:image\/[^\s]+/g, '[image]');
  return nested;
}));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let timer;
let streamProbe;
let page;
let releaseStaleHistory = async () => {};
let staleHistoryReleaseTimer;
try {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const staleRace = raceStaleHistory ? report.staleHistoryRace : null;
  const staleRaceState = { pending: null, releasePromise: null, deltaReleasePromise: null };
  releaseStaleHistory = async (reason) => {
    if (!staleRace || staleRace.releasedAt || staleRaceState.releasePromise) return staleRaceState.releasePromise;
    if (!staleRaceState.pending) return undefined;
    const pending = staleRaceState.pending;
    staleRaceState.releasePromise = (async () => {
      staleRace.releaseReason = reason;
      staleRace.releasedAt = new Date().toISOString();
      staleRace.releasedAfterFirstDelta = Boolean(staleRace.firstDeltaAt)
        && Date.parse(staleRace.releasedAt) >= Date.parse(staleRace.firstDeltaAt);
      try {
        await pending.route.fulfill({ response: pending.response });
        staleRace.released = true;
      } catch (error) {
        staleRace.releaseError = String(error.message);
      } finally {
        staleRaceState.pending = null;
        if (staleHistoryReleaseTimer) clearTimeout(staleHistoryReleaseTimer);
      }
    })();
    return staleRaceState.releasePromise;
  };
  if (staleRace) {
    const messagesPath = `/api/sessions/${fixture.sessionId}/messages`;
    await page.route('**/api/sessions/**/messages', async route => {
      const request = route.request();
      if (request.method() !== 'GET' || new URL(request.url()).pathname !== messagesPath || staleRace.initialHistoryObserved)
        return route.continue();
      staleRace.initialHistoryObserved = true;
      staleRace.historyRequestAt = new Date().toISOString();
      try {
        const response = await route.fetch();
        staleRace.snapshotFetchedAt = new Date().toISOString();
        staleRaceState.pending = { route, response };
        // A held route must never leave this browser process waiting forever.
        staleHistoryReleaseTimer = setTimeout(() => {
          void releaseStaleHistory('safety_timeout');
        }, 35_000);
      } catch (error) {
        staleRace.captureError = String(error.message);
        await route.continue();
      }
    });
  }
  if (process.argv.includes('--observe-stream')) {
    report.pageErrors = [];
    report.failedRequests = [];
    page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
    page.on('requestfailed', request => report.failedRequests.push({
      at: new Date().toISOString(), path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    }));
  }
  await page.addInitScript(({ session, image, model, aspectRatio, imageMode, productDefaults }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    if (productDefaults) return; // Let the product choose; do not inject fixture preferences.
    if (image || imageMode === 'auto') localStorage.setItem('loomic:image-model-preference', JSON.stringify({ mode: imageMode, models: imageMode === 'auto' ? [] : [image], aspectRatio }));
    if (model) localStorage.setItem('loomic:agent-model', model);
  }, { session: login.session, image: imageModel, model: textModel, aspectRatio: arg('ratio') ?? 'auto', imageMode, productDefaults });
  let requestId, resolveTerminal, connectionUsed = false;
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      connectionUsed = true;
      try {
        const frame = JSON.parse(String(payload));
        if (frame.action === 'agent.run' && frame.payload?.sessionId === fixture.sessionId) {
          requestId = frame.requestId;
          report.sentRunCommands++;
          report.sentAt = new Date().toISOString();
          if (staleRace?.snapshotFetchedAt) {
            staleRace.snapshotCapturedBeforeSend = Date.parse(staleRace.snapshotFetchedAt) <= Date.parse(report.sentAt);
          }
          report.request = clean(frame.payload);
          if (attachmentPaths.length) {
            try {
              const attachments = frame.payload.attachments;
              assert(Array.isArray(attachments), 'UI did not include the uploaded attachments in agent.run');
              assert.equal(attachments.length, attachmentPaths.length, 'UI changed the uploaded attachment count');
              assert.deepEqual(attachments.map(attachment => attachment.name), attachmentPaths.map(path => basename(path)),
                'UI changed the uploaded attachment order');
              assert.equal(new Set(attachments.map(attachment => attachment.assetId)).size, attachmentPaths.length,
                'Distinct local uploads resolved to duplicate asset IDs');
              report.uploadedAttachments = attachmentEvidence(attachments);
              report.request.attachments = report.uploadedAttachments;
            } catch (error) {
              report.attachmentProbeError = String(error.message);
              // Sending has already happened. Preserve the assertion failure,
              // but wait for the real terminal event; never abandon a paid run
              // and encourage a duplicate retry because a probe failed.
            }
          }
          console.log('browser sent one agent.run');
        }
      } catch { /* Not a JSON command. */ }
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type === 'command.ack' && frame.requestId === requestId && frame.action === 'agent.run') {
          report.runId = frame.payload.runId;
          console.log(`run accepted ${report.runId}`);
        }
        if (frame.type === 'error' && requestId && frame.requestId === requestId) {
          report.status = 'request_failed'; report.error = clean(frame); resolveTerminal();
        }
        const event = frame.event;
        if (frame.type !== 'event' || !report.runId || event?.runId !== report.runId) return;
        if (event.type === 'message.delta') {
          report.assistant += event.delta;
          report.textDeltaCount++;
          report.firstTextAt ??= new Date().toISOString();
          report.lastTextAt = new Date().toISOString();
          if (staleRace && !staleRace.firstDeltaAt) {
            staleRace.firstDeltaAt = report.firstTextAt;
            staleRaceState.deltaReleasePromise = new Promise(resolve => {
              setTimeout(() => {
                void releaseStaleHistory('first_delta').finally(resolve);
              }, 250);
            });
          }
          if (process.argv.includes('--observe-stream') && !streamProbe) {
            streamProbe = (async () => {
              await page.waitForTimeout(1200);
              const directory = resolve(dirname(file), 'browser-turns');
              await mkdir(directory, { recursive: true });
              const screenshot = resolve(directory, `${startedAt.replace(/[:.]/g, '-')}-stream.png`);
              report.streamProbe = { at: new Date().toISOString(), terminalAtCaptureStart: report.status,
                deltaCount: report.textDeltaCount, screenshot };
              await page.screenshot({ path: screenshot });
              report.streamProbe.terminalAtCaptureEnd = report.status;
            })().catch(error => { report.streamProbeError = String(error.message); });
          }
        }
        if (event.type === 'plan.updated') report.plans.push(clean(event));
        if (event.type === 'tool.started') report.toolStarts.push(clean(event));
        if (event.type === 'tool.completed' || event.type === 'tool.failed') {
          report.tools.push(clean(event)); console.log(`${event.type}: ${event.toolName}`);
        }
        if (['run.completed', 'run.failed', 'run.canceled'].includes(event.type)) {
          report.status = event.type;
          if (event.error) report.error = clean(event.error);
          resolveTerminal();
        }
      } catch { /* Ignore unrelated transport payloads. */ }
    });
  });
  await page.goto(`http://localhost:3020/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`);
  const composer = page.getByRole('textbox', { name: '输入消息', exact: true });
  try {
    await expect(composer).toBeEnabled({ timeout: 30000 });
  } catch (error) {
    if (staleRace) {
      staleRace.applicable = false;
      staleRace.cannotApply = staleRace.snapshotFetchedAt
        ? 'composer_disabled_while_initial_history_is_held' : 'initial_history_snapshot_not_captured';
      await releaseStaleHistory('not_applicable');
      throw new Error(`race_stale_history_not_applicable:${staleRace.cannotApply}`);
    }
    throw error;
  }
  await page.getByText('连接已断开，正在重连...', { exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  try {
    await expect.poll(() => connectionUsed, { timeout: 30000 }).toBe(true);
  } catch (error) {
    if (staleRace) {
      staleRace.applicable = false;
      staleRace.cannotApply = staleRace.snapshotFetchedAt
        ? 'websocket_not_ready_while_initial_history_is_held' : 'websocket_not_ready_before_initial_history_capture';
      await releaseStaleHistory('not_applicable');
      throw new Error(`race_stale_history_not_applicable:${staleRace.cannotApply}`);
    }
    throw error;
  }
  // Wait for the persisted history, avoiding a send during initial hydration.
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: '自动执行', exact: true })).toHaveCount(0);
  if (staleRace) {
    try {
      await expect.poll(() => Boolean(staleRace.snapshotFetchedAt), { timeout: 5_000 }).toBe(true);
    } catch {
      staleRace.applicable = false;
      staleRace.cannotApply = staleRace.captureError
        ? 'initial_history_snapshot_capture_failed' : 'initial_history_snapshot_not_captured';
      await releaseStaleHistory('not_applicable');
      throw new Error(`race_stale_history_not_applicable:${staleRace.cannotApply}`);
    }
    if (!staleRaceState.pending) {
      staleRace.applicable = false;
      staleRace.cannotApply = 'initial_history_snapshot_was_not_held';
      await releaseStaleHistory('not_applicable');
      throw new Error(`race_stale_history_not_applicable:${staleRace.cannotApply}`);
    }
    staleRace.applicable = true;
  }
  if (attachmentPaths.length) {
    const input = page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp,image/gif"]');
    await expect(input).toHaveCount(1);
    await input.setInputFiles(attachmentPaths);
    await expect.poll(() => page.locator('img[alt="Attachment"]').count(), { timeout: 60_000 })
      .toBe(attachmentPaths.length);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled({ timeout: 60_000 });
  }
  report.autonomyEnabled = false;
  let designPreviewBefore = null;
  let designRevisionBefore = null;
  if (arg('expect-design')) {
    const previousDesign = await admin.from('design_documents').select('revision,preview_asset_object_id,preview_revision')
      .eq('id', arg('expect-design')).single();
    assert.ifError(previousDesign.error);
    designRevisionBefore = previousDesign.data.revision;
    await page.mouse.click(600, 850);
    await page.keyboard.press('Shift+1');
    const previousBoard = page.locator(`[data-testid="design-node-preview"][data-design-id="${arg('expect-design')}"]`);
    await expect(previousBoard).toBeVisible({ timeout: 30000 });
    if (previousDesign.data.preview_asset_object_id) {
      await expect(previousBoard.locator('img').first()).toBeVisible({ timeout: 60000 });
      await expect.poll(() => previousBoard.locator('img').evaluateAll(images => images.some(img => img.complete && img.naturalWidth > 0)),
        { timeout: 60000 }).toBe(true);
      designPreviewBefore = await previousBoard.locator('img').first().getAttribute('src');
    }
  }
  if (process.argv.includes('--observe-stream')) {
    await page.mouse.click(600, 850);
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(500);
  }
  await composer.fill(prompt);
  if (arg('send-at')) {
    const sendAt = Date.parse(arg('send-at'));
    const delay = sendAt - Date.now();
    assert(Number.isFinite(sendAt) && delay > 0 && delay <= 60000, 'Shared send time must be within the next minute after browser readiness');
    await page.waitForTimeout(delay);
  }
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser_turn_timeout_inspect_before_retry')), timeoutMinutes * 60000); });
  await Promise.race([terminal, timeout]);
  if (staleRace) {
    assert(staleRace.snapshotFetchedAt && staleRace.snapshotCapturedBeforeSend,
      'Stale history snapshot was not captured before the current UI send');
    assert(staleRace.firstDeltaAt, 'No streamed assistant delta arrived before stale history release');
    await staleRaceState.deltaReleasePromise;
    assert(staleRace.released && staleRace.releasedAfterFirstDelta,
      'Stale history was not released after the first streamed assistant delta');
    const assistantText = report.assistant.trim();
    assert(assistantText, 'No current assistant text was received over the stream');
    await expect.poll(async () => {
      const text = await page.locator('[aria-live="polite"]').innerText();
      return text.replace(/\s+/g, ' ').includes(assistantText.replace(/\s+/g, ' '));
    }, { timeout: 30_000 }).toBe(true);
    staleRace.currentAssistantVisible = true;
  }
  assert(!report.attachmentProbeError, report.attachmentProbeError);
  if (process.argv.includes('--observe-stream')) {
    await streamProbe;
    assert(report.status === 'run.completed', 'Observed stream did not complete');
    assert(report.streamProbe && !report.streamProbeError, 'No streaming screenshot captured');
    assert.equal(report.streamProbe.terminalAtCaptureEnd, null, 'Screenshot was taken after streaming finished');
    assert(report.textDeltaCount > report.streamProbe.deltaCount, 'No text arrived after streaming capture');
  }
  if (process.argv.includes('--wait-images')) {
    let jobs = [];
    const submitted = await admin.from('background_jobs').select('id')
      .eq('session_id', fixture.sessionId).eq('job_type', 'image_generation').gte('created_at', startedAt);
    assert.ifError(submitted.error);
    assert(submitted.data.length > 0, 'The conversation ended without an image job; this is not a delivery pass');
    await expect.poll(async () => {
      const result = await admin.from('background_jobs').select('id,status,target_kind,design_id,result,error_message')
        .eq('session_id', fixture.sessionId).eq('job_type', 'image_generation').gte('created_at', startedAt);
      assert.ifError(result.error);
      jobs = result.data;
      return jobs.length > 0 && jobs.every(job => ['succeeded', 'failed', 'dead_letter', 'canceled'].includes(job.status));
    }, { timeout: timeoutMinutes * 60000, intervals: [2000] }).toBe(true);
    report.imageJobs = clean(jobs);
    const failedJobs = jobs.filter(job => job.status !== 'succeeded');
    if (failedJobs.length) {
      const deadline = Date.now() + 30_000;
      report.terminalFailureCards = [];
      for (const job of failedJobs) {
        const card = page.locator(`#tool-execution-job-result-${job.id}`);
        const remaining = () => Math.max(1, deadline - Date.now());
        await card.scrollIntoViewIfNeeded({ timeout: remaining() });
        await expect(card).toContainText(job.status === 'canceled' ? '图片生成已取消' : '图片生成失败', { timeout: remaining() });
        await expect(card.getByRole('button', { name: '继续等待', exact: true })).toHaveCount(0, { timeout: remaining() });
        report.terminalFailureCards.push({ jobId: job.id, status: job.status,
          terminalCardVisible: true, noContinueWaiting: true });
      }
      assert.fail('Image delivery failed after the terminal failure card was visible; inspect recorded jobs before retrying');
    }
    assert(jobs.every(job => job.status === 'succeeded'), 'Image delivery failed; inspect recorded jobs before retrying');
    // Native overlays are intentionally culled outside the visible viewport.
    // Fit the existing scene before asserting delivery; do not reload it.
    await page.mouse.click(600, 850);
    await page.keyboard.press('Shift+1');
    const designId = arg('expect-design');
    // A succeeded row is not proof that the browser decoded the delivered
    // pixels. Wait on each new chat preview before capturing the live canvas.
    if (!designId) {
      for (const job of jobs) {
        const preview = page.locator(`img[src*="${job.id}"]`).first();
        await expect(preview).toBeAttached({ timeout: 60000 });
        await preview.scrollIntoViewIfNeeded();
        await expect.poll(() => preview.evaluate(img => img.complete && img.naturalWidth > 0),
          { timeout: 60000 }).toBe(true);
      }
      report.liveImagePreviews = { withoutReload: true, decoded: true, count: jobs.length };
    }
    if (designId) {
      assert(/^[0-9a-f-]{36}$/.test(designId));
      assert(jobs.every(job => job.target_kind === 'design' && job.design_id === designId), 'Wrong delivery destination');
      const board = page.locator(`[data-testid="design-node-preview"][data-design-id="${designId}"]`);
      await expect(board).toBeVisible({ timeout: 30000 });
      await expect.poll(async () => {
        const current = await admin.from('design_documents').select('revision,preview_revision').eq('id', designId).single();
        assert.ifError(current.error);
        return current.data.revision > designRevisionBefore && current.data.preview_revision === current.data.revision;
      }, { timeout: 120000, intervals: [1000] }).toBe(true);
      await expect.poll(() => board.locator('img').evaluateAll(images => images.some(img => img.complete && img.naturalWidth > 0)),
        { timeout: 60000 }).toBe(true);
      await expect.poll(async () => {
        const next = await board.locator('img').first().getAttribute('src');
        const stale = await board.getByText('预览待更新', { exact: true }).count();
        return !!next && next !== designPreviewBefore && stale === 0;
      }, { timeout: 120000, intervals: [1000] }).toBe(true);
      report.liveDesignPreview = { designId, withoutReload: true, decoded: true, changedFromPrevious: true, stale: false };
    }
    await page.mouse.click(600, 850);
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(700);
    const screenshot = resolve(dirname(file), `${startedAt.replace(/[:.]/g, '-')}-live-delivery.png`);
    await page.screenshot({ path: screenshot });
    report.liveDeliveryScreenshot = screenshot;
  }
  if (process.argv.includes('--disconnect-during-image')) {
    const jobsSinceStart = async () => {
      const result = await admin.from('background_jobs').select('id,status,result')
        .eq('session_id', fixture.sessionId).eq('job_type', 'image_generation').gte('created_at', startedAt);
      assert.ifError(result.error);
      return result.data;
    };
    const initialJobs = await jobsSinceStart();
    assert.equal(initialJobs.length, 1, 'Disconnect probe requires exactly one newly submitted image job');
    assert(['queued', 'pending', 'processing', 'retrying', 'running'].includes(initialJobs[0].status),
      `Job already terminal (${initialJobs[0].status}); cannot claim disconnect-during-generation coverage`);
    report.disconnectProbe = { jobId: initialJobs[0].id, beforeStatus: initialJobs[0].status, offlineAt: new Date().toISOString() };
    await page.context().setOffline(true);
    console.log(`Browser offline while image job ${initialJobs[0].id} is ${initialJobs[0].status}`);
    let delivered;
    await expect.poll(async () => {
      const jobs = await jobsSinceStart();
      assert.equal(jobs.length, 1, 'Unexpected duplicate image submission');
      delivered = jobs[0];
      return ['succeeded', 'dead_letter', 'failed', 'canceled'].includes(delivered.status);
    }, { timeout: timeoutMinutes * 60000, intervals: [5000] }).toBe(true);
    report.disconnectProbe.terminalStatus = delivered.status;
    assert.equal(delivered.status, 'succeeded', 'Provider did not deliver while browser offline');
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible({ timeout: 30000 });
    const recoveredImage = page.locator(`img[src*="${delivered.id}"]`).first();
    await expect(recoveredImage).toBeVisible({ timeout: 60000 });
    await expect.poll(() => recoveredImage.evaluate(img => img.complete && img.naturalWidth > 0), { timeout: 30000 }).toBe(true);
    report.disconnectProbe.decodedImage = await recoveredImage.evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }));
    assert.equal((await jobsSinceStart()).length, 1, 'Reload must not submit another image job');
    report.disconnectProbe.recoveredAt = new Date().toISOString();
    const screenshot = resolve(dirname(file), `disconnect-${initialJobs[0].id}.png`);
    await page.screenshot({ path: screenshot });
    report.disconnectProbe.screenshot = screenshot;
    console.log('PASS image completed offline and decoded after reload; one image job');
  }
  assert.equal(report.sentRunCommands, 1, 'Expected exactly one UI run command');
  if (attachmentPaths.length) {
    assert(!report.attachmentProbeError, report.attachmentProbeError);
    assert(report.uploadedAttachments, 'Attachment evidence was not recorded from agent.run');
  }
  if (productDefaults) {
    assert(!report.request?.model, 'Product-default test must not send a model override');
    assert.deepEqual(report.request?.imageGenerationPreference?.models, [], 'Auto must not inject a fixture image model');
    report.modelSelection = 'unmodified_product_defaults';
  }
  assert.equal(report.request?.imageGenerationPreference?.mode, imageMode, 'UI did not send the selected image mode');
  assert.equal(report.request?.imageGenerationPreference?.aspectRatio, arg('ratio') ?? 'auto', 'UI did not send the selected image ratio');
  if (imageMode === 'manual') assert.deepEqual(report.request?.imageGenerationPreference?.models, [imageModel], 'UI did not send the manual model');
  console.log(JSON.stringify(clean({ runId: report.runId, status: report.status, assistant: report.assistant.slice(0, 1800),
    tools: report.tools.map(tool => ({ name: tool.toolName, status: tool.output?.status,
      jobId: tool.output?.jobId, error: tool.output?.error, sourceAssetIds: tool.output?.sourceAssetIds })) })));
} catch (error) {
  report.probeError = String(error.message);
  process.exitCode = 1;
  console.error(report.probeError);
} finally {
  clearTimeout(timer);
  if (staleHistoryReleaseTimer) clearTimeout(staleHistoryReleaseTimer);
  await releaseStaleHistory('cleanup');
  report.finishedAt = new Date().toISOString();
  const directory = resolve(dirname(file), 'browser-turns');
  await mkdir(directory, { recursive: true });
  if (report.probeError && page) {
    report.failurePage = { url: clean(page.url()), text: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000) };
    await page.screenshot({ path: resolve(directory, `${startedAt.replace(/[:.]/g, '-')}-failure.png`) }).catch(() => {});
  }
  const output = resolve(directory, `${startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(output, JSON.stringify(clean(report), null, 2));
  console.log(`Evidence: ${output}`);
  await browser.close();
}
