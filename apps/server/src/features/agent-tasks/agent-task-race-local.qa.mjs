// Real two-connection PostgreSQL lock acceptance. No model/worker is invoked.
// Fresh fabricated fixtures are briefly committed, then removed by exact IDs.
// Run: node apps/server/src/features/agent-tasks/agent-task-race-local.qa.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const database = "loomic_replica_light_20260907";
const container = "supabase_db_thtdhcvjppuvlvahfmga";
const prefix = randomBytes(2).toString("hex");
const id = (group, ordinal = 1) => `${prefix}000${group}-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const actor = id(1), otherActor = id(1, 2), workspace = id(2), project = id(3), canvas = id(4), session = id(6);
const run1 = id(7), run2 = id(7, 2), run3 = id(7, 3), job1 = id(8), job2 = id(8, 2);
const sourceAsset = id(5), outputAsset = id(5, 3);
const claims = `SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start(sql, application) {
  const child = spawn("docker", ["exec", "-i", "-e", `PGAPPNAME=${application}`, container,
    "psql", "-U", "supabase_admin", "-d", database, "-v", "ON_ERROR_STOP=1", "-Atq"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(sql);
  return { done, output: () => stdout };
}
async function execute(sql, application = `qa-task-${prefix}`) {
  const result = await start(sql, application).done;
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}
async function marker(process, value) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.output().includes(value)) return;
    await sleep(25);
  }
  const result = await process.done;
  assert.fail(`Missing lock marker ${value}: ${result.stderr}`);
}
async function assertWaiting(application) {
  const blocked = await execute(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(application)} AND wait_event_type='Lock';`);
  assert.equal(blocked.trim(), "1", "The contender must actually wait on a PostgreSQL lock");
}
const correction = (nextRun, priorRun) => `SELECT public.loomic_agent_task_begin(${literal(actor)},${literal(session)},${literal(canvas)},${literal(nextRun)},'QA correction',NULL,${literal(priorRun)});`;
const attach = (job, elementId) => `UPDATE public.canvases SET content=jsonb_set(content,'{elements}',content->'elements'||${literal(JSON.stringify([
  { id: elementId, type: "image", fileId: `${elementId}-file`, customData: { sourceJobId: job, assetId: outputAsset } },
]))}::jsonb) WHERE id=${literal(canvas)};`;

const guard = await execute("SELECT current_database();");
assert.equal(guard.trim(), database);
const source = await readFile(new URL("./agent-task-local-db.qa.sql", import.meta.url), "utf8");
const setupEnd = source.indexOf("SELECT public.loomic_agent_task_update_brief");
assert.ok(setupEnd > 0, "QA fixture boundary must exist");
const setup = source.slice(0, setupEnd)
  .replace(/aa0([1-8])0000/g, (_, group) => `${prefix}000${group}`)
  .replaceAll("task-qa-a@local.test", `task-race-${prefix}-a@local.test`)
  .replaceAll("task-qa-b@local.test", `task-race-${prefix}-b@local.test`);
const actors = `${literal(actor)},${literal(otherActor)}`;
assert.equal((await execute(`SELECT count(*) FROM auth.users WHERE id IN (${actors});`)).trim(), "0");
let initialized = false;
try {
  await execute(`${setup}\nCOMMIT;`);
  initialized = true;

  // Correction owns the task lock first. The stale result waits, rechecks the
  // committed revision, and fails without inserting even one canvas element.
  const correctionFirst = start(`BEGIN; SET LOCAL statement_timeout='8s'; ${claims}
    ${correction(run2, run1)} SELECT 'CORRECTION_LOCKED'; SELECT pg_sleep(2); COMMIT;`, `qa-correct-${prefix}`);
  await marker(correctionFirst, "CORRECTION_LOCKED");
  const lateName = `qa-late-${prefix}`;
  const late = start(`SET statement_timeout='8s'; ${attach(job1, "late-result")}`, lateName);
  await sleep(150);
  await assertWaiting(lateName);
  assert.equal((await correctionFirst.done).code, 0);
  const lateResult = await late.done;
  assert.notEqual(lateResult.code, 0);
  assert.match(lateResult.stderr, /agent_task_superseded/);
  assert.equal((await execute(`SELECT jsonb_array_length(content->'elements') FROM public.canvases WHERE id=${literal(canvas)};`)).trim(), "1");

  const payload = { origin_run_id: run2, source_element_id: "source-a", source_asset_id: sourceAsset,
    placeholder_element_id: "ordered-result", target: { kind: "canvas", canvas_id: canvas, element_id: "ordered-result" } };
  await execute(`INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by)
    VALUES(${literal(job2)},${literal(workspace)},${literal(project)},${literal(canvas)},'canvas',${literal(session)},'qa-never-enqueued','image_generation','succeeded',${literal(JSON.stringify(payload))}::jsonb,${literal(actor)});`);

  // An already committing result owns the lock first. The correction waits and
  // becomes current after the completed attachment; the original stays intact.
  const writerFirst = start(`BEGIN; SET LOCAL statement_timeout='8s'; ${attach(job2, "ordered-result")}
    SELECT 'WRITER_LOCKED'; SELECT pg_sleep(2); COMMIT;`, `qa-writer-${prefix}`);
  await marker(writerFirst, "WRITER_LOCKED");
  const followName = `qa-follow-${prefix}`;
  const follow = start(`BEGIN; SET LOCAL statement_timeout='8s'; ${claims} ${correction(run3, run2)} COMMIT;`, followName);
  await sleep(150);
  await assertWaiting(followName);
  assert.equal((await writerFirst.done).code, 0);
  const following = await follow.done;
  assert.equal(following.code, 0, following.stderr);
  const result = await execute(`SELECT jsonb_build_object('run',t.current_run_id,'revision',t.revision,'elements',c.content->'elements')
    FROM public.agent_design_tasks t JOIN public.canvases c ON c.id=t.canvas_id WHERE t.session_id=${literal(session)};`);
  const final = JSON.parse(result.trim());
  assert.equal(final.run, run3);
  assert.equal(final.revision, 3);
  assert.deepEqual(final.elements.map((element) => element.id), ["source-a", "ordered-result"]);
  console.log("PASS: correction-first rejects late output after real lock wait; writer-first commits before waiting correction; original preserved.");
} finally {
  if (initialized) {
    // All targets are fabricated IDs selected before setup; no broad cleanup.
    await execute(`BEGIN;
      DELETE FROM public.background_jobs WHERE created_by IN (${actors});
      DELETE FROM public.agent_design_tasks WHERE created_by IN (${actors});
      DELETE FROM public.agent_runs WHERE created_by IN (${actors});
      DELETE FROM public.chat_sessions WHERE created_by IN (${actors});
      DELETE FROM public.canvases WHERE created_by IN (${actors});
      DELETE FROM public.projects WHERE created_by IN (${actors});
      DELETE FROM public.workspace_members WHERE user_id IN (${actors});
      DELETE FROM public.workspaces WHERE owner_user_id IN (${actors});
      DELETE FROM auth.users WHERE id IN (${actors}); COMMIT;`);
    console.log("Removed only this run's fabricated QA rows; no user documents or provider jobs were changed.");
  }
}
