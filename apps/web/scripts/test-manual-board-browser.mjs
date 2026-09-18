import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const stage = process.argv.find(a => a.startsWith('--stage='))?.slice(8) ?? 'outside';
const path = process.env.BOARD_FLOW_AUDIT === '1'
  ? '../../artifacts/paid-dialogue-live/manual-board-flow-audit-20260914.json'
  : '../../artifacts/paid-dialogue-live/manual-board-20260914.json';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
let fixture;
try { fixture = JSON.parse(await readFile(path, 'utf8')); } catch {
  assert.equal(stage, 'outside');
  const source = await db.from('canvases').select('project_id,workspace_id,created_by,content').eq('id', '8975b870-80dd-497a-9adb-86d4582504e4').single();
  assert.ifError(source.error);
  const image = source.data.content.elements.find(e => e.type === 'image' && !e.isDeleted);
  assert(image?.customData?.assetId);
  const content = { elements: [{ ...image, x: 80, y: 100, width: 480, height: 270, angle: 0, version: image.version + 1 }], files: source.data.content.files,
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } };
  const canvas = await db.from('canvases').insert({ project_id: source.data.project_id, workspace_id: source.data.workspace_id, created_by: source.data.created_by,
    name: 'QA 手动加入画板', content }).select('id').single();
  assert.ifError(canvas.error);
  const session = await db.from('chat_sessions').insert({ canvas_id: canvas.data.id, created_by: source.data.created_by, title: 'QA 手动图层', thread_id: `thread_${randomUUID()}` }).select('id').single();
  assert.ifError(session.error);
  fixture = { canvasId: canvas.data.id, sessionId: session.data.id, ownerId: source.data.created_by, imageId: image.id, stages: {} };
  await writeFile(path, JSON.stringify(fixture, null, 2));
}
const readCanvas = async () => { const q = await db.from('canvases').select('content,revision').eq('id', fixture.canvasId).single(); assert.ifError(q.error); return q.data; };
const readDesign = async id => { const q = await db.from('design_documents').select('name,scene,revision,preview_revision').eq('id', id).single(); assert.ifError(q.error); return q.data; };
if (stage === 'board-tools' || stage === 'inside' || stage === 'drag' || ((stage === 'outside' || stage === 'ghost') && fixture.designId)) {
  assert(fixture.designId, 'Outside stage must create the test board first');
  const canvas = await readCanvas();
  const board = canvas.content.elements.find(e => e.customData?.designId === fixture.designId && !e.isDeleted);
  assert(board);
  canvas.content.elements = canvas.content.elements.map(e => e.id === fixture.imageId ? { ...e, isDeleted: false,
    x: stage === 'inside' || stage === 'board-tools' ? board.x + 30 : 80, y: stage === 'inside' || stage === 'board-tools' ? board.y + 30 : 100,
    width: 200, height: 112.5, angle: 0, version: e.version + 1 } : e);
  // A user-placed floating image is above the board, not underneath its rectangle.
  canvas.content.elements.sort((a, b) => Number(a.id === fixture.imageId) - Number(b.id === fixture.imageId));
  canvas.content.elements = canvas.content.elements.map(({ index, ...e }) => e);
  canvas.content.appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  const q = await db.from('canvases').update({ content: canvas.content, revision: canvas.revision + 1 }).eq('id', fixture.canvasId).eq('revision', canvas.revision);
  assert.ifError(q.error);
}
const account = await db.auth.admin.getUserById(fixture.ownerId);
const link = await db.auth.admin.generateLink({ type: 'magiclink', email: account.data.user.email });
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY, opts);
const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
assert(login.data.session);
// Clean up only a previous failed run's own import through the public undo API.
const previous = fixture.stages[stage];
if (previous?.error && previous.receipt) {
  const design = await readDesign(previous.receipt.design_id);
  if (design.scene.objects.some(o => o.objectId === previous.receipt.object_id)) {
    const res = await fetch(`http://localhost:3002/api/designs/${previous.receipt.design_id}/canvas-image-imports/${previous.receipt.operation_id}/undo`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: randomUUID(), expected_design_revision: design.revision, expected_object_version: 1 }) });
    assert(res.ok, 'Failed-run fixture cleanup failed');
  }
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const report = { stage, canvasId: fixture.canvasId, startedAt: new Date().toISOString(), agentCalls: 0, imageGenerationCalls: 0 };
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/jobs/image-generation')) report.imageGenerationCalls++; });
page.on('websocket', ws => ws.on('framesent', ({ payload }) => { if (String(payload).includes('agent.run')) report.agentCalls++; }));
try {
  await page.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), login.data.session);
  await page.goto(`http://localhost:3020/canvas?id=${fixture.canvasId}&session=${fixture.sessionId}`);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeEnabled({ timeout: 30000 });
  await page.waitForTimeout(1500);
  if (stage === 'outpaint-ui' || stage === 'outpaint-submit') {
    if (stage === 'outpaint-submit') await page.route('**/jobs/image-generation', async route => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'QA rejected: no paid generation' }) });
    });
    const before = await readCanvas();
    const source = before.content.elements.find(e => e.id === fixture.imageId && !e.isDeleted);
    await page.mouse.click(source.x + source.width / 2, source.y + source.height / 2);
    await page.getByRole('button', { name: '更多图片工具', exact: true }).click();
    await page.getByRole('button', { name: '扩图', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '扩图', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('outpaint-preview')).toBeVisible();
    await dialog.getByRole('button', { name: '清零' }).click();
    await expect(dialog.getByRole('button', { name: '开始扩图' })).toBeDisabled();
    await dialog.getByLabel('右扩展像素').fill('200');
    await expect(dialog.getByRole('button', { name: '开始扩图' })).toBeEnabled();
    if (stage === 'outpaint-submit') {
      await dialog.getByRole('button', { name: '开始扩图' }).click();
      await page.waitForTimeout(4000);
      assert.deepEqual(pageErrors, []);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('alert')).toBeVisible();
      assert(page.url().includes(`id=${fixture.canvasId}`));
    }
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(report.imageGenerationCalls, stage === 'outpaint-submit' ? 1 : 0);
    report.passed = true; report.outpaintPreview = true;
  } else if (stage === 'tidy') {
    const before = await readCanvas();
    const designBefore = await readDesign(fixture.designId);
    const positions = canvas => canvas.content.elements.filter(e => !e.isDeleted).map(e => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height }));
    await page.mouse.click(500, 650);
    await page.getByRole('button', { name: '整理画布', exact: true }).click();
    await expect.poll(async () => JSON.stringify(positions(await readCanvas())), { timeout: 15000 }).not.toBe(JSON.stringify(positions(before)));
    const after = await readCanvas();
    assert.deepEqual(after.content.elements.map(e => [e.id, e.width, e.height, e.fileId]), before.content.elements.map(e => [e.id, e.width, e.height, e.fileId]));
    assert.deepEqual((await readDesign(fixture.designId)).scene, designBefore.scene);
    await page.mouse.click(500, 650);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => positions(await readCanvas()), { timeout: 15000 }).toEqual(positions(before));
    report.passed = true; report.undoRestored = true; report.boardLayersPreserved = true;
  } else if (stage === 'board-tools') {
    const canvas = await readCanvas();
    const source = canvas.content.elements.find(e => e.id === fixture.imageId);
    canvas.content.elements = canvas.content.elements.map(e => e.id === source.id ? { ...e, x: 80, y: 100, version: e.version + 1 } : e);
    const positioned = await db.from('canvases').update({ content: canvas.content, revision: canvas.revision + 1 }).eq('id', fixture.canvasId).eq('revision', canvas.revision);
    assert.ifError(positioned.error);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeEnabled();
    await page.waitForTimeout(1500);
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    const boardToolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    await expect(boardToolbar).toBeVisible();
    await page.mouse.click(180, 156);
    const toolbar = page.getByTestId('image-board-only-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '更多图片工具' })).toHaveCount(0);
    await toolbar.getByRole('button', { name: '添加到画板' }).click();
    await expect(page.getByRole('dialog', { name: '选择图片目标画板' })).toBeVisible();
    await page.getByRole('dialog', { name: '选择图片目标画板' }).getByRole('button', { name: '取消', exact: true }).click();
    await boardToolbar.getByRole('button', { name: '完成', exact: true }).click();
    await expect(boardToolbar).toHaveCount(0);
    await page.mouse.click(180, 156);
    await expect(page.getByRole('button', { name: '更多图片工具' })).toBeVisible();
    report.passed = true; report.editingOnlyBoard = true; report.exitToolsRestored = true;
  } else if (stage === 'local-repaint') {
    const before = await readCanvas();
    const source = before.content.elements.find(e => e.id === fixture.imageId && !e.isDeleted);
    assert(source);
    await page.mouse.click(source.x + source.width / 2, source.y + source.height / 2);
    if (!(await page.getByRole('button', { name: '局部重绘', exact: true }).count())) {
      await page.getByRole('button', { name: '更多图片工具', exact: true }).click();
    }
    await page.getByRole('button', { name: '局部重绘', exact: true }).click();
    const mask = page.getByLabel('局部重绘涂抹区域');
    await expect(mask).toBeVisible();
    await expect(page.getByRole('button', { name: '开始重绘', exact: true })).toBeDisabled();
    const area = await mask.boundingBox(); assert(area);
    await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.55, { steps: 10 });
    await page.mouse.up();
    await page.getByLabel('修改要求').fill('将选中区域的咖啡杯改为深蓝色陶瓷材质，自然保留光影。');
    const submitted = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/jobs/image-generation'), { timeout: 60000 });
    await page.getByRole('button', { name: '开始重绘', exact: true }).click();
    const response = await submitted;
    const receipt = await response.json();
    assert(response.ok(), JSON.stringify(receipt));
    report.jobId = receipt.job.id;
    await expect(mask).toHaveCount(0, { timeout: 300000 });
    const after = await readCanvas();
    const original = after.content.elements.find(e => e.id === source.id);
    assert.equal(original.fileId, source.fileId);
    assert.equal(original.isDeleted, source.isDeleted);
    assert(after.content.elements.filter(e => e.type === 'image' && !e.isDeleted).length > before.content.elements.filter(e => e.type === 'image' && !e.isDeleted).length);
    report.passed = true; report.originalPreserved = true;
  } else if (stage === 'direct-download') {
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    for (const [label, extension] of [['PNG', '.png'], ['透明 PNG', '.png'], ['JPEG', '.jpg'], ['动态 GIF', '.gif']]) {
      await toolbar.getByRole('button', { name: '下载', exact: true }).click();
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      const download = await downloadEvent;
      assert.equal(await download.failure(), null);
      assert(download.suggestedFilename().endsWith(extension), download.suggestedFilename());
      await expect(page.getByTestId('design-inline-editor')).toBeVisible();
    }
    await expect(page.getByTestId('design-inline-editor')).toBeVisible();
    await toolbar.getByRole('button', { name: '画板详情', exact: true }).click();
    await expect(page.getByTestId('design-inline-editor')).toHaveCount(0);
    report.passed = true; report.directDownload = true; report.separateDetails = true;
  } else if (stage === 'outside-preview') {
    const before = await readDesign(fixture.designId);
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const still = node.getByTestId('design-animation-preview');
    await expect(still).toBeVisible({ timeout: 20000 });
    const baseline = await still.evaluate(c => c.toDataURL());
    await page.waitForTimeout(370);
    assert.equal(baseline, await still.evaluate(c => c.toDataURL()), 'Paused board must render a stable complete scene');
    const playControl = node.getByRole('button', { name: '播放动画预览', exact: true });
    assert.equal(await playControl.innerText(), '');
    assert((await playControl.boundingBox()).width <= 22);
    await node.getByRole('button', { name: '播放动画预览', exact: true }).click();
    const moving = node.getByTestId('design-animation-preview');
    await expect(moving).toBeVisible({ timeout: 20000 });
    const a = await moving.evaluate(c => c.toDataURL());
    await page.waitForTimeout(370);
    assert.notEqual(a, await moving.evaluate(c => c.toDataURL()));
    assert.deepEqual((await readDesign(fixture.designId)).scene, before.scene);
    await node.getByRole('button', { name: '暂停动画预览', exact: true }).click();
    await expect(moving).toBeVisible();
    await expect.poll(() => moving.evaluate(c => c.toDataURL())).toBe(baseline);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    await toolbar.getByRole('button', { name: '图层 / 属性', exact: true }).click();
    await page.getByRole('button', { name: /^选择图层：/ }).first().click();
    const panel = page.getByTestId('design-properties-dock');
    const pause = panel.getByRole('button', { name: '暂停', exact: true });
    if (await pause.count()) await pause.click();
    await panel.getByRole('button', { name: '播放', exact: true }).click();
    await expect(page.getByTestId('design-inline-editor').getByTestId('design-animation-preview')).toBeVisible();
    await panel.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByTestId('design-inline-editor').getByTestId('design-animation-preview')).toBeHidden();
    await toolbar.getByRole('button', { name: '完成', exact: true }).click();
    await expect(node.getByRole('button', { name: '播放动画预览', exact: true })).toBeVisible();
    report.passed = true; report.outsideAnimated = true; report.propertyControls = true; report.sceneUnchanged = true;
  } else if (stage === 'missing-recovery') {
    const scene = (await readDesign(fixture.designId)).scene;
    const asset = scene.objects.find(o => o.type === 'image').assetObjectId;
    const pattern = `**/api/uploads/${asset}/content*`;
    let failures = 0;
    await page.route(pattern, route => { failures++; return route.fulfill({ status: 503, body: 'QA transient asset failure' }); });
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    await expect.poll(() => failures).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await page.unroute(pattern);
    const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    for (const format of ['PNG', '动态 GIF']) {
      await toolbar.getByRole('button', { name: '下载', exact: true }).click();
      const exported = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: format, exact: true }).click();
      assert.equal(await (await exported).failure(), null);
    }
    report.passed = true; report.injectedAssetFailures = failures; report.exportsRecoveredInSameSession = true;
  } else if (stage === 'hidden-animation') {
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    await toolbar.getByRole('button', { name: '图层 / 属性', exact: true }).click();
    const hide = page.getByRole('button', { name: '隐藏图层', exact: true });
    while (await hide.count()) {
      const count = await hide.count();
      await hide.first().click();
      await expect(hide).toHaveCount(count - 1);
    }
    await toolbar.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await readDesign(fixture.designId)).scene.objects.every(o => !o.visible)).toBe(true);
    await expect(page.getByTestId('design-inline-editor').getByTestId('design-animation-preview')).toHaveCount(0);
    await toolbar.getByRole('button', { name: '下载', exact: true }).click();
    await page.getByRole('menuitem', { name: '动态 GIF', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '可见对象' })).toBeVisible();
    const show = page.getByRole('button', { name: '显示图层', exact: true });
    while (await show.count()) {
      const count = await show.count();
      await show.first().click();
      await expect(show).toHaveCount(count - 1);
    }
    await toolbar.getByRole('button', { name: '下载', exact: true }).click();
    const exported = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '动态 GIF', exact: true }).click();
    assert.equal(await (await exported).failure(), null);
    await toolbar.getByRole('button', { name: '保存', exact: true }).click();
    report.passed = true; report.hiddenRejected = true; report.visibleRecoveryExported = true;
  } else if (stage === 'overflow') {
    const before = await readDesign(fixture.designId);
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    await expect(page.getByTestId('design-overflow-shade')).toBeVisible();
    const board = await page.getByTestId('design-overflow-shade').boundingBox();
    const canvas = await page.getByTestId('design-inline-editor').locator('canvas.lower-canvas').boundingBox();
    assert(board && canvas && canvas.width > board.width && canvas.height > board.height);
    assert.deepEqual((await readDesign(fixture.designId)).scene, before.scene);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({path:'../../artifacts/paid-dialogue-live/board-overflow.png'});
    report.passed=true; report.expandedEditor=true; report.sceneUnchanged=true;
  } else if (stage === 'preview') {
    const before = await readDesign(fixture.designId);
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    const preview = page.getByTestId('design-animation-preview');
    await expect(preview).toBeVisible({ timeout: 20000 });
    const first = await preview.evaluate(c => c.toDataURL());
    await page.waitForTimeout(370);
    const second = await preview.evaluate(c => c.toDataURL());
    assert.notEqual(first, second, 'Preview pixels must animate');
    assert.deepEqual((await readDesign(fixture.designId)).scene, before.scene, 'Preview must not write animation frames to document');
    await page.getByRole('button', { name: '暂停动画预览', exact: true }).click();
    await expect(preview).toBeHidden();
    await page.getByRole('button', { name: '播放动画预览', exact: true }).click();
    await expect(preview).toBeVisible();
    // Clicking the editing surface restores the static, editable canvas.
    await page.mouse.click(rect.x + 20, rect.y + 20);
    await expect(preview).toBeHidden();
    const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    await toolbar.getByRole('button', { name: '图层 / 属性', exact: true }).click();
    await page.getByRole('button', { name: /^选择图层：/ }).first().click();
    const animationSelect = page.getByRole('combobox', { name: '动画', exact: true });
    await animationSelect.selectOption((await animationSelect.inputValue()) === 'float' ? 'scale' : 'float');
    await expect(preview).toBeVisible();
    await page.screenshot({ path: '../../artifacts/paid-dialogue-live/board-animation-preview.png' });
    report.passed = true; report.pixelsChanged = true; report.previewDidNotMutateScene = true; report.pauseResumeAndParameterChange = true;
  } else if (stage === 'animation') {
    report.exports = [];
    const original = (await readDesign(fixture.designId)).scene.objects[0];
    assert(original, 'Animation QA requires its previous test image layer');
    for (const type of ['float', 'scale', 'mixed']) {
      await page.reload();
      const node = page.locator(`[data-design-id="${fixture.designId}"]`);
      await expect(node).toBeVisible({ timeout: 20000 });
      const rect = await node.boundingBox(); assert(rect);
      await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
      await page.getByRole('button', { name: '打开设计', exact: true }).click();
      const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
      await toolbar.getByRole('button', { name: '图层 / 属性', exact: true }).click();
      await page.getByRole('button', { name: /^选择图层：/ }).first().click();
      if (type === 'mixed') await toolbar.getByRole('button', { name: '添加文字', exact: true }).click();
      await page.getByRole('combobox', { name: '动画', exact: true }).selectOption(type === 'mixed' ? 'float' : type);
      await toolbar.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(async () => {
        const objects = (await readDesign(fixture.designId)).scene.objects;
        return (type === 'mixed' ? objects.findLast(o => o.type === 'text' || o.type === 'textbox') : objects[0])?.animation?.type;
      }, { timeout: 15000 }).toBe(type === 'mixed' ? 'float' : type);
      const saved = (await readDesign(fixture.designId)).scene.objects[0];
      for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity']) assert.equal(saved[key], original[key]);
      await toolbar.getByRole('button', { name: '画板详情', exact: true }).click();
      await page.getByRole('button', { name: '导出', exact: true }).click();
      await page.getByRole('combobox', { name: '导出格式', exact: true }).selectOption('gif');
      const download = page.waitForEvent('download', { timeout: 120000 });
      await page.getByRole('button', { name: '下载', exact: true }).click();
      const file = await download;
      const filePath = `../../artifacts/paid-dialogue-live/board-animation-${type}.gif`;
      await file.saveAs(filePath);
      const bytes = await readFile(filePath);
      assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a');
      report.exports.push({ type, filename: file.suggestedFilename(), bytes: bytes.length });
    }
    await page.reload();
    const restored = (await readDesign(fixture.designId)).scene.objects[0];
    assert.equal(restored.animation.type, 'scale');
    report.passed = true; report.reloaded = true; report.staticPoseUnchanged = true;
  } else if (stage === 'rename') {
    const before = await readDesign(fixture.designId);
    const node = page.locator(`[data-design-id="${fixture.designId}"]`);
    const firstName = `画布改名 ${Date.now()}`;
    await node.getByRole('button', { name: '重命名画板' }).click();
    await page.getByRole('textbox', { name: '画板名称', exact: true }).fill(firstName);
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '修改画板名称' })).toHaveCount(0);
    await expect(node).toContainText(firstName);
    const rect = await node.boundingBox(); assert(rect);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await page.getByRole('button', { name: '打开设计', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: '画板工具栏' });
    await expect(toolbar).toContainText(firstName);
    await toolbar.getByRole('button', { name: '重命名画板' }).click();
    const secondName = `工具栏改名 ${Date.now()}`;
    await page.getByRole('textbox', { name: '画板名称', exact: true }).fill(secondName);
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '修改画板名称' })).toHaveCount(0);
    await expect(toolbar).toContainText(secondName);
    await toolbar.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByTestId('design-inline-editor')).toHaveCount(0, { timeout: 20000 });
    await page.reload();
    await expect(node).toContainText(secondName, { timeout: 20000 });
    const current = await readDesign(fixture.designId);
    assert.deepEqual(current.scene, before.scene, 'Rename must not mutate layers');
    const canvas = await readCanvas();
    const source = canvas.content.elements.find(e => e.id === fixture.imageId);
    await page.mouse.click(source.x + source.width / 2, source.y + source.height / 2);
    await page.getByRole('button', { name: '添加到画板', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: '选择图片目标画板' })).toContainText(secondName);
    await page.screenshot({ path: '../../artifacts/paid-dialogue-live/manual-board-rename.png' });
    report.passed = true; report.bothRenameEntrances = true; report.sceneUnchanged = true;
  } else {
  const canvas = await readCanvas();
  const source = canvas.content.elements.find(e => e.id === fixture.imageId);
  await page.mouse.click(source.x + source.width / 2, source.y + source.height / 2);
  const importResponse = page.waitForResponse(r => r.request().method() === 'POST' && /\/canvas-image-imports$/.test(new URL(r.url()).pathname), { timeout: 60000 });
  importResponse.catch(() => {});
  if (stage === 'drag') {
    const board = canvas.content.elements.find(e => e.customData?.designId === fixture.designId && !e.isDeleted);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2, { steps: 18 });
    await page.waitForTimeout(200);
    await page.mouse.up();
  } else {
    await page.getByRole('button', { name: stage === 'inside' ? '加入此画板' : '添加到画板', exact: true }).first().click();
    const picker = page.getByRole('dialog', { name: '选择图片目标画板' });
    await expect(picker).toBeVisible();
    if (fixture.designId) {
      const currentName = (await readDesign(fixture.designId)).name?.trim();
      const label = `${currentName && currentName !== '未命名设计' ? currentName : '画板'} · ${fixture.designId.slice(0, 8)}`;
      await expect(picker.getByText(label, { exact: true })).toBeVisible();
      await expect(page.locator(`[data-design-id="${fixture.designId}"]`).getByText(label, { exact: true })).toBeVisible();
    }
    await picker.getByRole('button', { name: stage === 'outside' && !fixture.designId ? '新建画板' : stage === 'inside' ? '加入此画板' : '添加到画板', exact: true }).first().click();
  }
  const response = await importResponse;
  report.httpStatus = response.status();
  report.receipt = await response.json();
  assert(response.ok(), JSON.stringify(report.receipt));
  fixture.designId = report.receipt.design_id;
  await expect.poll(async () => (await readDesign(fixture.designId)).scene.objects.filter(o => o.type === 'image').length, { timeout: 30000 }).toBe(1);
  await expect.poll(async () => (await readCanvas()).content.elements.find(e => e.id === fixture.imageId)?.isDeleted === true, { timeout: 30000 }).toBe(stage === 'inside');
  const after = await readCanvas();
  const sourceAfter = after.content.elements.find(e => e.id === fixture.imageId);
  if (stage !== 'inside') { assert.equal(sourceAfter.x, source.x); assert.equal(sourceAfter.y, source.y); }
  await expect.poll(async () => { const d = await readDesign(fixture.designId); return d.preview_revision >= d.revision; }, { timeout: 90000 }).toBe(true);
  await expect(page.locator(`[data-design-id="${fixture.designId}"] img`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('预览待更新', { exact: true })).toHaveCount(0, { timeout: 15000 });
  await page.screenshot({ path: `../../artifacts/paid-dialogue-live/manual-board-${stage}.png` });
  await page.getByRole('button', { name: '编辑画板图层', exact: true }).click();
  await expect(page.getByTestId('design-inline-editor')).toBeVisible({ timeout: 15000 });
  const previewNode = page.locator(`[data-design-id="${fixture.designId}"]`);
  await expect(previewNode).toHaveCSS('visibility', 'hidden');
  await page.getByRole('button', { name: '图层 / 属性', exact: true }).click();
  await expect(page.getByRole('button', { name: /^选择图层：/ })).toHaveCount(1);
  await page.getByRole('button', { name: /^选择图层：/ }).click();
  await expect(page.getByRole('button', { name: '删除所选对象', exact: true })).toBeEnabled();
  await page.screenshot({ path: `../../artifacts/paid-dialogue-live/manual-board-${stage}-editor.png` });
  report.editorLayerSelected = true;
  if (stage === 'ghost') {
    const before = await readDesign(fixture.designId);
    const layer = before.scene.objects.find(o => o.objectId === report.receipt.object_id);
    const rect = await previewNode.boundingBox();
    assert(rect);
    const doc = await db.from('design_documents').select('width,height').eq('id', fixture.designId).single();
    assert.ifError(doc.error);
    const cx = rect.x + (layer.x + layer.width / 2) / doc.data.width * rect.width;
    const cy = rect.y + (layer.y + layer.height / 2) / doc.data.height * rect.height;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 45, cy + 35, { steps: 15 });
    await expect(previewNode).toHaveCSS('visibility', 'hidden');
    await page.screenshot({ path: '../../artifacts/paid-dialogue-live/manual-board-ghost-moving.png' });
    await page.mouse.up();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => {
      const current = (await readDesign(fixture.designId)).scene.objects.find(o => o.objectId === layer.objectId);
      return current.x !== layer.x || current.y !== layer.y;
    }).toBe(true);
    report.layerMovedAndSaved = true;
  }
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByTestId('design-inline-editor')).toHaveCount(0);
  await expect(previewNode).toHaveCSS('visibility', 'visible');
  if (stage !== 'ghost') {
  await page.getByRole('button', { name: '撤销加入', exact: true }).click();
  await expect.poll(async () => (await readDesign(fixture.designId)).scene.objects.filter(o => o.type === 'image').length, { timeout: 30000 }).toBe(0);
  await expect.poll(async () => (await readCanvas()).content.elements.find(e => e.id === fixture.imageId)?.isDeleted === true, { timeout: 30000 }).toBe(false);
  } else {
    await page.reload();
    await expect(page.locator(`[data-design-id="${fixture.designId}"] img`)).toBeVisible({ timeout: 20000 });
    report.reloaded = true;
  }
  report.passed = true;
  assert.equal(report.agentCalls, 0); assert.equal(report.imageGenerationCalls, 0);
  }
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  await page.screenshot({ path: `../../artifacts/paid-dialogue-live/manual-board-${stage}-failure.png` }).catch(() => {});
} finally {
  fixture.stages[stage] = report;
  await writeFile(path, JSON.stringify(fixture, null, 2)); console.log(JSON.stringify(report)); await browser.close();
}
