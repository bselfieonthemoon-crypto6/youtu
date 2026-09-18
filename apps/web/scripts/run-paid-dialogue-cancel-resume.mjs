// Real UI cancellation probe. Own script: does not modify shared browser driver.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const arg = n => process.argv.find(v => v.startsWith(`--${n}=`))?.slice(n.length + 3);
assert(process.argv.includes('--submit'), 'Explicit --submit required');
const file = resolve(arg('fixture')); const manifest = JSON.parse(await readFile(file, 'utf8'));
const f = manifest.fixture; assert(f?.canvasId && f?.sessionId);
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY, opts);
const { data: row, error } = await admin.from('chat_sessions').select('created_by,canvas_id').eq('id', f.sessionId).single(); assert(!error); assert.equal(row.canvas_id, f.canvasId);
const { data: account } = await admin.auth.admin.getUserById(row.created_by);
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.user.email });
const { data: login } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token }); assert(login.session);
const prompt = arg('prompt'); assert(prompt);
const startedAt = new Date().toISOString();
const report = { startedAt, transport: 'production_browser_ui', canvasId: f.canvasId, sessionId: f.sessionId, prompt, stopButton: null, job: null, lateOutcome: null, resume: null };
const clean = v => JSON.parse(JSON.stringify(v, (k, x) => /token|secret|password|authorization|signed.?url/i.test(k) ? '[redacted]' : typeof x === 'string' ? x.replace(/https?:\/\/[^\s"<>]+/g, '[url]').replace(/data:image\/[^\s]+/g, '[image]') : x));
const jobs = async () => { const q = await admin.from('background_jobs').select('id,status,result,created_at,started_at,completed_at,error_code').eq('session_id', f.sessionId).gte('created_at', startedAt).eq('job_type', 'image_generation'); assert.ifError(q.error); return q.data; };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
console.log('browser launched');
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(({ session, image, model }) => { localStorage.setItem('sb-127-auth-token', JSON.stringify(session)); localStorage.setItem('loomic:image-model-preference', JSON.stringify({ mode: 'manual', models: [image], aspectRatio: 'auto' })); localStorage.setItem('loomic:agent-model', model); }, { session: login.session, image: manifest.models.image.id, model: manifest.models.text.id });
  await page.goto(`http://localhost:3020/canvas?id=${f.canvasId}&session=${f.sessionId}`);
  console.log('page loaded');
  const composer = page.getByRole('textbox', { name: '输入消息', exact: true }); console.log('waiting composer'); await expect(composer).toBeEnabled({ timeout: 30000 }); console.log('composer ready');
  await page.getByText('连接已断开，正在重连...', { exact: true }).waitFor({ state: 'hidden', timeout: 30000 }).catch(() => undefined);
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 30000 }); console.log('sending confirmation'); await composer.fill(prompt); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(async () => (await jobs()).length, { timeout: 120000, intervals: [500, 1000, 2000] }).toBe(1);
  const before = (await jobs())[0]; assert(['queued','pending','processing','retrying','running'].includes(before.status), `job not cancelable: ${before.status}`); report.job = { id: before.id, beforeStatus: before.status };
  const stop = page.getByRole('button', { name: '停止生成', exact: true }); report.stopButton = { visible: await stop.isVisible(), title: await stop.getAttribute('title') }; assert(report.stopButton.visible, 'UI has no usable 停止生成 button'); await stop.click(); report.stopButton.clickedAt = new Date().toISOString();
  await expect.poll(async () => (await jobs())[0]?.status, { timeout: 120000, intervals: [500, 1000, 2000] }).toBe('canceled');
  const canceled = (await jobs())[0]; report.job.canceledStatus = canceled.status; report.job.canceledAt = canceled.completed_at ?? new Date().toISOString();
  // Continue naturally in the same UI session; this must not create a new image job.
  await expect(composer).toBeVisible({ timeout: 30000 }); await composer.fill('刚才取消了，请继续对话：请说明这张海报的品牌语气，不要生成图片。'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(async () => (await admin.from('chat_messages').select('id').eq('session_id', f.sessionId).eq('role','assistant').gte('created_at', startedAt)).data?.length ?? 0, { timeout: 120000, intervals: [1000, 2000] }).toBeGreaterThanOrEqual(1);
  report.resume = { completedAt: new Date().toISOString(), imageJobsAfter: (await jobs()).length };
  assert.equal(report.resume.imageJobsAfter, 1, 'resume unexpectedly created a new image job');
  await page.waitForTimeout(5000); report.lateOutcome = (await jobs())[0]?.status;
  console.log(JSON.stringify(clean(report)));
} catch (e) { report.error = String(e?.message ?? e); process.exitCode = 1; console.error(report.error); }
finally { const out = resolve(dirname(file), 'browser-turns', `cancel-${report.startedAt.replace(/[:.]/g, '-')}.json`); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(clean(report), null, 2)); console.log(`Evidence: ${out}`); await browser.close(); }
