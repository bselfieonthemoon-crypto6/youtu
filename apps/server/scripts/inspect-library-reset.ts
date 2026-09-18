import {Client} from 'pg';
const db=new Client({connectionString:process.env.SUPABASE_DB_URL});
if(process.env.SUPABASE_URL!=='http://127.0.0.1:54421')throw Error('Local only');
await db.connect();
try{
for(const sql of [
"select count(*) as in_use from design_resources r where deleted_at is null and (exists(select 1 from design_document_asset_refs a where a.resource_id=r.id) or exists(select 1 from design_template_asset_refs a where a.resource_id=r.id))",
"select id,project_id from canvases where id='df3b513c-6c2d-40e3-a784-123c35643806'",
"select id,workspace_id from projects where id in(select project_id from canvases where id='df3b513c-6c2d-40e3-a784-123c35643806')",
"select scope,workspace_id,status,count(*) from design_templates where deleted_at is null group by 1,2,3",
"select scope,workspace_id,status,count(*) from design_resources where deleted_at is null group by 1,2,3",
"select id,owner_user_id from workspaces where id='25eb32ef-ff55-4de7-8c10-9390a51ece06'",
"select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('workspace_members','workspaces')",
])console.log(JSON.stringify({sql,rows:(await db.query(sql)).rows}));
}finally{await db.end();}
