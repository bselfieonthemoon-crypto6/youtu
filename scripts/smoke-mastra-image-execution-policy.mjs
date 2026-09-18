import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mastraImageExecutionPolicy } from "../apps/server/src/agent/mastra-image-execution-policy.ts";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { Client } = require("pg");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(dbUrl).hostname))
  throw new Error("This isolated SQL smoke requires a local SUPABASE_DB_URL.");
const schema = `image_policy_smoke_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: dbUrl });
await admin.connect();
const peers = [];
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`
    CREATE TABLE ${schema}.agent_runs(id uuid PRIMARY KEY,created_by uuid,session_id uuid,status text,request_message_id uuid);
    CREATE TABLE ${schema}.chat_messages(id uuid PRIMARY KEY,session_id uuid,role text,content text);
    CREATE TABLE ${schema}.chat_sessions(id uuid PRIMARY KEY,canvas_id uuid);
    CREATE TABLE ${schema}.canvases(id uuid PRIMARY KEY,workspace_id uuid);
    CREATE TABLE ${schema}.workspace_members(workspace_id uuid,user_id uuid);
    CREATE TABLE ${schema}.background_jobs(id uuid PRIMARY KEY,created_by uuid,session_id uuid,canvas_id uuid,workspace_id uuid,job_type text,payload jsonb,status text);
    CREATE UNIQUE INDEX image_policy_replay ON ${schema}.background_jobs(created_by,session_id,(payload->>'mastra_submission_key'));
  `);
  const migration = await readFile(new URL("../supabase/migrations/20260915000005_mastra_image_execution_policy.sql", import.meta.url), "utf8");
  await admin.query(migration.replaceAll("public.", `${schema}.`).replace(/NOTIFY pgrst[^;]*;/g, ""));
  const upgrade = await readFile(new URL("../supabase/migrations/20260915000006_mastra_legacy_removal_execution_policy.sql", import.meta.url), "utf8");
  await admin.query(upgrade.replaceAll("public.", `${schema}.`).replace(/NOTIFY pgrst[^;]*;/g, ""));
  const vectors = [
    "制作海报", "生成2K海报，默认Low", "使用High画质生成图片", "使用Medium生成4K图片",
    "为什么使用High2K", "检查2K参数", "这是4K参考图，输出1K", "不要使用High", "> 使用High生成4K\n制作海报",
    '参考文本："使用High生成4K"，制作海报', "生成9张图片", "生成六张图片", "生成一张1:1和一张16:9的宣传图",
    "生成2张Logo和2张海报", "生成共6张图：2张Logo和4张海报", "使用2张参考图生成1张图片", "生成2张图，每张包含3个版本",
    "生成海报，画质：High，分辨率：2K", "Create a poster; quality: high; resolution: 2K", "生成 2 images and 2 pictures",
    "make a high contrast image", "create a medium-sized banner", "生成高质量3D风格图",
  ];
  for (const text of vectors) {
    const expected = mastraImageExecutionPolicy(text);
    const { rows: [actual] } = await admin.query(`SELECT
      ${schema}.loomic_image_tier_authorized($1,'((?<![A-Za-z0-9_])(?:medium|hd)(?![A-Za-z0-9_])|中(?:等|档)质量|中等画质)') medium,
      ${schema}.loomic_image_tier_authorized($1,'((?<![A-Za-z0-9_])(?:high|ultra)(?![A-Za-z0-9_])|高(?:等|档)?质量|高画质)') high,
      ${schema}.loomic_image_tier_authorized($1,'((?<![A-Za-z0-9_])2[[:space:]]*k(?![A-Za-z0-9_]))') "resolution2k",
      ${schema}.loomic_image_tier_authorized($1,'((?<![A-Za-z0-9_])4[[:space:]]*k(?![A-Za-z0-9_]))') "resolution4k",
      ${schema}.loomic_image_requested_output_count($1) "requestedCount"`, [text]);
    assert.deepEqual(actual, { medium: expected.medium, high: expected.high, resolution2k: expected.resolution2k,
      resolution4k: expected.resolution4k, requestedCount: expected.requestedCount ?? null }, text);
  }
  const user = randomUUID(), session = randomUUID(), canvas = randomUUID(), workspace = randomUUID(), message = randomUUID(), run = randomUUID();
  await admin.query(`INSERT INTO ${schema}.agent_runs VALUES($1,$2,$3,'running',$4)`, [run,user,session,message]);
  await admin.query(`INSERT INTO ${schema}.chat_messages VALUES($1,$2,'user','制作海报')`, [message,session]);
  await admin.query(`INSERT INTO ${schema}.chat_sessions VALUES($1,$2)`, [session,canvas]);
  await admin.query(`INSERT INTO ${schema}.canvases VALUES($1,$2)`, [canvas,workspace]);
  await admin.query(`INSERT INTO ${schema}.workspace_members VALUES($1,$2)`, [workspace,user]);
  await admin.query(`UPDATE ${schema}.chat_messages SET content='使用High画质；使用Medium画质；生成2K图片' WHERE id=$1`, [message]);
  async function legacy(quality,resolution) {
    return admin.query(`INSERT INTO ${schema}.background_jobs VALUES($1,$2,$3,$4,$5,'image_generation',$6,'canceled')`,
      [randomUUID(),user,session,canvas,workspace,{ mastra_submission_key: `${run}:${randomUUID()}`, mastra_origin_run_id: run,
        operation: "remove_background", quality, resolution }]);
  }
  for (const [quality,resolution] of [["standard","1k"],["ultra","1k"],["hd","2k"]])
    await assert.rejects(legacy(quality,resolution), /image_legacy_background_removal_contract_required/);
  await legacy("hd","1k");
  assert.equal((await admin.query(`SELECT count(*)::integer n FROM ${schema}.background_jobs`)).rows[0].n,1);
  await admin.query(`DELETE FROM ${schema}.background_jobs`);
  await admin.query(`UPDATE ${schema}.chat_messages SET content='制作海报' WHERE id=$1`, [message]);
  async function insert(client, key) {
    return client.query(`INSERT INTO ${schema}.background_jobs VALUES($1,$2,$3,$4,$5,'image_generation',$6,'canceled')`,
      [randomUUID(),user,session,canvas,workspace,{ mastra_submission_key: `${run}:${key}`, mastra_origin_run_id: run, quality: "standard", resolution: "1k", mastra_default_run_limit: 4 }]);
  }
  for (let i = 0; i < 8; i++) { const client = new Client({ connectionString: dbUrl }); await client.connect(); peers.push(client); }
  const concurrent = await Promise.allSettled(peers.map((client,i) => insert(client, String(i).padStart(64,"0"))));
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length,4);
  assert.equal(concurrent.filter(result => result.status === "rejected" && result.reason.message.includes("image_generation_run_limit")).length,4);
  const { rows: jobs } = await admin.query(`SELECT payload FROM ${schema}.background_jobs`);
  await assert.rejects(insert(admin,jobs[0].payload.mastra_submission_key.split(":")[1]),/image_generation_run_limit/);
  // JobService handles this proven INSERT rejection by finding the original replay.
  const { rows: replay } = await admin.query(`SELECT id FROM ${schema}.background_jobs WHERE payload->>'mastra_submission_key'=$1`, [jobs[0].payload.mastra_submission_key]);
  assert.equal(replay.length,1);
  assert.equal((await admin.query(`SELECT count(*)::integer n FROM ${schema}.background_jobs`)).rows[0].n,4);
  console.log(`Image policy SQL smoke passed: ${vectors.length} JS/SQL vectors, legacy Low/Ultra/2K rejected and authorized Medium1K accepted, 8 concurrent canceled inserts -> 4 accepted, replay at cap -> same durable job.`);
} finally {
  await Promise.allSettled(peers.map(client => client.end()));
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
