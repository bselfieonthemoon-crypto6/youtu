import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const base = JSON.parse(await readFile('../../artifacts/paid-dialogue-live/mastra-migration-20260913.json', 'utf8'));
const fixture = base.fixture ?? base;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: source, error } = await db.from('canvases').select('project_id,workspace_id,created_by').eq('id', fixture.canvasId).single();
assert.ifError(error);
const canvas = await db.from('canvases').insert({ ...source, name: 'QA 尺寸与画质独立验收 20260914', content: { elements: [], files: {}, appState: {} } }).select('id').single();
assert.ifError(canvas.error);
const session = await db.from('chat_sessions').insert({ canvas_id: canvas.data.id, created_by: source.created_by, thread_id: `thread_${randomUUID()}`, title: 'QA 原生尺寸验收' }).select('id').single();
assert.ifError(session.error);
const output = { ...base, fixture: { ...fixture, canvasId: canvas.data.id, sessionId: session.data.id } };
await writeFile('../../artifacts/paid-dialogue-live/native-size-20260914.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ canvasId: canvas.data.id, sessionId: session.data.id }));
