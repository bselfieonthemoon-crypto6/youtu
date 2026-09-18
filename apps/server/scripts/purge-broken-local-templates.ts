// Explicitly authorized permanent deletion; never run against cloud data.
import { Client } from 'pg';

if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw Error('Local replica only');
const targets = new Map([
  ['11437b63-2bd3-4bda-9c68-dcc0cf7632b7', '解读'],
  ['59ee45d2-1044-4750-a2e8-7002cdd78dd5', '美食'],
  ['5c68fd31-da1e-4b3c-83d1-4a04ed90a336', '招聘会'],
  ['85fa42bd-6901-4428-8d40-d44c88181ca1', '新闻'],
  ['8a6adca2-2423-4f06-bf3b-ee4e2cb41682', '宠物'],
  ['f64afc6e-d835-4850-9205-bed8f91d11e1', '蛋黄派'],
]);
const ids = [...targets.keys()];
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
try {
  await db.query('begin');
  const workspace = (await db.query('select workspace_id from design_documents where id=$1', ['4e9585ba-2f23-41d6-86aa-4fe01436511d'])).rows[0].workspace_id;
  const rows = (await db.query('select id,name,scope,workspace_id,deleted_at,revision from design_templates where id=any($1::uuid[]) for update', [ids])).rows;
  if (rows.length !== 6 || rows.some(row => row.name !== targets.get(row.id) || !row.deleted_at || Number(row.revision) !== 3 || row.scope !== 'workspace' || row.workspace_id !== workspace)) throw Error('Target state changed');
  const requests = await db.query('select count(*)::int as count from design_agent_tool_requests where template_id=any($1::uuid[])', [ids]);
  if (requests.rows[0].count) throw Error('Templates still referenced by agent requests; no deletion performed');
  const snapshot = async () => {
    const result: Record<string, string> = {};
    for (const table of ['design_documents', 'font_faces', 'design_resources', 'asset_objects']) {
      result[table] = (await db.query(`select md5(string_agg(row_to_json(t)::text, '' order by id)) as hash from public.${table} t`)).rows[0].hash;
    }
    return result;
  };
  const before = await snapshot();
  const removed = await db.query('delete from design_templates where id=any($1::uuid[]) returning id,name', [ids]);
  if (removed.rowCount !== 6) throw Error('Unexpected deletion count');
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Protected data changed; rollback');
  for (const table of ['design_templates', 'design_template_asset_refs', 'design_template_font_refs', 'design_template_tag_links']) {
    const key = table === 'design_templates' ? 'id' : 'template_id';
    if ((await db.query(`select count(*)::int as count from ${table} where ${key}=any($1::uuid[])`, [ids])).rows[0].count !== 0) throw Error('Remaining template records');
  }
  await db.query('commit');
  console.log(JSON.stringify({ permanentlyDeleted: removed.rows, documentsFontsResourcesAssetsUnchanged: true }));
} catch (error) {
  await db.query('rollback');
  throw error;
} finally {
  await db.end();
}
