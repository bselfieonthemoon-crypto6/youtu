import { describe, expect, it, vi } from "vitest";

import { SESSION_UNFINISHED_MAX_ITEMS, collectUnfinishedSessionOutputs, loadSessionDesignContext,
  saveSessionDesignContext, sessionSkillMemoryEnabled } from "./session-design-context.js";

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
      unfinishedOutputs: [],
    });
  });

  it("reads the unfinished outputs a previous run persisted, and drops unusable entries", async () => {
    const db = readClient({ active_skill: null, active_skill_hash: null, series: null, awaiting_clarification: false,
      unfinished_outputs: [
        { title: "轮播第2页", kind: "refused", prompt: "第二页", operation: "edit",
          aspectRatio: "1:1", sourceAssetIds: ["aaaaaaaa-0000-4000-8000-000000000001", 7] },
        { title: "轮播第3页", kind: "planned" },
        // No title: never a usable briefing entry.
        { kind: "refused", prompt: "x" },
        "not-an-object",
      ] });
    await expect(loadSessionDesignContext(db.client, "session")).resolves.toMatchObject({
      unfinishedOutputs: [
        { title: "轮播第2页", kind: "refused", prompt: "第二页", operation: "edit",
          aspectRatio: "1:1", sourceAssetIds: ["aaaaaaaa-0000-4000-8000-000000000001"] },
        { title: "轮播第3页", kind: "planned" },
      ],
    });
  });

  it("maps an absent or non-array column to an empty unfinished list", async () => {
    await expect(loadSessionDesignContext(readClient({ series: null }).client, "session"))
      .resolves.toMatchObject({ unfinishedOutputs: [] });
    await expect(loadSessionDesignContext(readClient({ unfinished_outputs: { title: "x" } }).client, "session"))
      .resolves.toMatchObject({ unfinishedOutputs: [] });
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

  it("persists unfinished work, and clears the column when a run leaves none", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const client = { from: vi.fn(() => ({ upsert })) };
    await saveSessionDesignContext(client, "session", { unfinishedOutputs: [
      { title: "轮播第2页", kind: "refused", prompt: "第二页", operation: "edit", aspectRatio: "1:1" },
    ] });
    expect(upsert).toHaveBeenLastCalledWith({ session_id: "session", unfinished_outputs: [
      { title: "轮播第2页", kind: "refused", prompt: "第二页", operation: "edit", aspectRatio: "1:1" },
    ] }, { onConflict: "session_id" });
    // An empty list is the explicit "nothing is left" signal, not an omission:
    // the column is cleared instead of keeping a stale record.
    await saveSessionDesignContext(client, "session", { unfinishedOutputs: [] });
    expect(upsert).toHaveBeenLastCalledWith({ session_id: "session", unfinished_outputs: null }, { onConflict: "session_id" });
    // Omitting the key writes nothing at all, so an unrelated save never clears it.
    await saveSessionDesignContext(client, "session", { activeSkill: "logo-design" });
    expect(upsert).toHaveBeenLastCalledWith({ session_id: "session", active_skill: "logo-design" }, { onConflict: "session_id" });
  });
});

describe("collectUnfinishedSessionOutputs", () => {
  const refused = (title: string, extra: Record<string, unknown> = {}) =>
    ({ title, prompt: `${title} 的原始提示`, operation: "edit", aspectRatio: "1:1", sourceAssetIds: [], ...extra });

  it("records three distinct refused pages of a carousel, not three copies", () => {
    expect(collectUnfinishedSessionOutputs({
      refused: [refused("轮播第2页"), refused("轮播第3页"), refused("轮播第4页"), refused("轮播第2页")],
      planSteps: undefined,
    })).toEqual([
      { title: "轮播第2页", kind: "refused", prompt: "轮播第2页 的原始提示", operation: "edit", aspectRatio: "1:1" },
      { title: "轮播第3页", kind: "refused", prompt: "轮播第3页 的原始提示", operation: "edit", aspectRatio: "1:1" },
      { title: "轮播第4页", kind: "refused", prompt: "轮播第4页 的原始提示", operation: "edit", aspectRatio: "1:1" },
    ]);
  });

  it("uses the open plan steps when nothing was refused, which covers a cancellation", () => {
    expect(collectUnfinishedSessionOutputs({ refused: [], planSteps: [
      { id: "s1", title: "确认品牌信息", status: "completed" },
      { id: "s2", title: "生成三张主视觉", status: "in_progress" },
      { id: "s3", title: "交付到画布", status: "pending" },
      { id: "s4", title: "放弃的方向", status: "failed" },
    ] })).toEqual([
      { title: "生成三张主视觉", kind: "planned" },
      { title: "交付到画布", kind: "planned" },
    ]);
  });

  it("prefers the refused entry over a plan step with the same title and bounds the list", () => {
    const collected = collectUnfinishedSessionOutputs({
      refused: [refused("生成三张主视觉", { prompt: "更具体的原始提示" })],
      planSteps: [{ id: "s2", title: "生成三张主视觉", status: "in_progress" }],
    });
    expect(collected).toEqual([
      { title: "生成三张主视觉", kind: "refused", prompt: "更具体的原始提示", operation: "edit", aspectRatio: "1:1" },
    ]);
    const many = collectUnfinishedSessionOutputs({
      refused: Array.from({ length: 12 }, (_, index) => refused(`第${index + 1}页`)),
      planSteps: [],
    });
    expect(many).toHaveLength(SESSION_UNFINISHED_MAX_ITEMS);
    expect(many[0]!.title).toBe("第1页");
    expect(many.at(-1)!.title).toBe(`第${SESSION_UNFINISHED_MAX_ITEMS}页`);
  });

  it("ignores malformed records instead of inventing an entry from prose", () => {
    expect(collectUnfinishedSessionOutputs({ refused: [{ prompt: "没有标题" }, null, "x"], planSteps: [{ title: "  ", status: "pending" }] }))
      .toEqual([]);
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
