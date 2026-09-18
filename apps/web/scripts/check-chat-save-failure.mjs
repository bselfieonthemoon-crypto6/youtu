// Browser regression against the production bundle. All data writes and run
// commands are intercepted; this probe cannot submit a paid generation job.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const sessionId = '940093d9-5dda-4479-8366-d6ce698090a9';
const { data: session, error } = await admin.from('chat_sessions').select('created_by,canvas_id').eq('id', sessionId).single();
assert(!error);
const { data: account } = await admin.auth.admin.getUserById(session.created_by);
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.user.email });
const { data: login } = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
assert(login.session);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let failedMessageWrites = 0, blockedHttpRuns = 0;
  await page.addInitScript(value => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
    window.__qaBlockedRunCommands = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (message) {
      if (typeof message === 'string') {
        try {
          const command = JSON.parse(message);
          if (['agent.run', 'agent.confirm_action'].includes(command.action)) {
            window.__qaBlockedRunCommands++;
            return;
          }
        } catch { /* Transport pings may not be JSON. */ }
      }
      return send.call(this, message);
    };
  }, login.session);
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/api/'))) {
      if (url.pathname === '/rest/v1/chat_messages' ||
          url.pathname === `/api/sessions/${sessionId}/messages`) failedMessageWrites++;
      if (url.pathname.includes('/runs')) blockedHttpRuns++;
      return route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ message: 'Isolated QA: message save unavailable' }) });
    }
    return route.continue();
  });
  await page.goto(`http://localhost:3020/canvas?id=${session.canvas_id}&session=${sessionId}`);
  const composer = page.getByRole('textbox', { name: '输入消息', exact: true });
  await expect(composer).toBeEnabled({ timeout: 30000 });
  const draft = '仅用于隔离测试：保存失败后请保留这一段输入';
  await composer.fill(draft);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => failedMessageWrites, { timeout: 10000 }).toBe(1);
  await expect(composer).toHaveValue(draft);
  await expect(composer).toBeEnabled();
  assert.equal(await page.evaluate(() => window.__qaBlockedRunCommands), 0);
  assert.equal(blockedHttpRuns, 0);
  await page.screenshot({ path: '../../artifacts/chat-save-failure.png' });
  console.log(JSON.stringify({ productionBundle: true, messageSaveFailure: true,
    draftRestored: true, noRunStarted: true, providerCalls: 0, userDataWrites: 0 }));
} finally { await browser.close(); }
