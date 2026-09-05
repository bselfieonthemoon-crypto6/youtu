import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(webRoot, "../..");

loadEnvFile(path.join(workspaceRoot, ".env.local"));

const baseURL = process.env.LOOMIC_E2E_BASE_URL ?? "http://localhost:3000";
const serverURL = process.env.LOOMIC_E2E_SERVER_URL ?? "http://localhost:3001";
const externalStack = process.env.LOOMIC_E2E_EXTERNAL_STACK === "true";
const webPort = readPort(baseURL, 3000);
const serverPort = readPort(serverURL, 3001);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
    },
  ],
  webServer: externalStack
    ? undefined
    : [
        {
          command: "pnpm dev:server",
          cwd: path.join(workspaceRoot, "apps/server"),
          env: {
            ...process.env,
            LOOMIC_SERVER_PORT: String(serverPort),
            // Keep the browser origin aligned with the isolated Playwright
            // port instead of inheriting the developer's :3000 origin.
            LOOMIC_WEB_ORIGIN: new URL(baseURL).origin,
          },
          url: `${serverURL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: `pnpm exec next dev -p ${webPort}`,
          cwd: webRoot,
          env: {
            ...process.env,
            LOOMIC_NEXT_DIST_DIR:
              process.env.LOOMIC_NEXT_DIST_DIR ?? `.next-e2e-${webPort}`,
          },
          url: `${baseURL}/canvas`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});

function loadEnvFile(filePath: string): void {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    const rawValue = trimmed.slice(separator + 1).trim();
    process.env[key] = unquote(rawValue);
  }
}

function unquote(value: string): string {
  const quote = value.at(0);
  if (
    value.length >= 2 &&
    (quote === '"' || quote === "'") &&
    value.at(-1) === quote
  ) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

function readPort(url: string, fallback: number): number {
  const parsed = new URL(url);
  if (!parsed.port) return fallback;
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid E2E port in URL: ${url}`);
  }
  return port;
}
