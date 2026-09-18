import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const webRoot = process.cwd();
const testRoot = path.join(webRoot, "test");
const testFiles = [
  ...ts.sys.readDirectory(testRoot, [".ts", ".tsx"], undefined, ["**/*"]),
  ...ts.sys.readDirectory(path.join(webRoot, "src"), [".ts", ".tsx"], undefined, ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]),
].sort();
if (testFiles.length === 0) {
  console.error("Web typecheck did not find any TypeScript files under apps/web/test.");
  process.exit(1);
}

const batchSize = readBatchSize(process.env.LOOMIC_WEB_TYPECHECK_TEST_BATCH_SIZE);
runWorker("production");
let failed = false;
for (let start = 0; start < testFiles.length; start += batchSize) {
  const end = Math.min(start + batchSize, testFiles.length);
  console.info(`[web-typecheck] checking test files ${start + 1}-${end}/${testFiles.length}`);
  if (!runWorker("test", start, end)) failed = true;
}
console.info(`[web-typecheck] ${failed ? "FAILED" : "passed"} production source and ${testFiles.length} test files in isolated batches of ${batchSize}`);
process.exitCode = failed ? 1 : 0;

function runWorker(mode, start, end) {
  const args = ["--max-old-space-size=1536", path.join(webRoot, "scripts", "run-web-typecheck-batch.mjs"), mode];
  if (mode === "test") args.push(String(start), String(end));
  const result = spawnSync(process.execPath, args, { cwd: webRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal || ![0, 1].includes(result.status) || (mode === "production" && result.status !== 0)) {
    console.error("Web typecheck stopped; remaining batches were not checked.");
    process.exit(result.status ?? 1);
  }
  return result.status === 0;
}

function readBatchSize(value) {
  if (value === undefined) return 32;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 128) {
    throw new Error("LOOMIC_WEB_TYPECHECK_TEST_BATCH_SIZE must be an integer from 1 to 128.");
  }
  return parsed;
}
