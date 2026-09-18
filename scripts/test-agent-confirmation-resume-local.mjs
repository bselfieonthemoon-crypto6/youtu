import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const container = "supabase_db_thtdhcvjppuvlvahfmga";
const database = "loomic_replica_light_20260907";
const query = (sql) => execFileSync(
  "docker",
  ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", database, "-Atq"],
  { input: sql, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
);

if (query("SELECT current_database();").trim() !== database) {
  throw new Error("Refusing to test agent confirmations outside the disposable local replica");
}

const migrationNames = [
  "20260910000001_agent_autonomy",
  "20260910000002_agent_confirmation_resume",
  "20260910000003_agent_target_scope",
];
const missingMigrations = migrationNames.filter((name) =>
  query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${name.slice(0, 14)}';`).trim() === "0"
);
const migration = (await Promise.all(missingMigrations.map((name) =>
  readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8")
))).join("\n");
const fixtureSource = await readFile(
  new URL("../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql", import.meta.url),
  "utf8",
);
const fixture = fixtureSource
  .slice(0, fixtureSource.indexOf("SELECT pg_temp.qa_error"))
  .replace(/^BEGIN;\r?$/m, "");

const actor = "'aa010000-0000-4000-8000-000000000002'";
const workspace = "'aa020000-0000-4000-8000-000000000002'";
const project = "'aa030000-0000-4000-8000-000000000002'";
const canvas = "'aa040000-0000-4000-8000-000000000002'";
const session = "'aa060000-0000-4000-8000-000000000002'";
const run = "'aa070000-0000-4000-8000-000000000004'";
const correctionRun = "'aa070000-0000-4000-8000-000000000005'";
const design = "'ac010000-0000-4000-8000-000000000001'";
const objectId = "'ac020000-0000-4000-8000-000000000001'";
const toolExecution = "'ac025000-0000-4000-8000-000000000001'";
const confirmation = "'ac030000-0000-4000-8000-000000000001'";
const staleConfirmation = "'ac030000-0000-4000-8000-000000000002'";
const canceledConfirmation = "'ac030000-0000-4000-8000-000000000003'";

const createConfirmation = (id) => `
SELECT public.loomic_create_agent_action_confirmation(
  ${id},'design_mutation',${actor},${workspace},${session},${canvas},
  (SELECT id FROM public.agent_design_tasks WHERE current_run_id=${run}),1,${run},${toolExecution},'delete-logo',
  jsonb_build_object('designId',${design}::text,'expectedRevision',0),
  jsonb_build_object(
    'design_id',${design}::text,
    'expected_revision',0,
    'idempotency_key',${id}::text,
    'commands',jsonb_build_array(jsonb_build_object(
      'action','object.remove','object_id',${objectId}::text,'expected_object_version',1
    ))
  ),
  now()+interval '10 minutes'
);`;

const sql = `BEGIN;
${migration}
${fixture}

INSERT INTO public.agent_runs(id,session_id,thread_id,status,execution_mode,created_by)
VALUES(${correctionRun},${session},'task-confirmation-correction','running','fast',${actor});
INSERT INTO public.design_documents(id,workspace_id,project_id,name,scene,width,height,created_by)
VALUES(${design},${workspace},${project},'Confirmation QA',jsonb_build_object(
  'schemaVersion',1,'engine','fabric','canvas',jsonb_build_object('width',640,'height',360,'background','#ffffff'),
  'objects',jsonb_build_array(jsonb_build_object(
    'objectId',${objectId}::text,'objectVersion',1,'type','rect','name','Logo','x',20,'y',20,
    'width',100,'height',100,'rotation',0,'opacity',1,'visible',true,'locked',false,'zIndex',0,
    'fill',jsonb_build_object('kind','solid','color','#000000')
  ))
),640,360,${actor});
INSERT INTO public.design_nodes(canvas_id,element_id,design_id,workspace_id,created_by)
VALUES(${canvas},${design}::text,${design},${workspace},${actor});
INSERT INTO public.design_document_versions(design_id,workspace_id,revision,snapshot,actor_kind,actor_user_id,idempotency_key)
SELECT id,workspace_id,revision,scene,'user',created_by,extensions.gen_random_uuid()
FROM public.design_documents WHERE id=${design};
SELECT public.loomic_agent_task_begin(
  ${actor},${session},${canvas},${run},'Delete the selected logo',
  jsonb_build_object('kind','design','designId',${design}::text),NULL
);
INSERT INTO public.tool_executions(id,run_id,tool_call_id,tool_name,status,requested_by)
VALUES(${toolExecution},${run},${toolExecution}::text,'manipulate_design','completed',${actor});

${createConfirmation(confirmation)}
SELECT pg_temp.qa_assert(
  (SELECT status='pending' AND workflow_step_id='delete-logo' AND tool_execution_id=${toolExecution}
    AND payload->>'design_id'=${design}::text
   FROM public.agent_action_confirmations WHERE confirmation_id=${confirmation}),
  'proposal persists the exact task, step and design mutation payload'
);
SELECT pg_temp.qa_error(
  $q$SELECT public.loomic_claim_agent_action_confirmation(
    'ac030000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000002'
  )$q$,
  'confirmation_forbidden'
);
CREATE TEMP TABLE qa_claim AS
SELECT public.loomic_claim_agent_action_confirmation(${confirmation},${actor},${canvas}) AS value;
SELECT pg_temp.qa_assert(
  (SELECT value->>'state'='claimed' AND value#>>'{action,payload,idempotency_key}'=${confirmation}::text FROM qa_claim),
  'the owner claims the frozen payload and idempotency identity'
);
SELECT pg_temp.qa_assert(
  public.loomic_claim_agent_action_confirmation(${confirmation},${actor},${canvas})->>'state'='executing',
  'a concurrent duplicate confirmation cannot claim the mutation twice'
);
SELECT pg_temp.qa_assert(
  NOT public.loomic_release_agent_action_confirmation(${confirmation},extensions.gen_random_uuid()),
  'an unrelated executor cannot release the claim'
);
SELECT pg_temp.qa_assert(
  public.loomic_release_agent_action_confirmation(
    ${confirmation},(SELECT (value#>>'{action,claimToken}')::uuid FROM qa_claim)
  ),
  'the exact claimant may release an uncommitted attempt for safe retry'
);
${createConfirmation(canceledConfirmation)}
SELECT pg_temp.qa_assert(
  (SELECT count(*)=1 FROM public.loomic_list_agent_action_confirmation_recovery(${actor},${session},10)),
  'a caught failure is recoverable while a never-confirmed pending proposal is excluded'
);
SELECT pg_temp.qa_assert(
  public.loomic_cancel_agent_action_confirmation(${canceledConfirmation},${actor},${canvas}),
  'explicit rejection cancels a never-confirmed pending confirmation'
);
SELECT pg_temp.qa_assert(
  public.loomic_claim_agent_action_confirmation(${canceledConfirmation},${actor},${canvas})->>'state'='canceled',
  'a rejected confirmation cannot execute or resume'
);
TRUNCATE qa_claim;
INSERT INTO qa_claim SELECT public.loomic_claim_agent_action_confirmation(${confirmation},${actor},${canvas});
CREATE TEMP TABLE qa_mutation AS
SELECT public.loomic_agent_design_mutate_v2(
  p_operation => 'manipulate_design',
  p_design_id => ${design},
  p_expected_revision => 0,
  p_idempotency_key => ${confirmation},
  p_commands => jsonb_build_array(jsonb_build_object(
    'action','object.remove','object_id',${objectId}::text,'expected_object_version',1
  )),
  p_next_scene => (SELECT jsonb_set(scene,'{objects}','[]'::jsonb) FROM public.design_documents WHERE id=${design}),
  p_actor_user_id => ${actor},
  p_agent_run_id => ${run},
  p_tool_execution_id => ${toolExecution},
  p_confirmation_id => ${confirmation},
  p_destructive_confirmed => true
) AS value;
SELECT pg_temp.qa_assert(
  (SELECT revision=1 AND scene->'objects'='[]'::jsonb FROM public.design_documents WHERE id=${design}),
  'the real destructive design RPC accepts the frozen completed tool ledger and removes only the confirmed object'
);
SELECT pg_temp.qa_assert(
  public.loomic_finish_agent_action_confirmation(
    ${confirmation},(SELECT (value#>>'{action,claimToken}')::uuid FROM qa_claim),
    (SELECT value FROM qa_mutation)
  ),
  'the exact claimant records a committed mutation result'
);
SELECT pg_temp.qa_assert(
  NOT public.loomic_finish_agent_action_confirmation(
    ${confirmation},(SELECT (value#>>'{action,claimToken}')::uuid FROM qa_claim),'{}'::jsonb
  ),
  'a replay cannot finish the committed mutation again'
);
SELECT pg_temp.qa_assert(
  public.loomic_claim_agent_action_confirmation(${confirmation},${actor},${canvas})
    @> jsonb_build_object('state','applied','action',jsonb_build_object(
      'result',jsonb_build_object('revision',1),'completionDone',false
    )),
  'a retry after callback failure observes the durable result instead of re-executing'
);
SELECT pg_temp.qa_assert(
  (SELECT count(*)=1 FROM public.loomic_list_agent_action_confirmation_recovery(${actor},${session},10)),
  'an applied result with an unacknowledged workflow callback is discoverable after restart'
);
SELECT pg_temp.qa_assert(public.loomic_complete_agent_action_confirmation(${confirmation}),
  'the workflow callback can be durably acknowledged');
SELECT pg_temp.qa_assert(
  (public.loomic_claim_agent_action_confirmation(${confirmation},${actor},${canvas})#>>'{action,completionDone}')::boolean,
  'completion acknowledgement survives process restart'
);

${createConfirmation(staleConfirmation)}
TRUNCATE qa_claim;
INSERT INTO qa_claim SELECT public.loomic_claim_agent_action_confirmation(${staleConfirmation},${actor},${canvas});
UPDATE public.agent_action_confirmations
SET claimed_at=now()-interval '4 minutes',expires_at=now()-interval '1 minute'
WHERE confirmation_id=${staleConfirmation};
SELECT pg_temp.qa_assert(
  (SELECT count(*)=1 FROM public.loomic_list_agent_action_confirmation_recovery(${actor},${session},10)),
  'a stale executing lease is discoverable even after the original UI expiry'
);
TRUNCATE qa_claim;
INSERT INTO qa_claim SELECT public.loomic_claim_agent_action_confirmation(${staleConfirmation},${actor},${canvas});
SELECT pg_temp.qa_assert((SELECT value->>'state'='claimed' FROM qa_claim),
  'an explicitly confirmed stale execution reclaims idempotently instead of expiring');
SELECT pg_temp.qa_assert(public.loomic_release_agent_action_confirmation(
  ${staleConfirmation},(SELECT (value#>>'{action,claimToken}')::uuid FROM qa_claim)
),'the reclaimed confirmed request may return to the autonomous retry queue');
SELECT public.loomic_agent_task_begin(
  ${actor},${session},${canvas},${correctionRun},'Do not delete it; only move it',NULL,${run}
);
SELECT pg_temp.qa_assert(
  public.loomic_claim_agent_action_confirmation(${staleConfirmation},${actor},${canvas})->>'state'='stale',
  'a correction fences the old confirmed command before execution'
);
SELECT pg_temp.qa_assert(
  (SELECT status='canceled' FROM public.agent_action_confirmations WHERE confirmation_id=${staleConfirmation}),
  'a stale confirmation stays terminal and cannot later revive'
);

SELECT pg_temp.qa_assert(
  NOT has_table_privilege('authenticated','public.agent_action_confirmations','SELECT')
  AND NOT has_function_privilege('authenticated','public.loomic_claim_agent_action_confirmation(uuid,uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.loomic_list_agent_action_confirmation_recovery(uuid,uuid,integer)','EXECUTE'),
  'browser clients cannot read or claim the server-owned confirmation ledger'
);
ROLLBACK;
SELECT 'PASS: durable destructive confirmation claim, retry, correction, cancellation and authorization; all QA data and DDL rolled back';
`;

console.log(query(sql).trim().split("\n").filter(Boolean).at(-1));
