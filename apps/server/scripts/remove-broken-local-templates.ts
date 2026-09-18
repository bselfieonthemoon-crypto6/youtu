// User-authorized, recoverable removal of the six audited local templates only.
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw Error('Local replica only');
const targets = new Map([
  ['11437b63-2bd3-4bda-9c68-dcc0cf7632b7', '解读'],
  ['59ee45d2-1044-4750-a2e8-7002cdd78dd5', '美食'],
  ['5c68fd31-da1e-4b3c-83d1-4a04ed90a336', '招聘会'],
  ['85fa42bd-6901-4428-8d40-d44c88181ca1', '新闻'],
  ['8a6adca2-2423-4f06-bf3b-ee4e2cb41682', '宠物'],
  ['f64afc6e-d835-4850-9205-bed8f91d11e1', '蛋黄派'],
]);
const owner = '541006fa-d2a1-4305-be55-b6263c27a1e3';
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY!, options);
await db.connect();
try {
  const audit = JSON.parse(await readFile('../../artifacts/design-catalog-health-20260908.json', 'utf8'));
  const failed = new Set(audit.issues.filter((x: any) => x.kind === 'full_preview').map((x: any) => x.id));
  if (failed.size !== targets.size || [...targets.keys()].some(id => !failed.has(id))) throw Error('Audit targets changed');
  const workspace = (await db.query('select workspace_id from design_documents where id=$1', ['4e9585ba-2f23-41d6-86aa-4fe01436511d'])).rows[0].workspace_id;
  const rows = (await db.query('select * from design_templates where id=any($1::uuid[]) order by id', [[...targets.keys()]])).rows;
  if (rows.length !== 6 || rows.some(row => row.name !== targets.get(row.id) || row.deleted_at || row.scope !== 'workspace' || row.workspace_id !== workspace)) throw Error('Target scope or state changed');
  const snapshot = async () => {
    const result: Record<string, string> = {};
    for (const table of ['design_documents', 'font_faces', 'design_resources', 'asset_objects']) {
      result[table] = (await db.query(`select md5(string_agg(row_to_json(t)::text, '' order by id)) as hash from public.${table} t`)).rows[0].hash;
    }
    return result;
  };
  const before = await snapshot();
  const backupPath = `../../artifacts/deleted-broken-templates-${Date.now()}.json`;
  await writeFile(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows, before }, null, 2), { flag: 'wx' });
  const user = await admin.auth.admin.getUserById(owner);
  if (user.error || !user.data.user.email) throw Error('Local owner unavailable');
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.data.user.email });
  if (link.error) throw Error('Local authentication link failed');
  const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
  if (login.error || !login.data.session) throw Error('Local authentication failed');
  for (const row of rows) {
    const response = await fetch('http://127.0.0.1:3002/api/admin/design-catalog/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: randomUUID(), entity_kind: 'template', entity_id: row.id, expected_revision: Number(row.revision) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error(`Delete failed for ${row.id}: ${response.status} ${await response.text()}`);
    console.log(JSON.stringify({ name: row.name, result: await response.json() }));
  }
  const after = await snapshot();
  const deleted = (await db.query('select id,name,deleted_at,revision from design_templates where id=any($1::uuid[])', [[...targets.keys()]])).rows;
  if (deleted.some(row => !row.deleted_at)) throw Error('Deletion verification failed');
  console.log(JSON.stringify({ deleted: deleted.length, unchanged: Object.fromEntries(Object.keys(before).map(table => [table, before[table] === after[table]])), backupPath }));
} finally {
  await auth.auth.signOut({ scope: 'local' });
  await db.end();
}
