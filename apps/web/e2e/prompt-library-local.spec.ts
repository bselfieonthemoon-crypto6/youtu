import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';

// This test uses real local API/catalog/canvas persistence, never a real model.
// No traces/video: those can retain authentication headers or websocket frames.
test.use({ trace: 'off', video: 'off', viewport: { width: 1440, height: 1000 } });
const supabase = 'http://127.0.0.1:54421';
const api = process.env.LOOMIC_E2E_SERVER_URL ?? 'http://127.0.0.1:3002';

test('uses the reviewed prompt library in a real node and restores independent drafts after reload', async ({ page, request }, info) => {
  test.skip(process.env.LOOMIC_PROMPT_LIBRARY_QA !== 'true' || process.env.SUPABASE_URL !== supabase, 'Explicit local-only opt in required');
  test.setTimeout(240000);
  expect(new URL(api).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  expect(new URL(process.env.LOOMIC_E2E_BASE_URL ?? 'http://localhost:3020').hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(supabase, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
  const client = createClient(supabase, process.env.SUPABASE_ANON_KEY!, options);
  const account = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
  if (!account.data.user?.email) throw new Error('Local QA account unavailable');
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.data.user.email });
  if (link.error) throw new Error('Local QA login setup failed');
  const login = await client.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
  if (login.error || !login.data.session) throw new Error('Local QA login failed');
  const headers = { Authorization: `Bearer ${login.data.session.access_token}` };
  let projectId: string | undefined;
  let canvasId: string | undefined;
  const generatedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const imageRequests: { url: string; authorization: boolean; referer: boolean }[] = [];
  const imageNetworkErrors: string[] = [];
  const imageSourcesVerified: string[] = [];
  const remoteImageUrls = new Set<string>();
  let initiallyMountedImages = 0;
  let watchLibrary = false;
  const sanitize = (value: string) => value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]').slice(0, 1000);
  page.on('console', event => {
    if (event.type() !== 'error') return;
    // Third-party image availability is separate from application/React errors.
    const output = sanitize(event.text());
    if (remoteImageUrls.has(event.location().url) && /Failed to load resource/.test(output)) imageNetworkErrors.push(output);
    else consoleErrors.push(output);
  });
  page.on('pageerror', error => consoleErrors.push(sanitize(error.message)));
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { if (JSON.parse(String(payload)).action === 'agent.run') generatedRequests.push('websocket:agent.run'); } catch { /* Ignore auth and other transport frames. */ }
  }));
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url());
    if (req.method() === 'POST' && /\/api\/(?:agent\/generate|jobs\/(?:image|video)-generation|runs)/.test(url.pathname)) {
      generatedRequests.push(url.pathname); await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  page.on('request', req => {
    if (watchLibrary && req.resourceType() === 'image' && new URL(req.url()).protocol === 'https:') {
      remoteImageUrls.add(req.url());
      const requestHeaders = req.headers();
      imageRequests.push({ url: req.url(), authorization: Boolean(requestHeaders.authorization), referer: Boolean(requestHeaders.referer) });
    }
  });
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
    key: `sb-${new URL(supabase).hostname.split('.')[0]}-auth-token`, session: login.data.session,
  });
  try {
    const health = await request.get(`${api}/api/health`); expect(health.ok()).toBe(true);
    const libraryStart = performance.now();
    const catalogResponse = await request.get(`${api}/api/prompt-library?limit=24`, { headers });
    expect(catalogResponse.status(), 'Real local prompt endpoint').toBe(200);
    const library = await catalogResponse.json();
    const apiFirstReadMs = Math.round(performance.now() - libraryStart);
    expect(library.total).toBe(654); expect(library.sources).toHaveLength(7);
    expect(library.items).toHaveLength(24); expect(library.items.every((item: any) => item.imageUrl?.startsWith('https://'))).toBe(true);
    expect(library.sources.filter((source: any) => source.status === 'available')).toHaveLength(4);
    const picked = library.items[0];
    const created = await request.post(`${api}/api/projects`, { headers, data: {
      name: `QA prompt library ${crypto.randomUUID().slice(0, 8)}`, description: 'Isolated prompt-library acceptance; no image generation',
    } });
    expect(created.ok()).toBe(true); const project = (await created.json()).project;
    projectId = project.id; canvasId = project.primaryCanvas.id;
    const readNodes = async () => {
      const response = await request.get(`${api}/api/canvases/${canvasId}`, { headers });
      expect(response.ok()).toBe(true);
      const { canvas } = await response.json();
      return (canvas.content.elements ?? []).filter((element: any) => !element.isDeleted && element.customData?.type === 'image-generator');
    };
    await page.goto(`/canvas?id=${canvasId}`);
    await page.getByRole('button', { name: 'AI 生成图片', exact: true }).click({ timeout: 60000 });
    const input = page.getByRole('textbox', { name: '图片生成提示词' });
    await expect(input).toBeVisible();
    await input.fill('保留我的构思');
    await expect.poll(async () => (await readNodes())[0]?.customData.prompt).toBe('保留我的构思');
    const initial = (await readNodes())[0];
    watchLibrary = true;
    await page.getByRole('button', { name: '打开提示词库' }).click();
    const dialog = page.getByRole('dialog', { name: '提示词库' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^查看提示词：/ })).toHaveCount(24);
    const list = dialog.getByRole('region', { name: '提示词列表' });
    const expectLoaded = async (alt: string, container = dialog) => {
      const img = container.getByRole('img', { name: alt, exact: true }).first();
      await expect(img).toBeVisible({ timeout: 24000 });
      await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0), { timeout: 24000 }).toBe(true);
      await expect(img).toHaveCSS('object-fit', 'contain');
      await expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    };
    await expectLoaded(picked.title, list);
    initiallyMountedImages = await list.locator('img').count();
    expect(initiallyMountedImages).toBeGreaterThan(0);
    expect(initiallyMountedImages, 'Offscreen cards must not receive image src').toBeLessThan(24);
    imageSourcesVerified.push(picked.sourceId);
    await page.screenshot({ path: info.outputPath('prompt-library-browser.png') });
    await dialog.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /^查看提示词：/ })).toHaveCount(48);
    await dialog.getByLabel('搜索提示词').fill('完全不存在的关键词_QA_987654321');
    await expect(dialog.getByText('没有找到匹配的提示词')).toBeVisible();
    await dialog.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /^查看提示词：/ })).toHaveCount(24);
    await dialog.getByLabel('提示词来源').selectOption('davidwu-gpt-image2-prompts');
    await expect(dialog.getByText('此来源仅提供外部链接')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^查看提示词：/ })).toHaveCount(0);
    await dialog.getByLabel('提示词来源').selectOption('');
    await expect(dialog.getByRole('button', { name: /^查看提示词：/ })).toHaveCount(24);
    // Real remote cover from each imported source; do not run any model.
    for (const source of library.sources.filter((item: any) => item.status === 'available' && item.id !== picked.sourceId)) {
      const response = await request.get(`${api}/api/prompt-library?source=${source.id}&limit=1`, { headers });
      expect(response.ok()).toBe(true);
      const sample = (await response.json()).items[0];
      await dialog.getByLabel('提示词来源').selectOption(source.id);
      await expect(dialog.getByRole('button', { name: `查看提示词：${sample.title}`, exact: true }).first()).toBeVisible();
      await expectLoaded(sample.title, list);
      imageSourcesVerified.push(source.id);
    }
    await dialog.getByLabel('提示词来源').selectOption('');
    await expect(dialog.getByRole('button', { name: /^查看提示词：/ })).toHaveCount(24);
    await dialog.getByRole('button', { name: `查看提示词：${picked.title}`, exact: true }).first().click();
    expect(picked.previewImageUrls).toHaveLength(2);
    await expectLoaded(`${picked.title} · 示例 1`);
    // Inject exactly one transport failure; retry then loads the real source.
    await page.route(picked.previewImageUrls[1], route => route.abort('failed'), { times: 1 });
    await dialog.getByRole('button', { name: '查看示例图 2', exact: true }).click();
    const gallery = dialog.getByRole('region', { name: '提示词示例图库' });
    await expect(gallery.getByText('原站图片暂时无法加载', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '追加到末尾', exact: true })).toBeEnabled();
    await gallery.getByRole('button', { name: '重试图片', exact: true }).click();
    await expectLoaded(`${picked.title} · 示例 2`);
    await dialog.getByRole('button', { name: '放大查看示例图', exact: true }).click();
    const zoom = page.getByRole('dialog', { name: `${picked.title} · 示例 2`, exact: true });
    await expect(zoom).toBeVisible();
    await expectLoaded(`${picked.title} · 放大示例 2`, zoom);
    await page.screenshot({ path: info.outputPath('prompt-library-image-zoom.png') });
    await page.keyboard.press('Escape');
    await expect(zoom).toBeHidden();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '查看示例图 1', exact: true }).click();
    await expectLoaded(`${picked.title} · 示例 1`);
    await expect(dialog.locator('pre')).toHaveText(picked.prompt);
    await expect(dialog.getByText('作者：' + picked.author, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('prompt-library-detail.png') });
    await dialog.getByRole('button', { name: '追加到末尾', exact: true }).click();
    const appended = `保留我的构思\n\n${picked.prompt}`;
    await expect(dialog).toBeHidden(); await expect(input).toHaveValue(appended);
    await expect.poll(async () => (await readNodes())[0]?.customData.prompt).toBe(appended);
    await page.getByRole('button', { name: '打开提示词库' }).click();
    await dialog.getByRole('button', { name: `查看提示词：${picked.title}`, exact: true }).first().click();
    await dialog.getByRole('button', { name: '替换当前提示词', exact: true }).click();
    await expect(input).toHaveValue(picked.prompt);
    const finalPrompt = picked.prompt + '\n这是我的自定义修改。';
    await input.fill(finalPrompt);
    await expect.poll(async () => (await readNodes())[0]?.customData.prompt).toBe(finalPrompt);
    const firstNode = (await readNodes())[0];
    for (const property of ['model', 'quality', 'aspectRatio', 'inputImages']) expect(firstNode.customData[property]).toEqual(initial.customData[property]);
    expect(firstNode.id).toBe(initial.id);

    // Create a second real node and switch with the existing layers panel.
    await page.getByRole('button', { name: 'AI 生成图片', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('第二个节点自己的提示词');
    await expect.poll(async () => (await readNodes()).length).toBe(2);
    await expect.poll(async () => (await readNodes())[1]?.customData.prompt).toBe('第二个节点自己的提示词');
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: '选择图层：Image Generator', exact: true }).nth(1).click();
    await expect(input).toHaveValue(finalPrompt);
    await page.reload();
    await expect(page.getByRole('button', { name: 'AI 生成图片', exact: true })).toBeVisible({ timeout: 60000 });
    if (!(await page.getByRole('button', { name: '选择图层：Image Generator', exact: true }).count())) await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: '选择图层：Image Generator', exact: true }).nth(1).click();
    await expect(input).toHaveValue(finalPrompt);
    await page.getByRole('button', { name: '选择图层：Image Generator', exact: true }).first().click();
    await expect(input).toHaveValue('第二个节点自己的提示词');
    const nodes = await readNodes();
    expect(nodes).toHaveLength(2); expect(nodes[0].customData.prompt).toBe(finalPrompt);
    expect(generatedRequests).toEqual([]);
    expect(imageRequests.length).toBeGreaterThan(0);
    expect(imageRequests.every(image => !image.authorization && !image.referer), 'Remote images must not receive platform auth or private canvas URL').toBe(true);
    expect(imageSourcesVerified).toHaveLength(4);
    await page.screenshot({ path: info.outputPath('independent-node-drafts-reloaded.png') });
    await writeFile(info.outputPath('prompt-library-evidence.json'), JSON.stringify({
      projectId, canvasId, version: library.version, entries: library.total, sources: library.sources.map((source: any) => ({ id: source.id, status: source.status, count: source.entryCount })),
      apiFirstReadMs, tested: ['real remote covers from 4 sources', 'viewport-only src mounting', 'gallery image switch', 'injected single image failure followed by real retry', 'full image zoom', 'Escape isolation', 'no remote auth/referrer', 'paging', 'empty search', 'link-only source', 'original text', 'append', 'replace', 'manual edits', 'node switching', 'reload persistence', 'model/size/reference unchanged'],
      generatedRequests, initiallyMountedImages, imageSourcesVerified, imageRequests, imageNetworkErrors, consoleErrors, actualModelCalls: 0,
      nodeIds: nodes.map((node: any) => node.id),
    }, null, 2));
    expect(consoleErrors, 'Node and prompt-library flow must not emit browser errors').toEqual([]);
  } finally {
    await page.goto('about:blank');
    if (projectId) {
      const removed = await request.delete(`${api}/api/projects/${projectId}`, { headers });
      expect(removed.ok(), 'Archive only the isolated QA project').toBe(true);
    }
    const signedOut = await client.auth.signOut({ scope: 'local' }); expect(signedOut.error).toBeNull();
  }
});
