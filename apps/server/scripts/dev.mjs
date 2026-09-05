import { spawn } from "node:child_process";
import { superviseWorker } from "./worker-supervisor.mjs";

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
];

// Worker code changes require a dev restart; never abandon in-flight paid jobs
// merely because a shared source file was edited.
const worker = superviseWorker({ spawnWorker: () =>
  spawn(process.execPath, [...commonArgs.filter(arg => arg !== "--watch"), "./src/worker.ts"], {
    stdio: "inherit",
    env: { ...process.env, WORKER_ID: process.env.WORKER_ID ?? "w1" },
  }),
});

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  worker.stop();
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
