import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { compileMastraMemoryContext } from '../src/agent/mastra-memory-adapter.js';

// Local integration probe: a deliberately closed memory endpoint, real RLS chat
// history, no business writes, no model generation, no database outage injection.
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10);
assert(fixturePath, '--fixture required');
const manifest = JSON.parse(await readFile(fixturePath, 'utf8'));
const fixture = manifest.fixture ?? manifest;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
const auth = createClient(process.env.SUPABASE_URL!,
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY)!, options);
const { data: session, error } = await admin.from('chat_sessions')
  .select('canvas_id,created_by').eq('id', fixture.sessionId).single();
assert.ifError(error);
assert.equal(session.canvas_id, fixture.canvasId);
const { data: canvas } = await admin.from('canvases').select('project_id').eq('id', fixture.canvasId).single();
const { data: project } = await admin.from('projects').select('workspace_id').eq('id', canvas!.project_id).single();
const { data: account } = await admin.auth.admin.getUserById(session.created_by);
const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.user!.email! });
assert.ifError(linkError);
const { data: login, error: loginError } = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
assert.ifError(loginError);
assert(login.session);
const latest = await auth.from('chat_messages').select('id,content').eq('session_id', fixture.sessionId)
  .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).single();
assert.ifError(latest.error);
const started = Date.now();
const result = await compileMastraMemoryContext({
  client: auth,
  scope: { userId: session.created_by, workspaceId: project!.workspace_id, sessionId: fixture.sessionId },
  currentPrompt: 'Only a non-generating local storage-failure probe.',
  connectionString: 'postgresql://probe:non-secret@127.0.0.1:1/nonexistent_probe',
  model: 'openai/unused-no-model-call',
  limits: { maxContextBytes: 32000, summaryTargetBytes: 8000 },
});
assert.equal(result.observationalMemory.mode, 'degraded');
assert.equal(result.observationalMemory.degradedPhase, 'init');
assert(result.messages.some(row => row.id === latest.data!.id), 'Newest real message must survive storage failure');
assert(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages })) <= 32000);
assert(result.omissions.some(value => value.includes('unavailable')));
console.log(JSON.stringify({ status: 'passed', kind: 'real_rls_history_closed_memory_endpoint',
  elapsedMs: Date.now() - started, messages: result.messages.length,
  newestMessagePreserved: true, degradedPhase: result.observationalMemory.degradedPhase,
  modelCalls: 0, imageJobsSubmitted: 0 }));
