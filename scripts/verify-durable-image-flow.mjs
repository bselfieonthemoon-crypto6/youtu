// Verifies the real database implementation inside a rolled-back transaction.
// No image provider is called; queue messages and credit changes never commit.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const require = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const { Client } = require("pg");
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
const migration = new URL(
  "../supabase/migrations/20260908000004_durable_image_flow.sql",
  import.meta.url,
);
const revisionMigration = new URL(
  "../supabase/migrations/20260908000005_image_proposal_revision_guard.sql",
  import.meta.url,
);
const guardMigration = new URL('../supabase/migrations/20260908000006_frozen_image_job_guard.sql', import.meta.url);
await db.connect();
const checks = [];
const check = (value, label) => {
  if (!value) throw new Error(label);
  checks.push(label);
};
try {
  await db.query("BEGIN");
  const exists = (
    await db.query(
      "select to_regclass('public.image_generation_proposals') as name",
    )
  ).rows[0].name;
  if (!exists) await db.query(await readFile(migration, "utf8"));
  const revisionExists = (
    await db.query(
      "select to_regprocedure('public.loomic_invalidate_image_proposals(uuid,uuid)') as name",
    )
  ).rows[0].name;
  if (!revisionExists)
    await db.query(await readFile(revisionMigration, "utf8"));
  const guardExists = (await db.query("select to_regprocedure('public.loomic_guard_frozen_image_job()') as name")).rows[0].name;
  if (!guardExists) await db.query(await readFile(guardMigration, 'utf8'));
  const fixture = (
    await db.query(`select s.id as session_id,s.created_by as user_id,s.canvas_id,c.workspace_id,c.project_id
    from public.chat_sessions s join public.canvases c on c.id=s.canvas_id
    join public.credit_balances b on b.workspace_id=c.workspace_id where s.created_by is not null and b.balance>2
    order by s.created_at desc limit 1`)
  ).rows[0];
  if (!fixture)
    throw new Error("An authorized session with credits is required");
  const auth = async () => {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      fixture.user_id,
    ]);
    await db.query("SET LOCAL ROLE authenticated");
  };
  const admin = () => db.query("RESET ROLE");
  await auth();
  const propose = async (prompt) =>
    (
      await db.query(
        "select public.loomic_propose_image($1,$2,$3,$4,$5) as p",
        [
          fixture.session_id,
          fixture.canvas_id,
          randomUUID(),
          JSON.stringify({
            title: "transactional test",
            prompt,
            model: "test-provider",
            aspectRatio: "1:1",
          }),
          "{}",
        ],
      )
    ).rows[0].p;
  const first = await propose("blue");
  const second = await propose("red");
  check(
    (
      await db.query(
        "select status from public.image_generation_proposals where id=$1",
        [first.id],
      )
    ).rows[0].status === "superseded",
    "new version supersedes previous pending proposal",
  );
  const reject = async (fn, label) => {
    await db.query("SAVEPOINT expected_failure");
    let failed = false;
    try {
      await fn();
    } catch {
      failed = true;
    }
    await db.query("ROLLBACK TO SAVEPOINT expected_failure");
    check(failed, label);
  };
  const decide = (id, session = fixture.session_id, run = randomUUID()) =>
    db.query("select public.loomic_decide_image($1,$2,$3,$4,'confirm') as p", [
      id,
      session,
      fixture.canvas_id,
      run,
    ]);
  await reject(() => decide(first.id), "superseded proposal cannot execute");
  await reject(
    () => decide(second.id, randomUUID()),
    "cross-session confirmation rejected",
  );
  await reject(
    () => decide(second.id, fixture.session_id, second.origin_run_id),
    "same-turn confirmation rejected",
  );
  await reject(
    () =>
      db.query("select public.loomic_prepare_image_submission($1,$2,$3,0)", [
        second.id,
        fixture.user_id,
        fixture.session_id,
      ]),
    "browser cannot set billing cost",
  );
  await decide(second.id);
  await decide(second.id);
  check(
    (
      await db.query(
        "select status from public.image_generation_proposals where id=$1",
        [second.id],
      )
    ).rows[0].status === "confirmed",
    "repeat confirmation reuses durable proposal",
  );
  await admin();
  await db.query("select public.loomic_prepare_image_submission($1,$2,$3,1)", [
    second.id,
    fixture.user_id,
    fixture.session_id,
  ]);
  await db.query(
    `insert into public.background_jobs(id,workspace_id,project_id,canvas_id,session_id,created_by,queue_name,job_type,payload,target_kind)
    values($1,$2,$3,$4,$5,$6,'image_generation_jobs','image_generation',$7,'canvas')`,
    [
      second.id,
      fixture.workspace_id,
      fixture.project_id,
      fixture.canvas_id,
      fixture.session_id,
      fixture.user_id,
      JSON.stringify({
        prompt: "red",
        model: "test-provider",
        aspect_ratio: "1:1",
        target: { kind: "canvas", canvas_id: fixture.canvas_id },
      }),
    ],
  );
  const before = (
    await db.query(
      "select balance from credit_balances where workspace_id=$1",
      [fixture.workspace_id],
    )
  ).rows[0].balance;
  await reject(()=>db.query("update background_jobs set payload=jsonb_set(payload,'{model}','\"unapproved-model\"') where id=$1",[second.id]),'a confirmed task payload cannot be rewritten');
  await db.query("SAVEPOINT queue_fault");
  await db.query(
    "update background_jobs set queue_name='image_flow_missing_queue' where id=$1",
    [second.id],
  );
  await reject(
    () => db.query("select public.loomic_commit_image_job($1)", [second.id]),
    "enqueue failure rejects the entire charge transaction",
  );
  check(
    (
      await db.query(
        "select balance from credit_balances where workspace_id=$1",
        [fixture.workspace_id],
      )
    ).rows[0].balance === before,
    "enqueue failure leaves the credit balance unchanged",
  );
  await db.query("ROLLBACK TO SAVEPOINT queue_fault");
  await db.query("select public.loomic_commit_image_job($1)", [second.id]);
  await db.query("select public.loomic_commit_image_job($1)", [second.id]);
  const after = (
    await db.query(
      "select balance from credit_balances where workspace_id=$1",
      [fixture.workspace_id],
    )
  ).rows[0].balance;
  check(before - after === 1, "duplicate submission charges exactly once");
  check(
    Number(
      (
        await db.query(
          "select count(*) from pgmq.q_image_generation_jobs where message->>'job_id'=$1",
          [second.id],
        )
      ).rows[0].count,
    ) === 1,
    "duplicate submission queues exactly once",
  );
  check(
    (
      await db.query(
        "select image_enqueued_at from background_jobs where id=$1",
        [second.id],
      )
    ).rows[0].image_enqueued_at !== null,
    "enqueue acknowledgement is durable",
  );
  await auth();
  const recoverable = await propose("recover-after-crash");
  await decide(recoverable.id);
  await admin();
  await db.query("select public.loomic_prepare_image_submission($1,$2,$3,1)", [
    recoverable.id,
    fixture.user_id,
    fixture.session_id,
  ]);
  await db.query(
    `insert into background_jobs(id,workspace_id,project_id,canvas_id,session_id,created_by,queue_name,job_type,payload,target_kind,created_at)
    values($1,$2,$3,$4,$5,$6,'image_generation_jobs','image_generation',$7,'canvas',now()-interval '2 minutes')`,
    [
      recoverable.id,
      fixture.workspace_id,
      fixture.project_id,
      fixture.canvas_id,
      fixture.session_id,
      fixture.user_id,
      JSON.stringify({
        prompt: "recover-after-crash",
        model: "test-provider",
        aspect_ratio: "1:1",
        target: { kind: "canvas", canvas_id: fixture.canvas_id },
      }),
    ],
  );
  await db.query("select public.loomic_recover_image_submissions()");
  await db.query("select public.loomic_recover_image_submissions()");
  check(
    Number(
      (
        await db.query(
          "select count(*) from pgmq.q_image_generation_jobs where message->>'job_id'=$1",
          [recoverable.id],
        )
      ).rows[0].count,
    ) === 1,
    "worker recovery publishes a crash-interrupted submission exactly once",
  );
  check(
    Number(
      (
        await db.query(
          "select count(*) from credit_transactions where job_id=$1 and transaction_type='generation_deduct'",
          [recoverable.id],
        )
      ).rows[0].count,
    ) === 1,
    "worker recovery charges the recovered submission exactly once",
  );
  await auth();
  const canceled = await propose("cancel-me");
  await db.query("select public.loomic_decide_image($1,$2,$3,$4,'cancel')", [
    canceled.id,
    fixture.session_id,
    fixture.canvas_id,
    randomUUID(),
  ]);
  await reject(() => decide(canceled.id), "canceled proposal cannot execute");
  const expired = await propose("expire-me");
  await admin();
  await db.query(
    "update image_generation_proposals set expires_at=now()-interval '1 minute' where id=$1",
    [expired.id],
  );
  await auth();
  await reject(() => decide(expired.id), "expired proposal cannot execute");
  const revised = await propose("old pending design");
  await db.query("select public.loomic_invalidate_image_proposals($1,$2)", [
    fixture.session_id,
    fixture.canvas_id,
  ]);
  await reject(
    () => decide(revised.id),
    "revision invalidates approval before a replacement proposal exists",
  );
  await admin();
  // Probe canonical payloads produced by the live runtime against the new
  // insert guard, not only the simplified fixture used by billing tests.
  const live = (await db.query(`select j.*,p.input as proposal_input,p.details,p.origin_run_id,p.approved_cost
    from background_jobs j join image_generation_proposals p on p.id=j.id where j.status='succeeded'
    order by j.created_at desc limit 2`)).rows;
  for (const row of live) {
    const cloneId=randomUUID();const input=structuredClone(row.proposal_input);const payload=structuredClone(row.payload);
    if(input.target){input.target.idempotency_key=cloneId;payload.target.idempotency_key=cloneId;}
    await db.query(`insert into image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost)
      select $1,session_id,canvas_id,created_by,origin_run_id,$2,details,'confirmed',approved_cost from image_generation_proposals where id=$3`,[cloneId,JSON.stringify(input),row.id]);
    await db.query(`insert into background_jobs(id,workspace_id,project_id,canvas_id,session_id,created_by,queue_name,job_type,payload,target_kind,design_id)
      values($1,$2,$3,$4,$5,$6,'image_generation_jobs','image_generation',$7,$8,$9)`,
      [cloneId,row.workspace_id,row.project_id,row.canvas_id,row.session_id,row.created_by,JSON.stringify(payload),row.target_kind,row.design_id]);
    check(true,`canonical live ${row.target_kind} payload passes frozen guard`);
  }
  await db.query("ROLLBACK");
  console.log(
    JSON.stringify({ passed: checks.length, checks, rolledBack: true }),
  );
  if (process.argv.includes("--apply")) {
    await db.query("BEGIN");
    for (const [installed, url, version, name] of [
      [exists, migration, "20260908000004", "durable_image_flow"],
      [guardExists, guardMigration, "20260908000006", "frozen_image_job_guard"],
      [
        revisionExists,
        revisionMigration,
        "20260908000005",
        "image_proposal_revision_guard",
      ],
    ])
      if (!installed) {
        const sql = await readFile(url, "utf8");
        await db.query(sql);
        await db.query(
          "insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
          [version, name, [sql]],
        );
      }
    await db.query("COMMIT");
    console.log("Durable image migration applied.");
  }
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
}
