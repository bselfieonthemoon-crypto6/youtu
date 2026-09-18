/** Real local API/RLS probes using two fresh tenants. No model requests.
 * Fixtures are deliberately retained for inspection; never touches existing tenants.
 * Usage: node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/test-saas-isolation-live.ts --submit
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createCreditService } from '../src/features/credits/credit-service.js';

assert(process.argv.includes('--submit'), 'Explicit --submit required for isolated fixtures');
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const api = 'http://127.0.0.1:3002';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts);
const stamp = randomUUID();
const checks: Array<{ name: string; passed: boolean; status?: number; code?: string }> = [];
const actors: any[] = [];
function check(name: string, passed: boolean, extra: { status?: number; code?: string } = {}) {
  checks.push({ name, passed, ...extra });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${extra.status ? ` HTTP ${extra.status}` : ''}`);
}
async function request(actor: any, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(api + path, { method, headers: {
    ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, data: await response.json().catch(() => null) };
}
async function createActor(label: string) {
  const email = `saas-boundary-${label}-${stamp}@example.invalid`;
  const password = randomUUID() + '!Qa9';
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error); assert(created.data.user);
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, opts);
  const login = await client.auth.signInWithPassword({ email, password });
  assert.ifError(login.error); assert(login.data.session);
  const actor: any = { label, userId: created.data.user.id, client, token: login.data.session.access_token };
  actors.push(actor);
  const viewer = await request(actor, 'GET', '/api/viewer'); assert.equal(viewer.status, 200);
  actor.workspaceId = viewer.data.workspace.id;
  const project = await request(actor, 'POST', '/api/projects', { name: `QA SaaS ${label} ${stamp}` });
  assert.equal(project.status, 201); actor.projectId = project.data.project.id;
  actor.canvasId = project.data.project.primaryCanvas.id;
  const session = await request(actor, 'POST', `/api/canvases/${actor.canvasId}/sessions`, { title: `Private ${label}` });
  assert.equal(session.status, 201); actor.sessionId = session.data.session.id;
  const message = await request(actor, 'POST', `/api/sessions/${actor.sessionId}/messages`, {
    role: 'user', content: `PRIVATE_${label}_${stamp}`, contentBlocks: [{ type: 'text', text: `PRIVATE_${label}_${stamp}` }],
  });
  assert.equal(message.status, 201); actor.messageId = message.data.message.id;
  // Terminal test record: no queue enqueue, provider or credit operation.
  const job = await admin.from('background_jobs').insert({ workspace_id: actor.workspaceId,
    project_id: actor.projectId, canvas_id: actor.canvasId, session_id: actor.sessionId,
    queue_name: 'image_generation_jobs', job_type: 'image_generation', status: 'canceled',
    created_by: actor.userId, canceled_at: new Date().toISOString(), payload: { qa: stamp },
  }).select('id').single(); assert.ifError(job.error); actor.jobId = job.data!.id;
  const path = `${actor.workspaceId}/qa-saas-${stamp}/${label}.png`;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const upload = await admin.storage.from('workspace-assets').upload(path, bytes, { contentType: 'image/png' });
  assert.ifError(upload.error); actor.assetPath = path;
  const asset = await admin.from('asset_objects').insert({ workspace_id: actor.workspaceId, project_id: actor.projectId,
    bucket: 'workspace-assets', object_path: path, mime_type: 'image/png', byte_size: bytes.length, created_by: actor.userId,
  }).select('id').single(); assert.ifError(asset.error); actor.assetId = asset.data!.id;
  return actor;
}
async function probes(owner: any, outsider: any) {
  const reads = [`/api/projects/${owner.projectId}`, `/api/canvases/${owner.canvasId}`,
    `/api/sessions/${owner.sessionId}/messages`, `/api/jobs/${owner.jobId}`];
  for (const path of reads) {
    const positive = await request(owner, 'GET', path);
    check(`${owner.label}: owner reads ${path.split('/')[2]}`, positive.status === 200, { status: positive.status });
    const negative = await request(outsider, 'GET', path);
    const emptyMessages = path.endsWith('/messages') && negative.status === 200 && Array.isArray(negative.data?.messages) && negative.data.messages.length === 0;
    check(`${outsider.label}: no ${owner.label} data from ${path.split('/')[2]}`, [403, 404].includes(negative.status) || emptyMessages, { status: negative.status, code: negative.data?.error?.code });
    const anonymous = await request(null, 'GET', path);
    check(`anonymous cannot read ${owner.label} ${path.split('/')[2]}`, anonymous.status === 401, { status: anonymous.status });
  }
  for (const [method, path, body] of [
    ['PATCH', `/api/projects/${owner.projectId}`, { name: 'FOREIGN_WRITE' }],
    ['PUT', `/api/canvases/${owner.canvasId}`, { content: { elements: [], appState: {}, files: {}, qa: 'FOREIGN_WRITE' } }],
    ['POST', `/api/canvases/${owner.canvasId}/sessions`, { title: 'FOREIGN_WRITE' }],
    ['POST', `/api/sessions/${owner.sessionId}/messages`, { role: 'user', content: 'FOREIGN_WRITE' }],
    ['POST', `/api/jobs/${owner.jobId}/cancel`, {}],
  ] as const) {
    const result = await request(outsider, method, path, body);
    check(`${outsider.label}: cannot ${method} foreign ${path.split('/')[2]}`, [403, 404].includes(result.status), { status: result.status, code: result.data?.error?.code });
  }
  for (const [table, id] of [['projects', owner.projectId], ['canvases', owner.canvasId],
    ['chat_sessions', owner.sessionId], ['chat_messages', owner.messageId],
    ['background_jobs', owner.jobId], ['asset_objects', owner.assetId]]) {
    const own = await owner.client.from(table).select('id').eq('id', id);
    check(`${owner.label}: own RLS ${table}`, !own.error && own.data?.length === 1);
    const other = await outsider.client.from(table).select('id').eq('id', id);
    check(`${outsider.label}: RLS hides ${owner.label} ${table}`, !other.error && other.data?.length === 0, { code: other.error?.code });
  }
  const ownDownload = await owner.client.storage.from('workspace-assets').download(owner.assetPath);
  check(`${owner.label}: own storage download`, !ownDownload.error && !!ownDownload.data);
  const foreignDownload = await outsider.client.storage.from('workspace-assets').download(owner.assetPath);
  check(`${outsider.label}: cannot download ${owner.label} storage`, !!foreignDownload.error && !foreignDownload.data);
  const signed = await outsider.client.storage.from('workspace-assets').createSignedUrl(owner.assetPath, 60);
  check(`${outsider.label}: cannot sign ${owner.label} storage`, !!signed.error && !signed.data);
  const publicUrl = admin.storage.from('workspace-assets').getPublicUrl(owner.assetPath).data.publicUrl;
  const publicRead = await fetch(publicUrl, { signal: AbortSignal.timeout(10_000) });
  check(`anonymous cannot bypass ${owner.label} storage via public URL`, !publicRead.ok, { status: publicRead.status });
  const originalMessages = await request(owner, 'GET', `/api/sessions/${owner.sessionId}/messages`);
  check(`${owner.label}: rejected foreign write inserted no message`, originalMessages.data?.messages?.length === 1 && originalMessages.data.messages[0].content === `PRIVATE_${owner.label}_${stamp}`);
}
async function billingProbe(owner: any, outsider: any) {
  const balance = async () => {
    const row = await admin.from('credit_balances').select('balance').eq('workspace_id', owner.workspaceId).single();
    assert.ifError(row.error); return row.data!.balance;
  };
  const before = await balance();
  const job = await admin.from('background_jobs').insert({ workspace_id: owner.workspaceId,
    created_by: owner.userId, queue_name: 'image_generation_jobs', job_type: 'image_generation',
    status: 'queued', payload: { qa: stamp, neverEnqueued: true },
  }).select('id').single(); assert.ifError(job.error);
  const jobId = job.data!.id;
  const args = { p_workspace_id: owner.workspaceId, p_user_id: owner.userId, p_job_id: jobId,
    p_amount: 5, p_description: `QA only ${stamp}` };
  try {
    const charges = await Promise.all(Array.from({ length: 4 }, () => admin.rpc('loomic_deduct_credits_idempotent', args)));
    check('four concurrent charge RPCs succeed as replay', charges.every(x => !x.error));
    check('only one charge RPC reports charged_new', charges.filter(x => x.data?.charged_new === true).length === 1);
    check('nonzero balance deducted exactly once', await balance() === before - 5);
    const cancel = await admin.from('background_jobs').update({ status: 'canceled', canceled_at: new Date().toISOString() }).eq('id', jobId);
    assert.ifError(cancel.error);
    const forged = await outsider.client.rpc('refund_credits', args);
    check('ordinary foreign JWT cannot invoke refund RPC', !!forged.error, { code: forged.error?.code });
    const refunds = await Promise.all(Array.from({ length: 4 }, () => admin.rpc('refund_credits', args)));
    check('exactly one concurrent refund RPC succeeds', refunds.filter(x => !x.error).length === 1);
    check('duplicate refund RPCs explicitly rejected', refunds.filter(x => x.error?.message?.includes('credit_job_already_refunded')).length === 3);
    check('nonzero balance restored exactly once', await balance() === before);
    const ledger = await admin.from('credit_transactions').select('transaction_type,amount').eq('job_id', jobId);
    assert.ifError(ledger.error);
    check('one deduction and one refund in real ledger', ledger.data?.length === 2 && ledger.data.reduce((sum, x) => sum + x.amount, 0) === 0);
    const service = createCreditService({ getAdminClient: () => admin as any });
    const replay = await Promise.all(Array.from({ length: 4 }, () => service.refundCredits(owner.workspaceId, owner.userId, 5, jobId)));
    const existing = await admin.from('credit_transactions').select('id').eq('job_id', jobId).eq('transaction_type', 'generation_refund').single();
    assert.ifError(existing.error);
    check('service concurrent replay returns original refund receipt', replay.every(id => id === existing.data!.id));
    await assert.rejects(service.refundCredits(owner.workspaceId, owner.userId, 6, jobId));
    check('wrong refund amount still rejected', await balance() === before);
    await assert.rejects(service.refundCredits(outsider.workspaceId, outsider.userId, 5, jobId));
    check('foreign refund identity still rejected', await balance() === before);
    owner.billingJobId = jobId;
  } finally {
    // Retain an inspectable terminal QA record, never a runnable unqueued orphan.
    await admin.from('background_jobs').update({ status: 'canceled', canceled_at: new Date().toISOString() }).eq('id', jobId);
  }
}
try {
  const a = await createActor('A'); const b = await createActor('B');
  check('distinct personal workspaces', a.workspaceId !== b.workspaceId);
  await probes(a, b); await probes(b, a);
  await billingProbe(a, b);
  // Alternate tenants through the same running server to expose cached viewer bleed.
  for (let i = 0; i < 5; i++) {
    const replies = await Promise.all([request(a, 'GET', '/api/viewer'), request(b, 'GET', '/api/viewer')]);
    check(`parallel viewer isolation ${i + 1}`, replies[0].data?.workspace.id === a.workspaceId && replies[1].data?.workspace.id === b.workspaceId);
  }
} finally {
  const dir = resolve('../../artifacts/saas-boundary'); await mkdir(dir, { recursive: true });
  const result = { createdAt: new Date().toISOString(), fixtureId: stamp, kind: 'real-local-api-rls', providerRequests: 0,
    fixturesRetained: true, actors: actors.map(({ label, userId, workspaceId, projectId, canvasId, sessionId, jobId, assetId, assetPath, billingJobId }) =>
      ({ label, userId, workspaceId, projectId, canvasId, sessionId, jobId, assetId, assetPath, billingJobId })), checks };
  const path = resolve(dir, `isolation-${stamp}.json`); await writeFile(path, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ report: path, checks: checks.length, failed: checks.filter(x => !x.passed).length, providerRequests: 0 }));
  for (const actor of actors) await actor.client.auth.signOut({ scope: 'local' });
  if (checks.some(x => !x.passed)) process.exitCode = 1;
}
