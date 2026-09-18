import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BEHAVIOR_SCENARIOS, evaluateBehavior, type BehaviorEvidence } from "../src/agent/behavior-eval.js";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(SERVER_DIR, "scripts", "test-paid-dialogue-live.ts");
const FIXTURE_DIR = resolve(SERVER_DIR, "..", "..", "artifacts", "paid-dialogue-live", "behavior-eval");

function runDriver(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", DRIVER, ...args], {
    cwd: SERVER_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

function completedTools(stdout: string): string[] {
  const names: string[] = [];
  for (const match of stdout.matchAll(/^TOOL (\S+) completed$/gm)) names.push(match[1]!);
  return names;
}

async function main() {
  if (process.env.LOOMIC_BEHAVIOR_EVAL !== "1") {
    console.log("Refusing to run live behavior evals without LOOMIC_BEHAVIOR_EVAL=1 (it creates projects, spends time and may charge).");
    return;
  }
  if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required; run with the local app.env");
  const only = process.argv.slice(2).find(argument => argument.startsWith("--only="))?.slice("--only=".length);
  const scenarios = only ? BEHAVIOR_SCENARIOS.filter(scenario => scenario.id === only) : BEHAVIOR_SCENARIOS;
  if (!scenarios.length) throw new Error(`no behavior scenario matched --only=${only}`);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  let failed = 0;
  try {
    for (const scenario of scenarios) {
      try {
        const fixturePath = join(FIXTURE_DIR, `${scenario.id}-${Date.now()}.json`);
        runDriver(["--init", "--submit", "--fixture", fixturePath]);
        const manifest = JSON.parse(readFileSync(fixturePath, "utf8")) as { fixture: { sessionId: string } };
        const sessionId = manifest.fixture.sessionId;
        const tools: string[] = [];
        for (const turn of scenario.turns) {
          const stdout = runDriver(["--turn", turn, "--submit", "--wait-images", "--fixture", fixturePath]);
          tools.push(...completedTools(stdout));
        }
        const jobs = await db.query(
          `select id, job_type, status, coalesce(payload->>'prompt','') as prompt,
                  payload->>'aspect_ratio' as aspect_ratio,
                  coalesce(jsonb_array_length(payload->'input_images'),0) as reference_count
             from background_jobs where session_id = $1 order by created_at`, [sessionId]);
        const session = await db.query(
          "select active_skill, series from session_design_context where session_id = $1", [sessionId]);
        const texts = await db.query(
          "select content from chat_messages where session_id = $1 and role = 'assistant' order by created_at", [sessionId]);
        const evidence: BehaviorEvidence = {
          sessionId, tools,
          assistantTexts: texts.rows.map((row: any) => String(row.content ?? "")),
          jobs: jobs.rows.map((row: any) => ({ id: row.id, jobType: row.job_type, status: row.status, prompt: String(row.prompt ?? ""),
            ...(typeof row.aspect_ratio === "string" ? { aspectRatio: row.aspect_ratio } : {}),
            referenceCount: Number(row.reference_count ?? 0) })),
          session: session.rows[0]
            ? { activeSkill: session.rows[0].active_skill ?? null, series: session.rows[0].series ?? null } : null,
        };
        const violations = evaluateBehavior(evidence, scenario);
        if (violations.length) { failed += 1; console.log(`BEHAVIOR ${scenario.id} FAIL ${JSON.stringify(violations)}`); }
        else console.log(`BEHAVIOR ${scenario.id} PASS`);
      } catch (error) {
        failed += 1;
        console.log(`BEHAVIOR ${scenario.id} ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await db.end().catch(() => undefined);
  }
  console.log(`BEHAVIOR summary total=${scenarios.length} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
