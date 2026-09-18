import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const configPath = path.join(cwd, "tsconfig.json");
const raw = ts.readConfigFile(configPath, ts.sys.readFile);
if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, cwd);
if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
  getCurrentDirectory: () => cwd, getCanonicalFileName: f => f, getNewLine: () => "\n",
}));
const files = [...new Set(parsed.fileNames.map(f => path.resolve(f)))].sort();
const tests = files.filter(f => /\.(test|spec)\.tsx?$/.test(f));
const scripts = files.filter(f => !tests.includes(f) && f.startsWith(path.join(cwd, "scripts") + path.sep));
const production = files.filter(f => !tests.includes(f) && !scripts.includes(f));
const batchSize = 32;
// Preserve project ambient declarations in every isolated root set.
const ambient = files.filter(f => f.endsWith(".d.ts"));
const chunks = values => Array.from({ length: Math.ceil(values.length / batchSize) }, (_, i) => values.slice(i * batchSize, (i + 1) * batchSize));
const groups = [{ name: "production", files: production },
  ...chunks(scripts).map((files, i) => ({ name: `scripts-${i + 1}`, files })),
  ...chunks(tests).map((files, i) => ({ name: `tests-${i + 1}`, files }))];
const directory = mkdtempSync(path.join(tmpdir(), "loomic-typecheck-"));
const config = path.join(directory, "tsconfig.json");
const report = { completed: false, totalRootFiles: files.length, production: production.length,
  scripts: scripts.length, tests: tests.length, heapMiB: 1536, batchSize, batches: [] };
let failed = false;
try {
  for (const group of groups) {
    writeFileSync(config, JSON.stringify({ extends: configPath, files: [...new Set([...production, ...group.files, ...ambient])],
      include: [], exclude: [], compilerOptions: { noEmit: true, incremental: false } }));
    const result = spawnSync(process.execPath, ["--max-old-space-size=1536", require.resolve("typescript/bin/tsc"),
      "-p", config, "--noEmit", "--pretty", "false"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const ok = result.status === 0 && !result.error;
    report.batches.push({ name: group.name, rootFiles: group.files.map(f => path.relative(cwd, f)),
      exitCode: result.status, signal: result.signal, passed: ok, output, error: result.error?.message ?? null });
    console.log(`[typecheck] ${group.name}: ${group.files.length} roots, ${ok ? "passed" : "FAILED"}`);
    if (!ok) { failed = true; process.stdout.write(output); }
    if (/heap out of memory|Allocation failed|process out of memory/i.test(output) || result.error || result.signal) {
      console.error("Typecheck stopped after resource/process failure; remaining batches were not checked.");
      break;
    }
  }
  report.completed = report.batches.length === groups.length;
} finally {
  unlinkSync(config);
  rmdirSync(directory);
  const artifactDir = path.resolve(cwd, "../../artifacts/typecheck");
  mkdirSync(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, `server-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Typecheck report: ${reportPath}`);
}
process.exitCode = failed || !report.completed ? 1 : 0;
