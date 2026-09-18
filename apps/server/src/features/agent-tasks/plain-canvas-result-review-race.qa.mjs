// Run only after stopping the local API and worker. No provider or queue RPCs.
// Uses two real PostgreSQL connections and a third observer; all fixture IDs
// are random and cleanup deletes only those explicitly recorded IDs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

if (process.env.LOOMIC_QA_SERVICES_STOPPED !== "1") throw new Error("Set LOOMIC_QA_SERVICES_STOPPED=1 after stopping local API and worker.");
const database = "loomic_replica_light_20260907";
const sample = "dedfe2c8-1267-4201-815b-ad25936c701c";
const owner = `(SELECT created_by FROM public.background_jobs WHERE id='${sample}')`;
const cases = ["register-first", "delivery-first"].map(name => ({ name, canvas: randomUUID(), session: randomUUID(),
  prepare: randomUUID(), run: randomUUID(), job: randomUUID() }));
const sessions = [];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

function connection(label) {
  const child = spawn("docker", ["exec", "-i", "supabase_db_thtdhcvjppuvlvahfmga", "psql", "-X", "-qAt",
    "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", database], { stdio: ["pipe", "pipe", "pipe"] });
  let pending; let output = ""; let errors = ""; let closed = false;
  child.stdout.on("data", data => {
    output += data.toString();
    if (pending && output.includes(pending.marker)) {
      const current = pending; pending = undefined;
      const [value, rest] = output.split(current.marker); output = rest ?? "";
      clearTimeout(current.timer); current.resolve(value.trim());
    }
  });
  child.stderr.on("data", data => { errors = (errors + data.toString()).slice(-5000); });
  const reject = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; } };
  child.on("error", reject);
  child.on("exit", code => { closed = true; reject(new Error(`psql ${label} exited ${code}: ${errors}`)); });
  const client = { label,
    query(sql) {
      if (closed || pending) return Promise.reject(new Error(`Unavailable connection ${label}`));
      return new Promise((resolve, rejectQuery) => {
        const marker = `QA_DONE_${randomUUID()}`;
        pending = { marker, resolve, reject: rejectQuery, timer: setTimeout(() => {
          reject(new Error(`Query timeout ${label}: ${errors}`)); child.kill();
        }, 20000) };
        child.stdin.write(`${sql}\nSELECT ${literal(marker)};\n`);
      });
    },
    async close() {
      if (closed) return;
      child.stdin.end("ROLLBACK;\n\\q\n");
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    },
  };
  sessions.push(client);
  return client;
}
async function initialize(client) {
  await client.query(`SET application_name=${literal(client.label)}; SET statement_timeout='15s'; SET lock_timeout='10s';
    SELECT set_config('request.jwt.claims','{"role":"service_role"}',false);`);
}
function setup(f) {
  return `
  INSERT INTO public.canvases(id,project_id,name,is_primary,created_by,content)
    SELECT '${f.canvas}',project_id,'plain-canvas-concurrency-QA-${f.name}',false,created_by,
      jsonb_build_object('elements',jsonb_build_array(jsonb_build_object('id','${f.job}','type','image',
        'customData',jsonb_build_object('assetId',result->>'asset_id'))),'files','{}'::jsonb,'appState','{}'::jsonb)
    FROM public.background_jobs WHERE id='${sample}';
  INSERT INTO public.chat_sessions(id,canvas_id,title,created_by,thread_id)
    VALUES('${f.session}','${f.canvas}','plain-canvas-concurrency-QA',${owner},'${f.session}');
  INSERT INTO public.agent_autonomy_preferences(session_id,created_by,enabled) VALUES('${f.session}',${owner},true);
  SELECT public.loomic_create_run_with_request('${f.prepare}','${f.session}',${owner},'${f.session}',
    'fixture-no-provider','thinking','Only one image. Automatically review the result; do not generate another image.');
  UPDATE public.agent_runs SET status='completed' WHERE id='${f.prepare}';
  INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,requirement_message_id,input,details,status,approved_cost)
    SELECT '${f.job}','${f.session}','${f.canvas}',${owner},id,request_message_id,'{}','{}','confirmed',0
    FROM public.agent_runs WHERE id='${f.prepare}';
  SELECT public.loomic_create_run_with_request('${f.run}','${f.session}',${owner},'${f.session}','fixture-no-provider','thinking','确认生成');
  INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by)
    SELECT '${f.job}',workspace_id,project_id,'${f.canvas}','canvas','${f.session}','image_generation_jobs','image_generation','queued',
      jsonb_build_object('aspect_ratio','1:1','target',jsonb_build_object('kind','canvas','canvas_id','${f.canvas}','element_id','${f.job}')),created_by
    FROM public.background_jobs WHERE id='${sample}';`;
}
const register = f => `SELECT public.loomic_register_canvas_result_review(${owner},'${f.session}','${f.run}','${f.job}');`;
const deliver = f => `UPDATE public.background_jobs SET status='succeeded',result=jsonb_build_object(
  'asset_id',(SELECT result->>'asset_id' FROM public.background_jobs WHERE id='${sample}'),
  'canvas_element_id','${f.job}','canvas_finalized_at',now()::text) WHERE id='${f.job}';`;
