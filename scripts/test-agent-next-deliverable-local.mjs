import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const query = sql => execFileSync('docker', ['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','loomic_replica_light_20260907','-Atq'], { input: sql, encoding:'utf8', windowsHide:true, maxBuffer:2*1024*1024 });
if (query('select current_database()').trim() !== 'loomic_replica_light_20260907') throw new Error('Wrong database');
const base = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql',import.meta.url),'utf8');
const fixture = base.slice(0,base.indexOf('SELECT public.loomic_agent_task_begin')).replace(/^BEGIN;\r?$/m,'');
const migration = query("select count(*) from pg_proc where proname='loomic_agent_create_design_boards_v2'").trim() === '0'
  ? await readFile(new URL('../supabase/migrations/20260910000010_agent_next_deliverable.sql',import.meta.url),'utf8') : '';
query(`BEGIN;
${migration}
${fixture}
DO $$
DECLARE actor uuid:='aa010000-0000-4000-8000-000000000001'; sess uuid:='aa060000-0000-4000-8000-000000000001';
 old_run uuid:='aa070000-0000-4000-8000-000000000001'; next_run uuid:='aa070000-0000-4000-8000-000000000002';
 canv uuid:='aa040000-0000-4000-8000-000000000001'; prior_task jsonb; result jsonb; rev bigint; before_count bigint;
 boards jsonb:='[{"name":"Landing QA","width":720,"height":1280,"x":300,"y":200}]';
BEGIN
 prior_task:=public.loomic_agent_task_begin(actor,sess,canv,old_run,'Brand aaa.com; preserve logo and exact brand text',
   '{"kind":"canvas_image","elementId":"source-a","assetId":"aa050000-0000-4000-8000-000000000001"}',NULL);
 PERFORM public.loomic_agent_task_update_brief(old_run,'{"goal":"old model suggestion","preserve":["brand"],"imageResult":{"jobId":"old-job"}}');
 SELECT revision INTO rev FROM public.canvases WHERE id=canv;
 SELECT count(*) INTO before_count FROM public.design_documents;
 PERFORM pg_temp.qa_error(format('select public.loomic_agent_create_design_boards_v2(%L,%L,%L,%L,%s,%L::jsonb,%L::uuid[],false,%L,%L,%s)',
  actor,sess,next_run,'Continue with a landing page',rev,boards,'{}',prior_task->>'id',old_run,99),'agent_creation_inherited_task_changed');
 result:=public.loomic_agent_create_design_boards_v2(actor,sess,next_run,'Continue with a landing page',rev,boards,'{}',false,
   (prior_task->>'id')::uuid,old_run,(prior_task->>'revision')::bigint);
 PERFORM pg_temp.qa_assert(result->'task'->>'goal'=prior_task->>'goal','original user goal preserved');
 PERFORM pg_temp.qa_assert(result->'task'->'corrections' @> '["Continue with a landing page"]','new deliverable recorded');
 PERFORM pg_temp.qa_assert(result->'task'->'target'->>'kind'='design','fresh design target bound');
 PERFORM pg_temp.qa_assert(NOT (result->'task'->'brief' ? 'imageResult'),'old result authority not inherited');
 PERFORM pg_temp.qa_assert((SELECT count(*)=before_count+1 FROM public.design_documents),'one new document');
 PERFORM pg_temp.qa_assert((SELECT content->'elements'->0->>'id'='source-a' FROM public.canvases WHERE id=canv),'original object retained');
 PERFORM pg_temp.qa_assert(public.loomic_agent_create_design_boards_v2(actor,sess,next_run,'Continue with a landing page',rev,boards,'{}',false,
   (prior_task->>'id')::uuid,old_run,(prior_task->>'revision')::bigint)->>'replayed'='true','creation replay idempotent');
 PERFORM pg_temp.qa_assert((SELECT count(*)=before_count+1 FROM public.design_documents),'replay creates no duplicate');
 PERFORM pg_temp.qa_error(format('select public.loomic_agent_create_design_boards_v2(%L,%L,%L,%L,%s,%L::jsonb,%L::uuid[],false,%L,%L,%s)',
  'aa010000-0000-4000-8000-000000000002',sess,next_run,'Continue with a landing page',rev,boards,'{}',prior_task->>'id',old_run,1),'agent_creation_session_forbidden');
 PERFORM pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_create_design_boards_v2(uuid,uuid,uuid,text,bigint,jsonb,uuid[],boolean,uuid,uuid,bigint)','EXECUTE'),'no direct browser authority');
END $$;
ROLLBACK;`);
console.log('PASS next deliverable: inherited user goal, new target, stale/foreign lineage rejected, idempotent replay. All fixture writes rolled back; no provider calls.');
