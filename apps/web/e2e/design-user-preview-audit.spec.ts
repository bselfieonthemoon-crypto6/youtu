import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
test.use({ trace: 'off', video: 'off' });
test('read-only audit of the reported board preview', async ({ page }, info) => {
  test.skip(process.env.SUPABASE_URL !== 'http://127.0.0.1:54421', 'Local only');
  const url = process.env.SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user!.email! });
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: auth } = await client.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: 'magiclink' });
  try {
    await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${new URL(url).hostname.split('.')[0]}-auth-token`, session: auth.session });
    // Do not persist normalization/autosave while inspecting the user's board.
    await page.route('**/api/**', route => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.fulfill({ status: 409, json: { error: { message: 'Read-only audit' } } }));
    const seen: string[] = [];
    page.on('request', req => { if (req.url().includes('/api/uploads/')) seen.push(new URL(req.url()).pathname); });
    await page.goto('/canvas?id=38d02c58-71e0-4c2c-bb08-f011b6c37ce1');
    const board = page.locator('[data-testid="design-node-preview"][data-design-id="4e9585ba-2f23-41d6-86aa-4fe01436511d"]');
    await expect(board).toBeVisible({ timeout: 30000 });
    await expect.poll(() => board.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await board.screenshot({ path: info.outputPath('actual-outer-board.png') });
    await board.dblclick({ force: true });
    const editor = page.getByTestId('design-inline-editor');
    await expect(editor).toBeVisible({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => [...document.fonts].some(f => f.family === 'HappyZcool-2016' && f.status === 'loaded'))).toBe(true);
    await expect(editor.locator('canvas').first()).toBeVisible();
    // Wait for asynchronous image hydration, not merely font registration.
    await expect.poll(() => editor.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
      const pixel = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 8), 1, 1).data;
      return pixel[3] > 0 && pixel[2] < 240;
    }), { timeout: 30000 }).toBe(true);
    await editor.screenshot({ path: info.outputPath('actual-editor-original-font.png') });
    console.log(JSON.stringify({ previewRequests: seen }));
  } finally { await client.auth.signOut({ scope: 'local' }); }
});
