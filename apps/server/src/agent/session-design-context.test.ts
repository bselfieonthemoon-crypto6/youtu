import { describe, expect, it, vi } from "vitest";

import { loadSessionDesignContext, saveSessionDesignContext, sessionSkillMemoryEnabled } from "./session-design-context.js";

function readClient(data: unknown, error: unknown = null) {
  const maybeSingle = vi.fn(async () => ({ data, error }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { client: { from: vi.fn(() => ({ select })) }, select, eq, maybeSingle };
}

describe("loadSessionDesignContext", () => {
  it("normalizes a stored row and drops malformed series fields", async () => {
    const db = readClient({ active_skill: "game-promo-visuals", active_skill_hash: "hash",
      series: { style: "黑金", sizes: ["1200x628", 5], materialAssetIds: ["a", null], updatedAt: "t" } });
    await expect(loadSessionDesignContext(db.client, "session")).resolves.toEqual({
      activeSkill: "game-promo-visuals", activeSkillHash: "hash",
      series: { style: "黑金", sizes: ["1200x628"], materialAssetIds: ["a"], updatedAt: "t" },
      awaitingClarification: false,
    });
  });

  it("reads the pending clarification flag", async () => {
    const db = readClient({ active_skill: null, active_skill_hash: null, series: null, awaiting_clarification: true });
    await expect(loadSessionDesignContext(db.client, "session")).resolves.toMatchObject({ awaitingClarification: true });
  });

  it("fails closed to null on missing rows, errors or exceptions", async () => {
    await expect(loadSessionDesignContext(readClient(null).client, "session")).resolves.toBeNull();
    await expect(loadSessionDesignContext(readClient(null, new Error("denied")).client, "session")).resolves.toBeNull();
    const broken = { from: () => { throw new Error("no table"); } };
    await expect(loadSessionDesignContext(broken, "session")).resolves.toBeNull();
  });
});

describe("saveSessionDesignContext", () => {
  it("upserts only the provided keys and never throws", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const client = { from: vi.fn(() => ({ upsert })) };
    await saveSessionDesignContext(client, "session", { activeSkill: "logo-design", series: null, awaitingClarification: true });
    expect(upsert).toHaveBeenCalledWith({ session_id: "session", active_skill: "logo-design", series: null,
      awaiting_clarification: true }, { onConflict: "session_id" });
    const broken = { from: () => { throw new Error("no table"); } };
    await expect(saveSessionDesignContext(broken, "session", { activeSkill: "x" })).resolves.toBeUndefined();
  });
});

describe("sessionSkillMemoryEnabled", () => {
  it("defaults on and can be disabled without a deploy", () => {
    expect(sessionSkillMemoryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(sessionSkillMemoryEnabled({ LOOMIC_SESSION_SKILL_MEMORY: "1" } as NodeJS.ProcessEnv)).toBe(true);
    for (const value of ["0", "false", "off"]) {
      expect(sessionSkillMemoryEnabled({ LOOMIC_SESSION_SKILL_MEMORY: value } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});
