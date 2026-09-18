import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const afterTurn = Number(process.argv.find(arg => arg.startsWith('--after='))?.slice(8) ?? 0);
assert(Number.isInteger(afterTurn) && afterTurn >= 0, 'Invalid review boundary');
assert(fixture.fixture?.sessionId && fixture.fixtureId, 'Dedicated QA fixture required');
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
try {
  const { rows } = await db.query('select role,content,session_sequence from chat_messages where session_id=$1 order by session_sequence', [fixture.fixture.sessionId]);
  const exchanges = [];
  for (const row of rows) {
    if (row.role === 'user') exchanges.push({ prompt: row.content, replies: [] });
    else if (row.role === 'assistant') exchanges.at(-1)?.replies.push(row.content);
  }
  const checks = [];
  for (const [index, exchange] of exchanges.entries()) {
    const text = exchange.replies.join('\n');
    if (exchange.prompt.startsWith('检查现在两种物料各自的比例')) {
      const required = ['澄屿', '山岚', '4:5', '3:2', '米白', '银灰', '无糖，也有回甘'];
      checks.push({ turn: index + 1, kind: 'long_term_fields', missing: required.filter(token => !text.includes(token)), text });
    }
    if (exchange.prompt.startsWith('海报现在的小标题是什么')) {
      const cycle = Math.floor((index + 1 - 28) / 8) + 1;
      const required = [`山间茶事${cycle}`, '无糖，也有回甘'];
      checks.push({ turn: index + 1, kind: 'latest_correction', missing: required.filter(token => !text.includes(token)), text });
    }
  }
  const jobs = await db.query('select status,count(*)::int count from background_jobs where session_id=$1 group by status', [fixture.fixture.sessionId]);
  const snapshots = await db.query("select public_plan->>'method' method,count(*)::int count,max((public_plan->>'omittedMessageCount')::int) omitted from agent_run_context_snapshots where session_id=$1 group by 1", [fixture.fixture.sessionId]);
  const report = { observedAt: new Date().toISOString(), afterTurn, turns: exchanges.length, checks, jobs: jobs.rows, snapshots: snapshots.rows };
  const output = process.argv[2].replace(/\.json$/, '.verification.json');
  assert(output !== process.argv[2], 'Fixture must have a .json extension');
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, turns: exchanges.length, probes: checks.length,
    failedProbes: checks.filter(check => check.missing.length), snapshots: snapshots.rows, jobs: jobs.rows }));
  assert(checks.length >= 20, 'Full extended sequence has not finished');
  const currentChecks = checks.filter(check => check.turn > afterTurn);
  assert(currentChecks.length >= 10, 'Not enough probes after the specified repair boundary');
  assert(currentChecks.every(check => check.missing.length === 0), 'A recall probe needs investigation');
  assert(jobs.rows.length === 0, 'Discussion unexpectedly submitted image jobs');
  assert(snapshots.rows.some(row => row.omitted > 0), 'No actual context compaction observed');
} finally { await db.end(); }
