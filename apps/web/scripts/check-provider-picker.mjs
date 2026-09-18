// Production browser smoke test. Provider endpoints are mocked: no configuration
// writes or model charges. The existing isolated QA login stays in memory only.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const account = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
assert(account.data.user?.email);
const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.data.user.email });
assert(!link.error);
const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
assert(login.data.session && !login.error);
const config = {
  id: '10000000-0000-4000-8000-000000000001', adapter: 'openai_compatible',
  displayName: 'QA model picker', baseUrl: 'https://api.apiyi.com/v1', enabled: true,
  hasApiKey: true, lastFour: '0000', models: [], lastTestStatus: 'never', lastTestedAt: null,
  createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
};
const models = Array.from({ length: 700 }, (_, n) => ({ upstreamModelId: `qa-model-${n}`, displayName: `QA model ${n}`, modality: 'text', enabled: false, capabilities: ['text'] }));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(({ session }) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), { session: login.data.session });
  let writes = 0;
  let savedModels;
  await page.route('**/api/workspace/provider-configs**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/discover-models')) body = { models };
    else if (url.pathname.endsWith('/test')) body = { ok: true, testedAt: new Date().toISOString() };
    else if (route.request().method() === 'GET') body = { configs: [config] };
    else { writes++; savedModels = route.request().postDataJSON().models; body = { config }; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://localhost:3020/admin');
  await page.getByRole('button', { name: '第三方模型供应商', exact: true }).click();
  await page.getByRole('button', { name: '新增供应商', exact: true }).click();
  await page.getByLabel('Base URL', { exact: true }).fill('https://toapis.cn/v1');
  await page.getByLabel('API Key', { exact: true }).fill('qa-draft-key-not-a-real-secret');
  await page.getByRole('button', { name: '拉取模型', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(writes, 0);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  console.log('PASS new unsaved provider can discover models and cancel without any config write');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '拉取模型', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(writes, 0);
  console.log('PASS production admin opens model picker with 700 mocked candidates and zero config writes');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(writes, 0);
  console.log('PASS Escape cancels selection without saving configuration');
  await page.getByRole('button', { name: '拉取模型', exact: true }).click();
  await dialog.getByLabel('搜索获取到的模型').fill('qa-model-699');
  await dialog.getByLabel('选择 qa-model-699', { exact: true }).check();
  await dialog.getByLabel('qa-model-699 类型', { exact: true }).selectOption('image');
  await dialog.getByRole('button', { name: '确认添加', exact: true }).click();
  assert.equal(writes, 0);
  assert.equal(await page.getByLabel('模型 1 ID', { exact: true }).inputValue(), 'qa-model-699');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).waitFor();
  assert.equal(writes, 1);
  assert.equal(savedModels.length, 1);
  assert.equal(savedModels[0].upstreamModelId, 'qa-model-699');
  assert.equal(savedModels[0].modality, 'image');
  assert.deepEqual(savedModels[0].capabilities, ['image_generation']);
  console.log('PASS only selected model 699 saved with manually assigned image type (mocked write)');
} finally { await browser.close(); }
