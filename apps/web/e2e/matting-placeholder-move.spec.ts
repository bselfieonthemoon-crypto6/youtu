import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { insertImageElement } from '../../server/src/features/canvas/canvas-element-writer';

test.use({ trace: 'off', video: 'off' });
test('two jobs finish on their own moved nodes despite a query failure', async ({ page, request }) => {
  test.skip(process.env.SUPABASE_URL !== 'http://127.0.0.1:54421', 'Local only');
  test.setTimeout(120000);
  const url = process.env.SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const user = (await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3')).data.user!;
  const link = (await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email! })).data;
  const session = (await client.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token })).data.session!;
  const headers = { Authorization: `Bearer ${session.access_token}` };
  const server = 'http://127.0.0.1:3002';
  try {
    const created = await request.post(`${server}/api/projects`, { headers, data: { name: `Moved matting regression ${Date.now()}` } });
    expect(created.ok()).toBe(true);
    const { project } = await created.json();
    const canvasId = project.primaryCanvas.id;
    const jobs = [randomUUID(), randomUUID()];
    const completed = new Set<string>();
    let failedQuery = false;
    const jobFor = (id: string) => ({ id, workspace_id: '25eb32ef-ff55-4de7-8c10-9390a51ece06', project_id: project.id, canvas_id: canvasId, target_kind: 'canvas', design_id: null, session_id: null, thread_id: null, queue_name: 'image_generation_jobs', job_type: 'image_generation', status: completed.has(id) ? 'succeeded' : 'running', payload: {}, result: completed.has(id) ? { canvas_element_id: `pending-${jobs.indexOf(id)}` } : null, error_code: null, error_message: null, attempt_count: 1, max_attempts: 3, created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: null, completed_at: null, failed_at: null, canceled_at: null });
    await page.route('**/api/jobs/*', async route => {
      const id = route.request().url().split('/').pop()!;
      if (!jobs.includes(id)) return route.continue();
      if (id === jobs[1] && !failedQuery) { failedQuery = true; return route.fulfill({ status: 503, json: { error: { code: 'job_query_failed', message: 'Failed to query job.' } } }); }
      return route.fulfill({ json: { job: jobFor(id) } });
    });
    const elements = jobs.map((jobId, i) => ({ id: `pending-${i}`, type: 'rectangle', x: 100 + i * 350, y: 350, width: 220, height: 220, angle: 0, strokeColor: '#D1D5DB', backgroundColor: '#F3F4F6', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, customData: { type: 'image-replacement', operation: 'remove-background', status: 'generating', jobId } }));
    expect((await request.put(`${server}/api/canvases/${canvasId}`, { headers, data: { content: { elements, files: {}, appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } } } })).ok()).toBe(true);
    await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${new URL(url).hostname.split('.')[0]}-auth-token`, session });
    await page.goto(`/canvas?id=${canvasId}`);
    await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
    await expect.poll(async () => failedQuery).toBe(true);
    // Move the second actual canvas node upward with the mouse.
    await page.mouse.move(550, 450); await page.mouse.down(); await page.mouse.move(550, 170, { steps: 12 }); await page.mouse.up();
    const readCanvas = async () => (await (await request.get(`${server}/api/canvases/${canvasId}`, { headers })).json()).canvas;
    await expect.poll(async () => (await readCanvas()).content.elements.find((e: any) => e.id === 'pending-1')?.y).toBeLessThan(200);
    const moved = (await readCanvas()).content.elements.find((e: any) => e.id === 'pending-1');
    // Reuse one already-generated test asset: no paid API calls in this regression.
    const asset = (await admin.from('asset_objects').select('id,object_path').eq('id', '03c578d3-7e36-5f29-87e5-36282dc988e9').single()).data!;
    for (const i of [1, 0, 1]) {
      await insertImageElement(admin as never, { canvasId, sourceJobId: jobs[i], replaceElementId: `pending-${i}`, assetId: asset.id, objectPath: asset.object_path, width: 256, height: 256, mimeType: 'image/png' }, { x: 100 + i * 350, y: 350, width: 220, height: 220 });
      completed.add(jobs[i]!);
    }
    await expect.poll(async () => (await readCanvas()).content.elements.filter((e: any) => !e.isDeleted && e.type === 'image').length).toBe(2);
    await page.reload();
    await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
    const saved = (await readCanvas()).content.elements;
    expect(saved.find((e: any) => e.id === 'pending-1')).toMatchObject({ type: 'image', x: moved.x, y: moved.y, isDeleted: false });
    expect(saved.find((e: any) => e.id === 'pending-0')).toMatchObject({ type: 'image', y: 350, isDeleted: false });
    expect(saved.filter((e: any) => !e.isDeleted && e.customData?.type === 'image-replacement')).toHaveLength(0);
    console.log(JSON.stringify({ canvasId, queryFailureRecovered: failedQuery, providerCalls: 0, movedY: moved.y }));
  } finally { await client.auth.signOut({ scope: 'local' }); }
});
