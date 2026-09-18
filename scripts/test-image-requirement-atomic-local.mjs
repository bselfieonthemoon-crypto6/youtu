// Isolated PostgreSQL integration QA. Never writes fixtures to the user's DB.
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const source = 'loomic_replica_light_20260907';
const database = 'loomic_image_confirmation_qa_20260910';
const docker = args => execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32*1024*1024 });
const query = (sql, db = database) => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', db, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 32*1024*1024 });
const connection = sql => new Promise((resolve, reject) => {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'], { windowsHide: true });
  let out='', err=''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  child.stdin.end(sql);
});
const actor = 'aa010000-0000-4000-8000-000000000001';
const sess = 'aa060000-0000-4000-8000-000000000001';
const canvas = 'aa040000-0000-4000-8000-000000000001';
const run = n => `aa070000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const msg = n => `aa090000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const auth = `SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"${actor}"}',false);`;
const message = (n, text) => `INSERT INTO public.chat_messages(id,session_id,role,content) VALUES('${msg(n)}','${sess}','user','${text}');`;
const bind = (n, m, text) => `UPDATE public.agent_runs SET request_message_id='${msg(m)}',request_prompt='${text}' WHERE id='${run(n)}';`;
const propose = n => `${auth} SELECT public.loomic_propose_image('${sess}','${canvas}','${run(n)}','{"prompt":"QA image"}','{}')->>'id';`;
const decide = (id, n) => `${auth} SELECT coalesce(public.loomic_decide_current_image('${id}','${sess}','${canvas}','${run(n)}','confirm')->>'status','rejected');`;
const waitForDatabase = async (condition, label) => {
  const deadline = Date.now()+5000;
  while (Date.now()<deadline) {
    if (query(condition).trim() === '1') return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error(`Did not observe database synchronization: ${label}`);
};
let created = false;
try {
  assert.equal(query('SELECT current_database()', source).trim(), source);
  assert.equal(query(`SELECT count(*) FROM pg_database WHERE datname='${database}'`, source).trim(), '0', 'QA DB already exists; refusing to overwrite');
  query(`CREATE DATABASE ${database}`, source); created = true;
  const schema = docker(['pg_dump', '-U', 'supabase_admin', '-d', source, '--schema-only', '--no-owner']);
  query(schema);
  if (query("SELECT count(*) FROM pg_proc WHERE proname='loomic_decide_current_image'").trim() === '0')
    query(await readFile(new URL('../supabase/migrations/20260910000011_image_requirement_confirmation.sql', import.meta.url), 'utf8'));
  if (query("SELECT count(*) FROM pg_proc WHERE proname='loomic_create_run_with_request'").trim() === '0')
    query(await readFile(new URL('../supabase/migrations/20260910000012_agent_run_request_message.sql', import.meta.url), 'utf8'));
  const base = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url),'utf8');
  const fixture = base.slice(base.indexOf('INSERT INTO auth.users'),base.indexOf('SELECT public.loomic_agent_task_begin'));
  query(`BEGIN; ${fixture} COMMIT;`);
  const legacy = `SELECT public.loomic_create_run_with_request('${run(9)}','${sess}','${actor}','qa-thread',NULL,'thinking','Legacy API request');`;
  query(legacy); query(legacy);
  assert.equal(query(`SELECT count(*) FROM public.chat_messages WHERE session_id='${sess}' AND content='Legacy API request'`).trim(),'1','same run metadata retry is idempotent');
  assert.equal(query(`SELECT request_message_id IS NOT NULL FROM public.agent_runs WHERE id='${run(9)}'`).trim(),'t','legacy API gets exact durable identity');
  assert.equal(query("SELECT has_function_privilege('authenticated','public.loomic_create_run_with_request(uuid,uuid,uuid,text,text,text,text)','EXECUTE')").trim(),'f','browser cannot mint run identity');
  query(message(1,'Logo requirement') + bind(1,1,'Logo requirement'));
  query(`DO $$ BEGIN
    BEGIN UPDATE public.chat_messages SET content='silently changed' WHERE id='${msg(1)}';
      RAISE EXCEPTION 'QA expected immutable message';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'user_message_content_immutable' THEN RAISE; END IF; END;
  END $$;`);
  const proposal = query(propose(1)).trim().split('\n').at(-1);
  assert.match(proposal, /^[a-f0-9-]{36}$/);
  query(message(2,'确认生成') + bind(2,2,'确认生成'));
  assert.equal(query(decide(proposal,2)).trim().split('\n').at(-1),'confirmed');
  assert.equal(query(decide(proposal,2)).trim().split('\n').at(-1),'confirmed', 'repeated confirmation is idempotent');

  // A correction committed before an older confirmation gets its lock wins.
  query(message(3,'Landing page requirement') + bind(1,3,'Landing page requirement'));
  const pending = query(propose(1)).trim().split('\n').at(-1);
  query(message(4,'确认生成') + bind(2,4,'确认生成'));
  const insertion = connection(`BEGIN; SET application_name='loomic-qa-message-first'; ${message(5,'Use green instead')} SELECT pg_sleep(4); COMMIT;`);
  // Detect the lock holder rather than relying solely on scheduling sleeps.
  await waitForDatabase("SELECT count(*) FROM pg_stat_activity WHERE application_name='loomic-qa-message-first' AND wait_event='PgSleep'",'message lock held');
  const waitingConfirmation = connection(`SET application_name='loomic-qa-wait-confirm'; ${decide(pending,2)}`);
  await waitForDatabase("SELECT count(*) FROM pg_stat_activity WHERE application_name='loomic-qa-wait-confirm' AND wait_event_type='Lock'",'confirmation blocked by message insert');
  const result = await waitingConfirmation; await insertion;
  assert.equal(result.split('\n').at(-1),'rejected','newer committed correction must fence an older confirmation');
  assert.equal(query(`SELECT status FROM public.image_generation_proposals WHERE id='${pending}'`).trim(),'pending');

  // Confirmation first commits; the later correction is a separate requirement.
  query(bind(1,5,'Use green instead'));
  const current = query(propose(1)).trim().split('\n').at(-1);
  query(message(6,'确认生成') + bind(2,6,'确认生成'));
  const confirmation = connection(`BEGIN; SET application_name='loomic-qa-confirm-first'; ${decide(current,2)} SELECT pg_sleep(4); COMMIT;`);
  await waitForDatabase("SELECT count(*) FROM pg_stat_activity WHERE application_name='loomic-qa-confirm-first' AND wait_event='PgSleep'",'confirmation lock held');
  const waitingMessage = connection(`SET application_name='loomic-qa-wait-message'; ${message(7,'Now use blue')}`);
  await waitForDatabase("SELECT count(*) FROM pg_stat_activity WHERE application_name='loomic-qa-wait-message' AND wait_event_type='Lock'",'insert blocked by confirmation');
  await waitingMessage; await confirmation;
  assert.equal(query(`SELECT status FROM public.image_generation_proposals WHERE id='${current}'`).trim(),'confirmed');
  assert.equal(query(`SELECT count(*)=count(DISTINCT session_sequence) FROM public.chat_messages WHERE session_id='${sess}'`).trim(),'t');
  query(message(8,'确认生成') + bind(3,8,'确认生成'));
  const sameTurn = query(propose(3)).trim().split('\n').at(-1);
  assert.equal(query(decide(sameTurn,3)).trim().split('\n').at(-1),'confirmed','real explicitly approving message can continue without a fake run');
  query(message(9,'取消生成') + bind(2,9,'取消生成'));
  assert.equal(query(decide(sameTurn,2)).trim().split('\n').at(-1),'rejected','cancel text cannot be used as approval by a tool');
  // Deleting a test session must not be broken by the exact-message FK.
  query(`DELETE FROM public.chat_sessions WHERE id='${sess}';`);
  console.log('PASS atomic image requirements: exact binding, duplicate confirmation, both two-connection race orderings, session deletion. No provider calls.');
} finally {
  if (created) {
    // Explicit, owned, disposable database only; source database is never dropped.
    assert.equal(database, 'loomic_image_confirmation_qa_20260910');
    query(`DROP DATABASE ${database} WITH (FORCE)`, source);
  }
}