function cleanup() {
  return cases.map(f => `
    DELETE FROM public.background_jobs WHERE id='${f.job}' AND session_id='${f.session}';
    DELETE FROM public.image_generation_proposals WHERE id='${f.job}' AND session_id='${f.session}';
    DELETE FROM public.agent_design_tasks WHERE session_id='${f.session}';
    DELETE FROM public.agent_runs WHERE id IN ('${f.prepare}','${f.run}') AND session_id='${f.session}';
    DELETE FROM public.chat_sessions WHERE id='${f.session}' AND canvas_id='${f.canvas}';
    DELETE FROM public.canvases WHERE id='${f.canvas}' AND name='plain-canvas-concurrency-QA-${f.name}';`).join("\n");
}

const observer = connection(`plain-review-observer-${randomUUID()}`);
let sampleHash; let failure;
try {
  await initialize(observer);
  const check = await observer.query(`SELECT current_database()='${database}' AND to_regprocedure('public.loomic_register_canvas_result_review(uuid,uuid,uuid,uuid)') IS NOT NULL;`);
  if (check !== "t") throw new Error("Expected local database and installed migration 000002");
  sampleHash = await observer.query(`SELECT md5(to_jsonb(j)::text) FROM public.background_jobs j WHERE id='${sample}';`);
  if (!sampleHash) throw new Error("Previously-paid sample job missing");
  console.log(JSON.stringify({ fixtureIds: cases }));
  await observer.query(`BEGIN; ${cases.map(setup).join("\n")} COMMIT;`);
  for (const f of cases) {
    const first = connection(`plain-review-first-${f.job}`); const second = connection(`plain-review-second-${f.job}`);
    await initialize(first); await initialize(second);
    await first.query(`BEGIN; ${f.name === "register-first" ? register(f) : deliver(f)}`);
    const blocked = second.query(f.name === "register-first" ? deliver(f) : register(f));
    // Attach rejection immediately, then verify an actual lock wait before
    // releasing the first transaction. No timing-only race assertions.
    const outcome = blocked.then(value => ({ value }), error => ({ error }));
    let observedLock = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const waiting = await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${literal(second.label)} AND wait_event_type='Lock');`);
      if (waiting === "t") { observedLock = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!observedLock) throw new Error(`Did not observe the expected real lock wait: ${f.name}`);
    await first.query("COMMIT;");
    const result = await outcome;
    if (result.error) throw result.error;
    const accepted = await observer.query(`SELECT
      (SELECT count(*) FROM public.agent_canvas_result_reviews WHERE job_id='${f.job}' AND state='bound')=1
      AND (SELECT count(*) FROM public.agent_design_task_jobs WHERE job_id='${f.job}' AND run_id='${f.run}')=1
      AND (SELECT count(*) FROM public.agent_task_continuations WHERE job_id='${f.job}' AND status='pending')=1
      AND (SELECT count(*) FROM public.agent_design_tasks WHERE session_id='${f.session}' AND current_run_id='${f.run}'
        AND brief#>>'{canvasResultReview,mode}'='read_only')=1
      AND (SELECT count(*) FROM public.background_jobs WHERE session_id='${f.session}')=1
      AND (SELECT image_enqueued_at IS NULL AND credits_transaction_id IS NULL FROM public.background_jobs WHERE id='${f.job}');`);
    if (accepted !== "t") throw new Error(`Missing/duplicate enrollment or unexpected billing: ${f.name}`);
    await first.close(); await second.close();
    console.log(`PASS ${f.name}: observed PostgreSQL lock wait, exactly one binding and continuation, no enqueue or billing`);
  }
} catch (error) { failure = error; }
finally {
  // Release every possible transaction before cleanup, including failures.
  await Promise.all(sessions.map(item => item.close()));
  const cleaner = connection(`plain-review-cleanup-${randomUUID()}`);
  try {
    await initialize(cleaner);
    // Always attempt cleanup, even if the setup COMMIT's response was lost.
    // Every predicate uses a locally generated UUID, never a sample ID.
    await cleaner.query(`BEGIN; ${cleanup()} COMMIT;`);
    const remaining = await cleaner.query(`SELECT count(*) FROM public.canvases WHERE id IN (${cases.map(f => literal(f.canvas)).join(",")});`);
    if (remaining !== "0") throw new Error("Fixture cleanup incomplete");
    if (sampleHash && await cleaner.query(`SELECT md5(to_jsonb(j)::text) FROM public.background_jobs j WHERE id='${sample}';`) !== sampleHash)
      throw new Error("Read-only sample job changed");
  } catch (error) { failure = new AggregateError([failure, error].filter(Boolean), "QA/cleanup failed; inspect printed fixture IDs"); }
  await cleaner.close();
}
if (failure) throw failure;
console.log("PASS cleanup: only generated fixture IDs removed; paid sample job, asset and owner retained");
