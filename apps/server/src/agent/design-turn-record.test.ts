import { describe, expect, it } from "vitest";

import {
  buildDesignTurnRecord,
  describeDesignTurnExecution,
  formatDesignTurnRecord,
  type BuildDesignTurnRecordInput,
} from "./design-turn-record.js";

/**
 * The defect this module exists for, reproduced as the first case below: the
 * router detected `new_generation` and the model only asked a clarifying
 * question. Before this record, the `design.routing` notice was the only per-turn
 * evidence and it described intent as if it were execution.
 *
 * Receipt shapes are the real ones: `mastra-image-tool.ts` for image
 * submissions/refusals, `workspace-skill-tools.ts` and `skill-composition.ts`
 * for Skill reads, `clarification-tool.ts` for the questionnaire.
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111";

const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (toolName: string, output?: unknown, status: "completed" | "failed" | "running" | "canceled" = "completed") => ({
  type: "tool" as const,
  toolCallId: `call-${toolName}`,
  toolName,
  status,
  ...(output === undefined ? {} : { output }),
});

/** `MastraImageJobResult` on the submitted path. */
const jobReceipt = (jobId: string, assetId?: string) => ({
  status: "processing" as const,
  jobId,
  ...(assetId ? { assetId } : {}),
  jobType: "image_generation" as const,
});
/** The pre-submission refusal receipt (`refused: true`, no jobId). */
const refusalReceipt = (code: string) => ({
  status: "failed" as const,
  error: code,
  summary: "本轮请求在提交前被拒绝；未提交或扣费。",
  refused: true as const,
});
/** The unknown-transport receipt: deliberately NOT a refusal. */
const unknownReceipt = {
  status: "unknown" as const,
  error: "image_submission_unknown",
  summary: "图片提交状态未知，可能已创建持久任务。",
};
/** `use_skill` with a body: the only shape that counts as a read guide. */
const loadedSkillReceipt = (name: string) => ({
  status: "loaded" as const,
  skill: { name, displayName: name, version: "1.0.0" },
  instructions: "# method body",
});
/** `compose_skills` success: one primary plus its helpers. */
const composedSkillsReceipt = (primary: string, helpers: string[]) => ({
  status: "composed" as const,
  primary: { name: primary },
  helpers: helpers.map(name => ({ name })),
});

function build(input: Partial<BuildDesignTurnRecordInput> & { contentBlocks: readonly unknown[] }) {
  return buildDesignTurnRecord({ runId: RUN_ID, ...input });
}

