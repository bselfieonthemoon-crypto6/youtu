import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mastraImageAuthorizationCases } from "../src/agent/mastra-image-authorization-cases.ts";
import { mastraImageExecutionPolicy, validateMastraImageExecution } from "../src/agent/mastra-image-execution-policy.ts";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

// These are the deployed guard literals from migration 20260915000006. They are
// intentionally independent from the TypeScript RegExp values.
const guardTierPatterns = {
  medium: "((?<![A-Za-z0-9_])(medium|hd)(?![A-Za-z0-9_])|中(等|档)质量|中等画质)",
  high: "((?<![A-Za-z0-9_])(high|ultra)(?![A-Za-z0-9_])|高(等|档)?质量|高画质)",
  resolution2k: "((?<![A-Za-z0-9_])2[[:space:]]*k(?![A-Za-z0-9_]))",
  resolution4k: "((?<![A-Za-z0-9_])4[[:space:]]*k(?![A-Za-z0-9_]))",
};

function notExecuted(reason) {
  console.error(`未执行（缺少 DB 配置）：${reason}`);
  process.exitCode = 1;
}

function extractGuardTierPatterns(definition) {
  const executableDefinition = definition
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "");
  return [...executableDefinition.matchAll(
    /loomic_image_tier_authorized\s*\(\s*request_text\s*,\s*'((?:''|[^'])*)'\s*\)/gi,
  )].map(match => match[1].replaceAll("''", "'"));
}

export function assertGuardPatterns(definition) {
  const actual = extractGuardTierPatterns(definition);
  const expected = Object.values(guardTierPatterns);
  assert.equal(actual.length, expected.length, "deployed guard must call loomic_image_tier_authorized exactly four times");
  for (const pattern of expected) {
    assert.ok(actual.includes(pattern), `deployed loomic_mastra_image_execution_guard is missing a fixed tier pattern`);
  }
  assert.deepEqual(actual, expected, "deployed guard tier patterns must retain their quality/resolution order");
}

function verifyGuardPatternNegativeControl() {
  const fixtureDefinition = Object.values(guardTierPatterns)
    .map(pattern => `PERFORM public.loomic_image_tier_authorized(request_text,'${pattern}');`)
    .join("\n");
  assertGuardPatterns(fixtureDefinition);
  assert.throws(
    () => assertGuardPatterns(fixtureDefinition.replace(guardTierPatterns.high, "(altered-high-pattern)")),
    /fixed tier pattern/,
    "guard pattern extraction must reject a one-pattern drift",
  );
}

function assertAuthorizationMeaning({ expectedCode, quality, resolution, policy, text }) {
  if (expectedCode === "image_quality_not_authorized") {
    assert.equal(quality === "hd" ? policy.medium : policy.high, false, `${text}: expected quality denial`);
  } else if (expectedCode === "image_resolution_not_authorized") {
    assert.equal(resolution === "2k" ? policy.resolution2k : policy.resolution4k, false, `${text}: expected resolution denial`);
  } else if (expectedCode === "image_generation_requested_count_unsupported") {
    assert.ok((policy.requestedCount ?? 0) > 8, `${text}: expected unsupported output count`);
  }
}

function sqlExecutionPolicy(databasePolicy, quality, resolution) {
  const requestedCount = databasePolicy.requestedCount;
  const expectedCode = requestedCount !== null && (requestedCount < 1 || requestedCount > 8)
    ? "image_generation_requested_count_unsupported"
    : quality === "hd" && !databasePolicy.medium || quality === "ultra" && !databasePolicy.high
      ? "image_quality_not_authorized"
      : resolution === "2k" && !databasePolicy.resolution2k || resolution === "4k" && !databasePolicy.resolution4k
        ? "image_resolution_not_authorized"
        : null;
  // The guard rejects counts above eight before applying a run limit. This is
  // the corresponding externally observable limit, matching the TS policy.
  const limit = Math.min(requestedCount ?? 4, 8);
  return { expectedCode, limit };
}

verifyGuardPatternNegativeControl();

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  notExecuted("SUPABASE_DB_URL 未设置");
} else {
  try {
    new URL(dbUrl);
  } catch {
    notExecuted("SUPABASE_DB_URL 无效");
  }
}

if (!process.exitCode) {
  const transactionFile = await readFile(new URL("./test-mastra-image-execution-policy.transaction.sql", import.meta.url), "utf8");
  assert.match(transactionFile, /BEGIN\s+READ\s+ONLY\s*;/i, "transaction script must begin a read-only transaction");
  assert.match(transactionFile, /ROLLBACK\s*;/i, "transaction script must roll back");

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10000, query_timeout: 10000 });
  let inTransaction = false;
  let connected = false;
  try {
    try {
      await client.connect();
      connected = true;
    } catch {
      notExecuted("无法连接 SUPABASE_DB_URL");
    }

    if (!connected) {
      // notExecuted already set the required non-zero exit status.
    } else {
      await client.query("BEGIN READ ONLY");
      inTransaction = true;
      const { rows: [guard] } = await client.query(
        "SELECT pg_get_functiondef('public.loomic_mastra_image_execution_guard()'::regprocedure) AS definition",
      );
      assert.ok(guard?.definition, "deployed loomic_mastra_image_execution_guard is unavailable");
      assertGuardPatterns(guard.definition);

      for (const testCase of mastraImageAuthorizationCases) {
        const policy = mastraImageExecutionPolicy(testCase.text, 4);
        const result = validateMastraImageExecution(
          { quality: testCase.quality, resolution: testCase.resolution }, testCase.text,
        );
        assert.equal(result?.code ?? null, testCase.expectedCode, `${testCase.text}: TypeScript error code`);
        assert.equal(policy.limit, testCase.expectedLimit, `${testCase.text}: TypeScript limit`);

        const { rows: [databasePolicy] } = await client.query(
          `SELECT
            public.loomic_image_tier_authorized($1, $2) AS medium,
            public.loomic_image_tier_authorized($1, $3) AS high,
            public.loomic_image_tier_authorized($1, $4) AS "resolution2k",
            public.loomic_image_tier_authorized($1, $5) AS "resolution4k",
            public.loomic_image_requested_output_count($1) AS "requestedCount"`,
          [testCase.text, guardTierPatterns.medium, guardTierPatterns.high, guardTierPatterns.resolution2k, guardTierPatterns.resolution4k],
        );
        assert.deepEqual(databasePolicy, {
          medium: policy.medium,
          high: policy.high,
          resolution2k: policy.resolution2k,
          resolution4k: policy.resolution4k,
          requestedCount: policy.requestedCount ?? null,
        }, `${testCase.text}: TypeScript and PostgreSQL authorization policy diverged`);
        const databaseExecution = sqlExecutionPolicy(databasePolicy, testCase.quality, testCase.resolution);
        assert.equal(databaseExecution.expectedCode, testCase.expectedCode, `${testCase.text}: SQL-derived error code`);
        assert.equal(databaseExecution.expectedCode, result?.code ?? null, `${testCase.text}: SQL and TypeScript error code`);
        assert.equal(databaseExecution.limit, testCase.expectedLimit, `${testCase.text}: SQL-derived limit`);
        assert.equal(databaseExecution.limit, policy.limit, `${testCase.text}: SQL and TypeScript limit`);
        assertAuthorizationMeaning({ ...testCase, policy, text: testCase.text });
      }
      console.info(`Mastra image authorization parity passed: ${mastraImageAuthorizationCases.length} shared cases.`);
    }
  } finally {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
