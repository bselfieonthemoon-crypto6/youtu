// Production UI smoke: isolated existing QA canvas, mocked message reads,
// blocked HTTP writes, no send clicks or generation requests.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { mkdir } from 'node:fs/promises';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
const account = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
assert(account.data.user?.email);
const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.data.user.email });
assert(!link.error);
const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
assert(login.data.session && !login.error);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), login.data.session);
  const original = '生成一个画板，658*176';
  const targetMessageIndex = 12;
  const messages = Array.from({ length: 24 }, (_, index) => {
    const content = index === targetMessageIndex
      ? original
      : `历史消息 ${index + 1}：这是用于验证长聊天记录滚动隔离的占位内容。`.repeat(4);
    return {
      id: `qa-user-message-${index}`,
      role: 'user',
      content,
      contentBlocks: [{ type: 'text', text: content }],
    };
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() !== 'GET' && request.method() !== 'OPTIONS') return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"qa_writes_disabled"}' });
    if (new URL(request.url()).pathname.endsWith('/messages')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages }) });
    return route.continue();
  });
  // Block paid work even if a UI regression accidentally tries to start it.
  let submits = 0;
  await page.routeWebSocket(/\/api\/ws/, ws => {
    ws.onMessage(message => {
      const command = JSON.parse(typeof message === 'string' ? message : message.toString());
      if (command.type !== 'command') return;
      if (command.action === 'agent.run') {
        submits++;
        const runId = 'qa-edit-run';
        ws.send(JSON.stringify({ type: 'command.ack', action: 'agent.run', requestId: command.requestId, payload: { runId } }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'event', event: { type: 'message.delta', runId, messageId: 'qa-edit-assistant', delta: '正在模拟流式回复。', timestamp: new Date().toISOString() } })), 300);
        setTimeout(() => ws.send(JSON.stringify({ type: 'event', event: { type: 'run.completed', runId, timestamp: new Date().toISOString() } })), 850);
      } else if (command.action === 'canvas.resume') {
        ws.send(JSON.stringify({ type: 'command.ack', action: 'canvas.resume', payload: { status: 'accepted' } }));
      }
    });
  });
  await page.goto('http://localhost:3020/canvas?id=40220294-be46-4a94-aac3-3669139caffc&session=49abce33-0e21-43b1-8baa-7ddcfaee51aa');
  await page.getByRole('button', { name: '编辑消息', exact: true }).first().waitFor({ timeout: 60000 });
  const assertCanvasFillsViewport = async () => {
    const bounds = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="canvas-editor"]');
      const root = canvas?.parentElement?.parentElement;
      return {
        viewportHeight: window.innerHeight,
        rootBottom: root?.getBoundingClientRect().bottom,
        canvasBottom: canvas?.getBoundingClientRect().bottom,
      };
    });
    assert.equal(bounds.rootBottom, bounds.viewportHeight, 'canvas page root must reach the viewport bottom');
    assert.equal(bounds.canvasBottom, bounds.viewportHeight, 'canvas must reach the viewport bottom');
  };
  await assertCanvasFillsViewport();
  // Keep the same page mounted while the browser viewport changes. This catches
  // stale canvas-root height after window resize without issuing API writes.
  for (const height of [668, 850, 900]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForFunction(expected => window.innerHeight === expected, height);
    await assertCanvasFillsViewport();
  }
  await mkdir('../../artifacts/message-actions', { recursive: true });
  await page.screenshot({ path: '../../artifacts/message-actions/display.png' });
  const copyButton = page.getByRole('button', { name: '复制消息', exact: true }).nth(targetMessageIndex);
  const editButton = page.getByRole('button', { name: '编辑消息', exact: true }).nth(targetMessageIndex);
  await editButton.scrollIntoViewIfNeeded();
  await copyButton.click();
  await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), original);
  await editButton.click();
  const editor = page.getByRole('textbox', { name: '编辑消息', exact: true });
  assert.equal(await editor.inputValue(), original);
  await editor.fill('生成一个画板，800*600');
  await page.screenshot({ path: '../../artifacts/message-actions/edit.png' });
  const beforeEditSend = await page.evaluate(() => ({
    documentTop: document.scrollingElement?.scrollTop,
    rootTop: document.querySelector('[data-testid="canvas-editor"]')?.parentElement?.parentElement?.getBoundingClientRect().top,
    rootScrollTop: document.querySelector('[data-testid="canvas-editor"]')?.parentElement?.parentElement?.scrollTop,
    canvasTop: document.querySelector('[data-testid="canvas-editor"]')?.getBoundingClientRect().top,
  }));
  await page.getByRole('button', { name: '发送编辑后的消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑消息', exact: true }).waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  const afterEditSend = await page.evaluate(() => ({
    documentTop: document.scrollingElement?.scrollTop,
    rootTop: document.querySelector('[data-testid="canvas-editor"]')?.parentElement?.parentElement?.getBoundingClientRect().top,
    rootScrollTop: document.querySelector('[data-testid="canvas-editor"]')?.parentElement?.parentElement?.scrollTop,
    canvasTop: document.querySelector('[data-testid="canvas-editor"]')?.getBoundingClientRect().top,
  }));
  assert.deepEqual(afterEditSend, beforeEditSend, 'editing and sending must not scroll the document, canvas root, or its canvas child');
  await page.screenshot({ path: '../../artifacts/message-actions/edit-send-complete.png' });
  assert.equal(await editor.count(), 0);
  assert.equal(submits, 1);
  console.log('PASS production message controls: clipboard, inline edit send, no document scroll, mocked Agent completion; zero real submissions');
} finally { await browser.close(); }
