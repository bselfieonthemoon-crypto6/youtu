import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Real local authentication, project creation and canvas persistence are used.
// Every generation/job endpoint is intercepted, so this test cannot enqueue a
// provider request or consume credits. Traces/video stay off because they can
// retain authentication headers or websocket frames.
test.use({ trace: 'off', video: 'off', viewport: { width: 1440, height: 1000 } });

const supabase = 'http://127.0.0.1:54421';
const api = process.env.LOOMIC_E2E_SERVER_URL ?? 'http://127.0.0.1:3002';
const base = process.env.LOOMIC_E2E_BASE_URL ?? 'http://localhost:3020';
const qaUserId = '541006fa-d2a1-4305-be55-b6263c27a1e3';
const transparentPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X7L0WQAAAABJRU5ErkJggg==';

test('recovers one durable node job after a lost response and completes at its moved position', async ({ page, request }, info) => {
  test.skip(
    process.env.LOOMIC_NODE_IMAGE_QA !== 'true' || process.env.SUPABASE_URL !== supabase,
    'Explicit local-only opt in required',
  );
  test.setTimeout(180_000);
  expect(new URL(api).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  expect(new URL(base).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);

  const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(supabase, process.env.SUPABASE_SERVICE_ROLE_KEY!, authOptions);
  const auth = createClient(supabase, process.env.SUPABASE_ANON_KEY!, authOptions);
  const account = await admin.auth.admin.getUserById(qaUserId);
  if (!account.data.user?.email) throw new Error('Local QA account unavailable');
  const link = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: account.data.user.email,
  });
  if (link.error) throw new Error('Local QA login setup failed');
  const login = await auth.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.data.properties.hashed_token,
  });
  if (login.error || !login.data.session) throw new Error('Local QA login failed');
  const headers = { Authorization: `Bearer ${login.data.session.access_token}` };

  let projectId: string | undefined;
  let canvasId: string | undefined;
  let elementId: string | undefined;
  let submitted: Record<string, any> | undefined;
  let persistedBeforePost: Record<string, any> | undefined;
  const jobId = randomUUID();
  let postCount = 0;
  let lookupCount = 0;
  let pollCount = 0;
  let complete = false;
  const blockedPaidRoutes: string[] = [];
  const expectedBrowserErrors: string[] = [];
  const unexpectedBrowserErrors: string[] = [];
  const sanitize = (value: string) =>
    value
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
      .slice(0, 1000);

  page.on('console', event => {
    if (event.type() !== 'error') return;
    const output = sanitize(event.text());
    if (
      /node_submission_unavailable|Generation error: NodeImageSubmissionError|Failed to load resource.*503/i.test(output)
    ) {
      expectedBrowserErrors.push(output);
    } else {
      unexpectedBrowserErrors.push(output);
    }
  });
  page.on('pageerror', error => unexpectedBrowserErrors.push(sanitize(error.message)));

  const readCanvas = async () => {
    if (!canvasId) throw new Error('Canvas not created');
    const response = await request.get(`${api}/api/canvases/${canvasId}`, { headers });
    expect(response.ok()).toBe(true);
    return (await response.json()).canvas as {
      content: { elements?: any[]; files?: Record<string, any>; appState?: Record<string, any> };
    };
  };

  try {
    const health = await request.get(`${api}/api/health`);
    expect(health.ok()).toBe(true);
    const created = await request.post(`${api}/api/projects`, {
      headers,
      data: {
        name: `QA durable node ${randomUUID().slice(0, 8)}`,
        description: 'Isolated durable-node browser acceptance; mocked generation only',
      },
    });
    expect(created.ok()).toBe(true);
    const project = (await created.json()).project;
    projectId = project.id;
    canvasId = project.primaryCanvas.id;

    const fakeJob = () => {
      const now = new Date().toISOString();
      return {
        id: jobId,
        workspace_id: project.workspace.id,
        project_id: projectId,
        canvas_id: canvasId,
        target_kind: 'canvas',
        design_id: null,
        session_id: null,
        thread_id: null,
        queue_name: 'image_generation_jobs',
        job_type: 'image_generation',
        status: complete ? 'succeeded' : 'running',
        payload: submitted
          ? {
              prompt: submitted.prompt,
              model: submitted.model,
              aspect_ratio: submitted.aspect_ratio,
              quality: submitted.quality,
              operation: 'generate',
              target: { kind: 'canvas', canvas_id: canvasId, element_id: elementId },
            }
          : {},
        result: complete
          ? { canvas_element_id: elementId, canvas_finalized_at: now }
          : null,
        error_code: null,
        error_message: null,
        attempt_count: 1,
        max_attempts: 3,
        created_by: qaUserId,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: complete ? now : null,
        failed_at: null,
        canceled_at: null,
      };
    };

    await page.route('**/api/**', async route => {
      const browserRequest = route.request();
      const url = new URL(browserRequest.url());
      const method = browserRequest.method();
      if (method === 'POST' && url.pathname === '/api/jobs/node-image-generation') {
        postCount += 1;
        submitted = browserRequest.postDataJSON() as Record<string, any>;
        elementId = submitted.element_id;

        // This real API read occurs before the mocked POST response. It proves
        // the browser's save barrier persisted the frozen request first.
        const saved = await readCanvas();
        const node = saved.content.elements?.find(element => element.id === elementId);
        persistedBeforePost = node;
        expect(node).toMatchObject({
          id: elementId,
          customData: {
            type: 'image-generator',
            status: 'generating',
            nodeImageRequest: {
              requestId: submitted.request_id,
              state: 'submitting',
              prompt: submitted.prompt,
              model: submitted.model,
              aspectRatio: submitted.aspect_ratio,
              quality: submitted.quality,
            },
          },
        });

        // Model a server that accepted the job but whose HTTP response was
        // lost at the edge. The subsequent GET is the only safe recovery.
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'node_submission_unavailable',
              message: '提交结果暂时无法确认，请查询原请求；未自动重新生图。',
            },
          }),
        });
        return;
      }
      if (
        method === 'GET' &&
        submitted &&
        url.pathname === `/api/jobs/node-image-generation/${submitted.request_id}`
      ) {
        lookupCount += 1;
        expect(url.searchParams.get('canvas_id')).toBe(canvasId);
        expect(url.searchParams.get('element_id')).toBe(elementId);
        await route.fulfill({ json: { job: fakeJob() } });
        return;
      }
      if (method === 'GET' && url.pathname === `/api/jobs/${jobId}`) {
        pollCount += 1;
        await route.fulfill({ json: { job: fakeJob() } });
        return;
      }
      if (
        method === 'POST' &&
        /\/api\/(?:agent\/generate|jobs\/(?:image|video)-generation|runs)/.test(url.pathname)
      ) {
        blockedPaidRoutes.push(url.pathname);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    await page.addInitScript(
      ({ key, session }) => localStorage.setItem(key, JSON.stringify(session)),
      {
        key: `sb-${new URL(supabase).hostname.split('.')[0]}-auth-token`,
        session: login.data.session,
      },
    );
    await page.goto(`/canvas?id=${canvasId}`);
    await page.getByRole('button', { name: 'AI 生成图片', exact: true }).click({ timeout: 60_000 });
    const panel = page.getByRole('region', { name: '生图节点设置' });
    await expect(panel).toBeVisible();
    const prompt = '  持久节点原文：保留标点、空格与“Logo”。\n第二行不改写。  ';
    await panel.getByRole('textbox', { name: '图片生成提示词' }).fill(prompt);
    await panel.getByRole('button', { name: '生成图片' }).click();

    await expect.poll(() => postCount).toBe(1);
    await expect.poll(() => lookupCount).toBeGreaterThan(0);
    expect(persistedBeforePost).toBeTruthy();
    expect(submitted).toMatchObject({
      canvas_id: canvasId,
      element_id: elementId,
      prompt,
    });
    expect(submitted?.request_id).toMatch(/^[0-9a-f-]{36}$/);

    await expect.poll(async () => {
      const node = (await readCanvas()).content.elements?.find(element => element.id === elementId);
      return node?.customData?.jobId;
    }).toBe(jobId);
    expect(postCount, 'Read-only recovery must not automatically submit again').toBe(1);

    const overlay = page.locator(`[data-canvas-generating-overlay="${elementId}"]`);
    await expect(overlay).toBeVisible();
    const initialBox = await overlay.boundingBox();
    expect(initialBox).toBeTruthy();

    // Close the panel without canceling the durable job, then drag the actual
    // Excalidraw node while it remains in the running state.
    const blankX = initialBox!.x + initialBox!.width + 100 < 1200
      ? initialBox!.x + initialBox!.width + 100
      : Math.max(340, initialBox!.x - 100);
    await page.mouse.click(blankX, Math.max(120, initialBox!.y));
    await expect(panel).toBeHidden();
    await page.mouse.move(initialBox!.x + initialBox!.width / 2, initialBox!.y + initialBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      initialBox!.x + initialBox!.width / 2 + 140,
      initialBox!.y + initialBox!.height / 2 + 70,
      { steps: 12 },
    );
    await page.mouse.up();

    const before = persistedBeforePost!;
    await expect.poll(async () => {
      const node = (await readCanvas()).content.elements?.find(element => element.id === elementId);
      return Math.round((node?.x ?? before.x) - before.x);
    }).toBeGreaterThan(100);
    const movedCanvas = await readCanvas();
    const moved = movedCanvas.content.elements?.find(element => element.id === elementId);
    expect(moved.customData.jobId).toBe(jobId);
    expect(moved.customData.nodeImageRequest.requestId).toBe(submitted!.request_id);

    // Simulate the finalizer's persisted image output through the real canvas
    // API. No worker/provider endpoint is called and only the isolated project
    // is changed.
    const fileId = `qa-result-${randomUUID().slice(0, 12)}`;
    const completedElement = {
      ...moved,
      type: 'image',
      fileId,
      status: 'saved',
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      roundness: null,
      scale: [1, 1],
      crop: null,
      version: Number(moved.version ?? 1) + 1,
      versionNonce: Number(moved.versionNonce ?? 1) + 1,
      updated: Date.now(),
      customData: {
        source: 'generated',
        sourceJobId: jobId,
        sourceRequestId: submitted!.request_id,
        prompt,
        model: submitted!.model,
        mimeType: 'image/png',
        originalWidth: 1,
        originalHeight: 1,
      },
    };
    const completedSave = await request.put(`${api}/api/canvases/${canvasId}`, {
      headers,
      data: {
        content: {
          ...movedCanvas.content,
          elements: movedCanvas.content.elements?.map(element =>
            element.id === elementId ? completedElement : element,
          ),
          files: {
            ...(movedCanvas.content.files ?? {}),
            [fileId]: {
              id: fileId,
              dataURL: transparentPng,
              mimeType: 'image/png',
              created: Date.now(),
            },
          },
        },
      },
    });
    expect(completedSave.ok()).toBe(true);
    complete = true;

    await expect.poll(() => pollCount, { timeout: 20_000 }).toBeGreaterThan(1);
    await expect(overlay).toBeHidden({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(`[data-canvas-generating-overlay="${elementId}"]`)).toHaveCount(0);

    const finalCanvas = await readCanvas();
    const finalElement = finalCanvas.content.elements?.find(element => element.id === elementId);
    expect(finalElement).toMatchObject({
      id: elementId,
      type: 'image',
      x: moved.x,
      y: moved.y,
      customData: {
        sourceJobId: jobId,
        sourceRequestId: submitted!.request_id,
        prompt,
      },
    });
    expect(postCount).toBe(1);
    expect(blockedPaidRoutes).toEqual([]);
    expect(unexpectedBrowserErrors).toEqual([]);

    await writeFile(
      info.outputPath('node-image-durable-evidence.json'),
      JSON.stringify(
        {
          projectId,
          canvasId,
          elementId,
          requestId: submitted!.request_id,
          jobId,
          tested: [
            'real canvas save before mocked submission',
            'lost POST response',
            'read-only GET recovery',
            'panel close without cancellation',
            'running placeholder drag',
            'same-id completion at latest position',
            'reload persistence',
            'no automatic repeated POST',
          ],
          postCount,
          lookupCount,
          pollCount,
          blockedPaidRoutes,
          actualProviderCalls: 0,
          initialPosition: { x: before.x, y: before.y },
          movedPosition: { x: moved.x, y: moved.y },
          expectedBrowserErrors: expectedBrowserErrors.length,
          unexpectedBrowserErrors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto('about:blank');
    if (projectId) {
      const removed = await request.delete(`${api}/api/projects/${projectId}`, { headers });
      expect(removed.ok(), 'Archive only the isolated QA project').toBe(true);
    }
    const signedOut = await auth.auth.signOut({ scope: 'local' });
    expect(signedOut.error).toBeNull();
  }
});