describe("executedAction is derived from the receipts, never from the intent", () => {
  it("reports clarification when the router detected new_generation but the run only asked a question", () => {
    const record = build({
      detected: { intent: "new_generation", reasonCode: "explicit_creation", source: "model", confidence: 0.9 },
      contentBlocks: [
        text("需要先确认一下用途。"),
        tool("ask_clarification", { status: "awaiting_user_input", questions: [{ id: 1, title: "用途", prompt: "用在哪里？", options: [], allowCustom: true }] }),
        text("请告诉我这两个信息。"),
      ],
    });

    // The whole point: the two layers disagree and BOTH are visible.
    expect(record.detectedIntent).toBe("new_generation");
    expect(record.executed).toEqual({ kind: "clarification", jobIds: [], assetIds: [] });
    // ...and nothing claims a submission, because no receipt carries a jobId.
    expect(record.summary.executionJobIds).toEqual([]);
    expect(describeDesignTurnExecution(record.executed)).toContain("没有提交生成");
    expect(formatDesignTurnRecord(record).summary).toContain("检测到「新一轮生成」");
    expect(formatDesignTurnRecord(record).summary).toContain("实际执行「向用户提问澄清，没有提交生成」");
  });

  it("reports generation carrying the jobId when a submission receipt names one", () => {
    for (const toolName of ["generate_image", "edit_image"]) {
      const record = build({ contentBlocks: [tool(toolName, jobReceipt("job-abc", "asset-1"))] });
      expect(record.executed, toolName).toEqual({
        kind: "generation", jobIds: ["job-abc"], assetIds: ["asset-1"],
      });
      expect(record.summary.executionJobIds, toolName).toEqual(["job-abc"]);
      expect(record.summary.deliveredAssetIds, toolName).toEqual(["asset-1"]);
      expect(describeDesignTurnExecution(record.executed), toolName).toContain("1 个任务");
    }
  });

  it("reports generation for a created job even when the router detected something else", () => {
    const record = build({
      detected: { intent: "non_design", reasonCode: "informational_question", source: "deterministic", confidence: 1 },
      contentBlocks: [tool("generate_image", jobReceipt("job-1"))],
    });
    expect(record.detectedIntent).toBe("non_design");
    expect(record.executed.kind).toBe("generation");
  });

  it("never claims a submission when a generation tool returned no jobId", () => {
    // A failed submission carries no jobId, and a failure is not proof that
    // nothing was created — so the action is `unknown`, never `generation`.
    const record = build({ contentBlocks: [tool("generate_image", { status: "failed", error: "image_model_unavailable" })] });
    expect(record.executed).toEqual({
      kind: "unknown", code: "tool_failed_without_receipt", jobIds: [], assetIds: [],
    });
    expect(record.summary.executionJobIds).toEqual([]);
    expect(formatDesignTurnRecord(record).summary).not.toContain("已提交");
    expect(formatDesignTurnRecord(record).summary).not.toContain("正在生成");
  });

  it("reports refused with the receipt's own code and no submission claim", () => {
    const record = build({
      detected: { intent: "new_generation", reasonCode: "explicit_creation", source: "model", confidence: 1 },
      contentBlocks: [tool("generate_image", refusalReceipt("image_approximation_not_authorized")), text("已提交，正在生成。")],
    });

    expect(record.executed).toEqual({
      kind: "refused", code: "image_approximation_not_authorized", jobIds: [], assetIds: [],
    });
    expect(record.summary.executionJobIds).toEqual([]);
    const display = formatDesignTurnRecord(record);
    // The false claim in the model's prose is never echoed by the record.
    expect(display.summary).not.toContain("已提交");
    expect(display.summary).toContain("提交前被拒绝（image_approximation_not_authorized）");
    expect(display.summary).toContain("未创建任务、未扣费");
  });

  it("reports text_only for a turn that produced text and nothing else", () => {
    const record = build({
      detected: { intent: "non_design", reasonCode: "informational_question", source: "deterministic", confidence: 1 },
      contentBlocks: [text("生成一张海报大约需要 20 秒。")],
    });
    expect(record.executed).toEqual({ kind: "text_only", jobIds: [], assetIds: [] });
    expect(describeDesignTurnExecution(record.executed)).toBe("只回复文字，没有创建任务");
  });

  it("reports canvas_operation when a canvas write receipt is present", () => {
    const record = build({ contentBlocks: [tool("manipulate_canvas", { ok: true, elementId: "element-1" })] });
    expect(record.executed).toEqual({ kind: "canvas_operation", jobIds: [], assetIds: [] });
  });

  it("reports unknown when the receipts are unreadable, and says why", () => {
    // The tool ran but its receipt never arrived (schema rejection, crash, or a
    // call whose result was lost). Not `text_only`: the receipts do not say.
    const record = build({ contentBlocks: [text("我先查一下。"), tool("generate_image", undefined, "running")] });
    expect(record.executed).toEqual({
      kind: "unknown", code: "tool_execution_report_pending", jobIds: [], assetIds: [],
    });
    expect(formatDesignTurnRecord(record).detail).toContain("本轮结束时仍有工具调用没有结果");
    expect(describeDesignTurnExecution(record.executed)).toContain("无法判定");
    // And never a submission claim.
    expect(record.summary.executionJobIds).toEqual([]);
  });

  it("reports unknown for a missing receipt, a cancelled call and an unverifiable submission", () => {
    expect(build({ contentBlocks: [tool("generate_image")] }).executed)
      .toEqual({ kind: "unknown", code: "no_tool_receipts_readable", jobIds: [], assetIds: [] });
    expect(build({ contentBlocks: [tool("generate_image", jobReceipt("job-1"), "canceled")] }).executed.kind)
      .toBe("unknown");
    // The unknown-transport receipt may already own a durable task, so the record
    // claims neither a submission nor its absence.
    const unverifiable = build({ contentBlocks: [tool("generate_image", unknownReceipt)] });
    expect(unverifiable.executed).toEqual({
      kind: "unknown", code: "image_receipt_unverifiable", jobIds: [], assetIds: [],
    });
    expect(formatDesignTurnRecord(unverifiable).detail).toContain("可能已创建持久任务");
  });

  it("still reports a created job when the same turn also asked a question", () => {
    const record = build({ contentBlocks: [
      tool("ask_clarification", { status: "awaiting_user_input", questions: [] }),
      tool("generate_image", jobReceipt("job-9")),
    ] });
    // The clarification is the turn's user-visible outcome...
    expect(record.executed.kind).toBe("clarification");
    // ...and the real job is still carried, never hidden behind it.
    expect(record.executed.jobIds).toEqual(["job-9"]);
    expect(record.summary.executionJobIds).toEqual(["job-9"]);
  });

  it("keeps the layers independent: the same receipts yield the same action under any detected intent", () => {
    const blocks = [tool("generate_image", refusalReceipt("image_generation_run_limit"))];
    const actions = (["new_generation", "series_continuation", "local_edit", "non_design"] as const).map(intent =>
      build({ detected: { intent }, contentBlocks: blocks }).executed);
    for (const action of actions) expect(action).toEqual(actions[0]);
    expect(actions[0]!.kind).toBe("refused");
  });
});

