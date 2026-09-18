import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveAgentRuntimeMode } from "./runtime.js";

/** Module basenames retired with the legacy DeepAgent runtime. */
const RETIRED = [
  "deep-agent",
  "design-task-tools",
  "design-task-completion",
  "design-task-verification",
  "workflow-execution",
  "deferred-design-task",
  "sub-agents",
  "result-continuation",
  "autonomous-execution",
  "expert-model-resolver",
  "intent-context",
  "intent-effect-observation",
  "intent-write-context",
  "intent-write-gate",
  "intent-write-middleware",
  "context-compaction",
  "active-skill-guidance",
  "skill-reference-projection",
  "image-proposal-relation",
  "image-failure-receipt",
  "image-job-status-query",
  "running-image-cancellation",
  "runtime-target-observation",
  "ambiguous-image-reference",
  "canvas-agent-evaluation",
  "demand-loaded-tools",
  "pending-image-acknowledgement",
  "requested-image-review",
  "generated-image-source-names",
  "image-result-task-marker",
  "mastra-design-tools",
  "task-message-routing",
  "image-confirmation",
  "image-confirmation-authorization",
  "agent-delegation-contracts",
  "agent-delegation-service",
  "agent-design-creation-service",
  "agent-autonomy-runner",
  "agent-autonomy-service",
  "agent-autonomy-canvas-service",
  "agent-autonomy-export-service",
  "agent-continuation-runner",
  "agent-continuation-service",
  "agent-autonomy",
  "agent-continuations",
] as const;

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

describe("legacy agent runtime is retired", () => {
  it("defaults to Mastra and fails fast for the retired legacy runtime", () => {
    expect(resolveAgentRuntimeMode({})).toBe("mastra");
    expect(resolveAgentRuntimeMode({ LOOMIC_AGENT_RUNTIME: "mastra" })).toBe("mastra");
    expect(() => resolveAgentRuntimeMode({ LOOMIC_AGENT_RUNTIME: "legacy" })).toThrow(/retired/);
    expect(() => resolveAgentRuntimeMode({ LOOMIC_AGENT_RUNTIME: "other" })).toThrow('Expected "mastra"');
  });

  it("has no production source importing a retired legacy module", () => {
    const files = [
      ...sourceFiles(join(repoRoot, "apps", "server", "src")),
      ...sourceFiles(join(repoRoot, "packages", "shared", "src")),
      ...sourceFiles(join(repoRoot, "apps", "web", "src")),
    ];
    const escaped = RETIRED.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const specifier = new RegExp(
      `(?:from|import)\\s*\\(?\\s*["'][^"']*(?:${escaped.join("|")})\\.js["']`,
      "u",
    );
    const offenders = files.filter(file => specifier.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
