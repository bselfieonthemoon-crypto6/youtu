import path from "node:path";
import process from "node:process";
import ts from "typescript";

const [mode, startText, endText] = process.argv.slice(2);
const webRoot = process.cwd();
const configPath = path.join(webRoot, "tsconfig.production.json");
const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
if (configResult.error) fail([configResult.error]);

const parsed = ts.parseJsonConfigFileContent(configResult.config, ts.sys, webRoot, undefined, configPath);
if (parsed.errors.length > 0) fail(parsed.errors);

let testFiles = [];
if (mode === "test") {
  const start = Number.parseInt(startText, 10);
  const end = Number.parseInt(endText, 10);
  testFiles = [
    ...ts.sys.readDirectory(path.join(webRoot, "test"), [".ts", ".tsx"], undefined, ["**/*"]),
    ...ts.sys.readDirectory(path.join(webRoot, "src"), [".ts", ".tsx"], undefined, ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]),
  ].sort();
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > testFiles.length) {
    throw new Error("Invalid web typecheck test batch range.");
  }
  testFiles = testFiles.slice(start, end);
} else if (mode !== "production") {
  throw new Error("Expected a production or test web typecheck batch.");
}

const program = ts.createProgram({
  rootNames: [...parsed.fileNames, ...testFiles],
  options: parsed.options,
  projectReferences: parsed.projectReferences,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) fail(diagnostics);

function fail(diagnostics) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => webRoot,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}
