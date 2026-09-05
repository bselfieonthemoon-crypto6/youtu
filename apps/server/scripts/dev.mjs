import { spawn } from "node:child_process";

const commonArgs = [
  "--watch",
  "--env-file=../../.env.local",
  "--import",
  "tsx",
];

const children = [
  spawn(process.execPath, [...commonArgs, "./src/server.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, [...commonArgs, "./src/worker.ts"], {
    stdio: "inherit",
    env: { ...process.env, WORKER_ID: process.env.WORKER_ID ?? "w1" },
  }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("[dev] Failed to start child process:", error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(
      `[dev] Child process exited (${signal ?? `code ${code ?? 1}`}); stopping dev services.`,
    );
    stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
