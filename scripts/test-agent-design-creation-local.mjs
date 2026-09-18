import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const query = sql => execFileSync('docker', ['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','loomic_replica_light_20260907','-Atq'], { input: sql, encoding:'utf8', windowsHide:true, maxBuffer:2*1024*1024 });
if (query('select current_database()').trim() !== 'loomic_replica_light_20260907') throw new Error('Wrong database');
const base = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql',import.meta.url),'utf8');
const fixture = base.slice(0,base.indexOf('SELECT public.loomic_agent_task_begin')).replace(/^BEGIN;\r?$/m,'');
const migration = query("select count(*) from pg_proc where proname='loomic_agent_create_design_boards'").trim() === '0'
  ? await readFile(new URL('../supabase/migrations/20260910000008_agent_design_creation.sql',import.meta.url),'utf8') : '';
query(`BEGIN;
${migration}
${fixture}
DO $$
DECLARE actor uuid:='aa010000-0000-4000-8000-000000000001'; session uuid:='aa060000-0000-4000-8000-000000000001';
 run uuid:='aa070000-0000-4000-8000-000000000001'; canvas uuid:='aa040000-0000-4000-8000-000000000001';
 revision bigint; boards jsonb:='[{"name":"Blank QA","width":658,"height":176,"x":200,"y":300}]'; result jsonb; before_count bigint;
BEGIN
 SELECT c.revision INTO revision FROM public.canvases c WHERE id=canvas;
 SELECT count(*) INTO before_count FROM public.design_documents;
 PERFORM pg_temp.qa_error(format('select public.loomic_agent_create_design_boards(%L,%L,%L,%L,%s,%L::jsonb,%L::uuid[],false)',
   actor,session,run,'Create one blank board',revision+1,boards,'{}'),'agent_creation_canvas_conflict');
 result:=public.loomic_agent_create_design_boards(actor,session,run,'Create one blank board',revision,boards,'{}',false);
 PERFORM pg_temp.qa_assert(result->>'status'='created','board created');
 PERFORM pg_temp.qa_assert((SELECT count(*)=before_count+1 FROM public.design_documents),'one document persisted');
 PERFORM pg_temp.qa_assert(public.loomic_agent_task_assert_current(run)->>'id'=result->'task'->>'id','task bound');
 PERFORM pg_temp.qa_assert((SELECT count(*)=1 FROM public.design_nodes WHERE canvas_id=canvas AND design_id=(result->'boards'->0->>'design_id')::uuid),'canvas binding persisted');
 PERFORM pg_temp.qa_assert((SELECT width=658 AND height=176 FROM public.design_documents WHERE id=(result->'boards'->0->>'design_id')::uuid),'exact dimensions');
 PERFORM pg_temp.qa_assert((SELECT jsonb_array_length(content->'elements')=2 FROM public.canvases WHERE id=canvas),'existing source plus new board');
 PERFORM pg_temp.qa_assert(public.loomic_agent_create_design_boards(actor,session,run,'Create one blank board',revision,boards,'{}',false)->>'replayed'='true','replay idempotent');
 PERFORM pg_temp.qa_assert((SELECT count(*)=before_count+1 FROM public.design_documents),'no duplicate document');
 PERFORM pg_temp.qa_error(format('select public.loomic_agent_create_design_boards(%L,%L,%L,%L,%s,%L::jsonb,%L::uuid[],false)',
   actor,session,'aa070000-0000-4000-8000-000000000003','Create two boards',revision+1,
   boards||'[{"name":"Invalid","width":0,"height":176,"x":600,"y":300}]'::jsonb,'{}'),'design_create_input_invalid');
 PERFORM pg_temp.qa_assert((SELECT count(*)=before_count+1 FROM public.design_documents),'later failure rolls back entire batch');
 PERFORM pg_temp.qa_error(format('select public.loomic_agent_create_design_boards(%L,%L,%L,%L,%s,%L::jsonb,%L::uuid[],false)',
   actor,session,run,'Different request',revision,boards,'{}'),'agent_creation_replay_conflict');
 PERFORM pg_temp.qa_error(format('select public.loomic_agent_create_design_boards(%L,%L,%L,%L,%s,%L::jsonb,%L::uuid[],false)',
   'aa010000-0000-4000-8000-000000000002',session,run,'Create one blank board',revision,boards,'{}'),'agent_creation_session_forbidden');
 PERFORM pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_create_design_boards(uuid,uuid,uuid,text,bigint,jsonb,uuid[],boolean)','EXECUTE'),'no direct browser authority');
END $$;
ROLLBACK;`);
console.log('PASS native creation: dimensions, task binding, canvas binding, CAS, replay, tenant isolation. Fixture and writes rolled back.');