describe("the per-turn summary is complete and invents nothing", () => {
  it("reports the detected intent, the read Skill names, tool counts, jobs and assets", () => {
    const record = build({
      detected: { intent: "new_generation", reasonCode: "explicit_creation", source: "model", confidence: 0.8 },
      contentBlocks: [
        tool("list_skills", { skills: [{ name: "promo-poster" }, { name: "logo-design" }] }),
        tool("compose_skills", composedSkillsReceipt("promo-poster", ["style-reference"])),
        tool("generate_image", jobReceipt("job-1", "asset-1")),
        tool("generate_image", jobReceipt("job-2", "asset-2")),
        tool("get_image_status", { status: "processing" }),
        text("已提交两版。"),
      ],
    });

    expect(record.summary.intent).toBe("new_generation");
    // Only guides whose receipt carried a body, and `list_skills` is a catalog.
    expect(record.summary.matchedSkillNames).toEqual(["promo-poster", "style-reference"]);
    expect(record.summary.toolUsageCounts).toEqual({
      list_skills: 1, compose_skills: 1, generate_image: 2, get_image_status: 1,
    });
    expect(record.summary.executionJobIds).toEqual(["job-1", "job-2"]);
    expect(record.summary.deliveredAssetIds).toEqual(["asset-1", "asset-2"]);

    const { summary, detail } = formatDesignTurnRecord(record);
    expect(summary).toContain("使用工具：compose_skills×1、generate_image×2、get_image_status×1、list_skills×1");
    expect(summary).toContain("创建任务 2 个（job-1、job-2）");
    expect(summary).toContain("最终交付资产：asset-1、asset-2");
    expect(detail).toContain("匹配到的技能（本轮实际读到正文）：promo-poster、style-reference");
  });

  it("omits an unknown Skill list instead of inventing one, and does not treat a catalog as a read", () => {
    const record = build({
      detected: { intent: "new_generation", reasonCode: "explicit_creation", source: "deterministic", confidence: 1 },
      contentBlocks: [tool("list_skills", { skills: [{ name: "promo-poster" }] }), text("先看一下目录。")],
    });
    expect(record.summary.matchedSkillNames).toBeUndefined();
    expect(formatDesignTurnRecord(record).detail).toContain("未记录（本轮未读到任何技能正文）");
  });

  it("never counts a failed or unavailable Skill read as a matched Skill", () => {
    const record = build({ contentBlocks: [
      tool("use_skill", { status: "unavailable", error: "skill_not_enabled" }),
      tool("use_skill", { status: "conflict", code: "skill_output_kind_conflict", skill: { name: "promo-poster" } }),
      tool("compose_skills", { status: "conflict", code: "competing_domain", names: ["a"] }),
      // A loaded receipt with no body is not a read either.
      tool("use_skill", { status: "loaded", skill: { name: "promo-poster" } }),
    ] });
    expect(record.summary.matchedSkillNames).toBeUndefined();
    // The calls are still counted: the summary reports what happened.
    expect(record.summary.toolUsageCounts).toEqual({ use_skill: 3, compose_skills: 1 });
  });

  it("reports an absent detected intent as absent, not as non_design", () => {
    const record = build({ contentBlocks: [text("你好呀")] });
    expect(record.detectedIntent).toBeNull();
    expect(record.summary.intent).toBeUndefined();
    const { summary, detail } = formatDesignTurnRecord(record);
    expect(summary).toContain("检测到「未判定（本轮没有路由结论）」");
    expect(detail).toContain("检测层：本轮没有路由结论");
    expect(summary).not.toContain("非设计执行");
  });

  it("keeps every reported id bounded and deduplicated", () => {
    const record = build({ contentBlocks: [
      tool("generate_image", jobReceipt("job-1", "asset-1")),
      tool("generate_image", jobReceipt("job-1", "asset-1")),
      tool("edit_image", jobReceipt("job-2", "asset-2")),
      ...Array.from({ length: 12 }, (_value, index) => tool("generate_image", jobReceipt(`job-extra-${index}`))),
    ] });
    expect(record.summary.executionJobIds.length).toBeLessThanOrEqual(8);
    expect(new Set(record.summary.executionJobIds).size).toBe(record.summary.executionJobIds.length);
    expect(record.summary.executionJobIds).toContain("job-1");
  });

  it("bounds the display lines it hands to the wire", () => {
    const record = build({ contentBlocks: Array.from({ length: 40 }, (_value, index) =>
      tool(`tool_${String(index).padStart(3, "0")}`, { ok: true })) });
    const { summary, detail } = formatDesignTurnRecord(record);
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(detail?.length ?? 0).toBeLessThanOrEqual(400);
  });

  it("stays silent about submission in every display line of a refused turn", () => {
    const record = build({ contentBlocks: [tool("generate_image", refusalReceipt("image_context_unavailable"))] });
    const { summary, detail } = formatDesignTurnRecord(record);
    for (const line of [summary, detail]) {
      expect(line).not.toContain("已提交");
      expect(line).not.toContain("提交成功");
      expect(line).not.toContain("正在生成");
    }
  });
});
