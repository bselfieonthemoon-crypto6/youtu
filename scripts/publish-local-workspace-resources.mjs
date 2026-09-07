// One-time operator action, scoped to the user's imported workspace resources.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {Pool}=require('pg');
const db=new Pool({connectionString:process.env.SUPABASE_DB_URL});
const client=await db.connect();
const version='20260908000003';
const workspace='25eb32ef-ff55-4de7-8c10-9390a51ece06';
try {
 await client.query('BEGIN');
 await client.query("SET LOCAL lock_timeout='5s'");
 await client.query("SET LOCAL statement_timeout='90s'");
 await client.query(`CREATE SCHEMA IF NOT EXISTS loomic_backup_20260907;
   REVOKE ALL ON SCHEMA loomic_backup_20260907 FROM PUBLIC,anon,authenticated;
   CREATE TABLE IF NOT EXISTS loomic_backup_20260907.resource_publication_rows
   (id uuid PRIMARY KEY, original_row jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS loomic_backup_20260907.resource_publication_function
   (version text PRIMARY KEY, original_definition text NOT NULL);
   REVOKE ALL ON ALL TABLES IN SCHEMA loomic_backup_20260907 FROM PUBLIC,anon,authenticated;`);
 await client.query(`INSERT INTO loomic_backup_20260907.resource_publication_rows
   SELECT r.id,to_jsonb(r) FROM public.design_resources r JOIN public.asset_objects a ON a.id=r.asset_object_id
   WHERE r.workspace_id=$1 AND a.object_path LIKE $2 AND r.status='pending_review' AND r.deleted_at IS NULL
   ON CONFLICT DO NOTHING`,[workspace,workspace+'/design-library-v1/%']);
 const applied=await client.query('SELECT version,name FROM supabase_migrations.schema_migrations WHERE version=$1',[version]);
 if(applied.rowCount&&applied.rows[0].name!=='workspace_resource_publication')throw Error('Migration version conflict');
 if(!applied.rowCount){
  await client.query(`INSERT INTO loomic_backup_20260907.resource_publication_function
    SELECT $1,pg_get_functiondef('private.loomic_catalog_publishable(text,uuid)'::regprocedure) ON CONFLICT DO NOTHING`,[version]);
  const sql=await readFile(new URL('../supabase/migrations/'+version+'_workspace_resource_publication.sql',import.meta.url),'utf8');
  await client.query(sql);
  await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',[version,'workspace_resource_publication',[sql]]);
 }
 const result=await client.query(`SELECT public.loomic_catalog_set_status(
   p_request_id => gen_random_uuid(),p_entity_kind => 'resource',p_entity_id => r.id,
   p_expected_revision => r.revision,p_status => 'published',p_actor_user_id => w.owner_user_id)
   FROM public.design_resources r JOIN public.workspaces w ON w.id=r.workspace_id
   JOIN public.asset_objects a ON a.id=r.asset_object_id
   WHERE r.workspace_id=$1 AND a.object_path LIKE $2 AND r.status='pending_review' AND r.deleted_at IS NULL`,[workspace,workspace+'/design-library-v1/%']);
 const checks=await client.query(`SELECT status,count(*)::int AS count,
   count(*) FILTER(WHERE NOT private.loomic_catalog_publishable('resource',r.id))::int AS invalid_dependencies
   FROM public.design_resources r WHERE workspace_id=$1 AND deleted_at IS NULL GROUP BY status`,[workspace]);
 if(checks.rows.some(r=>r.status==='published'&&r.invalid_dependencies))throw Error('Published dependency validation failed');
 await client.query('COMMIT');
 console.log(JSON.stringify({published:result.rowCount,checks:checks.rows}));
}catch(error){await client.query('ROLLBACK');console.error(JSON.stringify({message:error.message,where:error.where}));process.exitCode=1;}
finally{client.release();await db.end();}
