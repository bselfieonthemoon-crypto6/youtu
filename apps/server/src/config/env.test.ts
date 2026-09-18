import { describe, expect, it } from "vitest";

import { loadServerEnv } from "./env.js";

const overrides = {
  agentModel: "test-model",
  port: 3001,
  version: "test",
  webOrigin: "http://localhost:3000",
};

describe("Mastra write-repair environment", () => {
  it("defaults both controls to enabled", () => {
    const env = loadServerEnv(overrides, {});

    expect(env.mastraWriteRepairEnabled).toBe(true);
    expect(env.mastraWriteRepairToolChoice).toBe(true);
  });

  it("rejects an invalid write-repair boolean", () => {
    expect(() => loadServerEnv(overrides, {
      LOOMIC_MASTRA_WRITE_REPAIR_ENABLED: "sometimes",
    })).toThrow("Invalid boolean environment value: sometimes");
  });

  it("parses both controls independently, including numeric booleans", () => {
    for (const [enabled, required, expectedEnabled, expectedRequired] of [
      ["false", "true", false, true], ["true", "false", true, false],
      ["0", "1", false, true], ["1", "0", true, false],
    ] as const) {
      const env = loadServerEnv(overrides, {
        LOOMIC_MASTRA_WRITE_REPAIR_ENABLED: enabled,
        LOOMIC_MASTRA_WRITE_REPAIR_TOOL_CHOICE: required,
      });
      expect(env.mastraWriteRepairEnabled).toBe(expectedEnabled);
      expect(env.mastraWriteRepairToolChoice).toBe(expectedRequired);
    }
  });
});
