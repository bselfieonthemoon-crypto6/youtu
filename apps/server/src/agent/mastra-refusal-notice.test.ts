import { describe, expect, it, vi } from "vitest";

import {
  appendImageRefusalCorrection,
  claimsSubmission,
  imageRefusalCorrection,
  refusalCorrectionId,
} from "./mastra-refusal-notice.js";

/**
 * The reproduced defect this fence closes: the tool refused 320×70 before any
 * submission (`image_approximation_not_authorized`, no job, nothing charged) and
 * the assistant still told the user it had been submitted. The refusal receipt
 * below is the exact `refusal()` shape from `mastra-image-tool.ts`.
 */
const refusalSummary =
  "本轮没有近似授权，不能把用户要求的比例改成其它比例。若目标比例超出 3:1/1:3，需要用户明确接受近似，或原话直接给出该像素尺寸（如 658×176）；未提交或扣费。";
const refusalReceipt = {
  status: "failed" as const,
  error: "image_approximation_not_authorized",
  summary: refusalSummary,
  refused: true as const,
};

const refusalBlock = (summary = refusalSummary) => ({
  type: "tool" as const,
  toolCallId: "call-1",
  toolName: "generate_image",
  status: "completed" as const,
  output: { ...refusalReceipt, summary },
});
const textBlock = (text: string) => ({ type: "text" as const, text });
const jobBlock = (toolName: "generate_image" | "edit_image" = "generate_image") => ({
  type: "tool" as const,
  toolCallId: "call-2",
  toolName,
  status: "completed" as const,
  output: { jobId: "job-1", status: "processing", jobType: "image_generation" },
});

describe("refusal correction derived from a run", () => {
  it("appends one correction with a run-derived id when a refused run claims submission", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const correction = imageRefusalCorrection({ runId,
      contentBlocks: [textBlock("好的，我这就处理。"), refusalBlock(), textBlock("已提交，正在生成，稍后告诉你结果。")] });

    expect(correction).toEqual({
      id: refusalCorrectionId(runId),
      text: `本轮没有提交任何生成任务，也没有扣费；${refusalSummary}`,
    });
  });

  it("states nothing was submitted for every claim phrasing, including an edit refusal", () => {
    for (const claim of ["已提交。", "已经创建任务了。", "正在出图，请稍等。", "任务正在排队中。", "图片已生成。", "稍后通知你。"]) {
      const correction = imageRefusalCorrection({ runId: "run",
        contentBlocks: [{ ...refusalBlock(), toolName: "edit_image" }, textBlock(claim)] });
      expect(correction?.text, claim).toBe(`本轮没有提交任何生成任务，也没有扣费；${refusalSummary}`);
    }
  });

  it("never corrects an honest refusal reply", () => {
    for (const honest of [
      "本轮没有提交，因为该比例超出可提交范围；也未扣费。",
      "工具拒绝了这次请求，我没有创建任务，也没有扣费。",
      "未提交任何生成任务：320×70 需要你明确接受近似尺寸。",
      "没有正在生成的任务，本轮什么都没提交。",
    ]) {
      expect(claimsSubmission(honest), honest).toBe(false);
      expect(imageRefusalCorrection({ runId: "run", contentBlocks: [refusalBlock(), textBlock(honest)] }), honest)
        .toBeNull();
    }
  });

  it("never corrects a run that created a job, even when another call was refused", () => {
    expect(imageRefusalCorrection({ runId: "run",
      contentBlocks: [refusalBlock(), jobBlock(), textBlock("已提交，正在生成。")] })).toBeNull();
    expect(imageRefusalCorrection({ runId: "run",
      contentBlocks: [jobBlock("edit_image"), textBlock("已提交，正在生成。")] })).toBeNull();
  });

  it("never corrects a text-only turn or a run with no image refusal", () => {
    expect(imageRefusalCorrection({ runId: "run", contentBlocks: [textBlock("已提交，正在生成。")] })).toBeNull();
    expect(imageRefusalCorrection({ runId: "run", contentBlocks: [
      { type: "tool", toolCallId: "c", toolName: "list_skills", status: "completed", output: { ok: true } },
      textBlock("已提交，正在生成。"),
    ] })).toBeNull();
  });

  it("never asserts 'nothing was submitted' when a receipt may already own a durable task", () => {
    // The unknown-transport receipt is deliberately not a refusal: an attempt was
    // made, so claiming nothing was created would be a new false statement.
    expect(imageRefusalCorrection({ runId: "run", contentBlocks: [
      refusalBlock(),
      { type: "tool", toolCallId: "c", toolName: "generate_image", status: "completed",
        output: { status: "unknown", error: "image_submission_unknown", summary: "图片提交状态未知。" } },
      textBlock("已提交，正在生成。"),
    ] })).toBeNull();
  });

  it("reads the run's final text, not an earlier line", () => {
    // The promise came first, the truth came last: the persisted message is true.
    expect(imageRefusalCorrection({ runId: "run",
      contentBlocks: [textBlock("我马上提交。"), refusalBlock(), textBlock("没有提交，工具拒绝了该比例。")] })).toBeNull();
    // The truth came first and the promise last: the last thing read is false.
    expect(imageRefusalCorrection({ runId: "run",
      contentBlocks: [textBlock("我先检查一下。"), refusalBlock(), textBlock("已提交，正在生成。")] })?.text)
      .toContain("本轮没有提交任何生成任务");
  });

  it("derives a stable uuid id from the run id, never from the text", () => {
    const id = refusalCorrectionId("11111111-1111-4111-8111-111111111111");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(refusalCorrectionId("11111111-1111-4111-8111-111111111111")).toBe(id);
    expect(refusalCorrectionId("22222222-2222-4222-8222-222222222222")).not.toBe(id);
    // The same run and the same receipt always produce the same row.
    const blocks = [refusalBlock(), textBlock("已提交。")];
    expect(imageRefusalCorrection({ runId: "run-a", contentBlocks: blocks }))
      .toEqual(imageRefusalCorrection({ runId: "run-a", contentBlocks: blocks }));
  });
});

describe("appending the refusal correction", () => {
  it("appends the correction once, as a new text message, and cannot append it twice", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const blocks = [refusalBlock(), textBlock("已提交，正在生成。")];
    // Models the chat_messages primary key: the run-derived id is the identity,
    // so a replay settles on the existing row instead of appending a second one.
    const rows = new Map<string, { id: string; role: string; content: string }>();
    const append = vi.fn(async (message: { id: string; role: "assistant"; content: string }) => {
      rows.set(message.id, message);
    });

    await expect(appendImageRefusalCorrection({ runId, contentBlocks: blocks, append })).resolves.toBe(true);
    await expect(appendImageRefusalCorrection({ runId, contentBlocks: blocks, append })).resolves.toBe(true);

    expect(append).toHaveBeenCalledTimes(2);
    expect([...rows.keys()]).toEqual([refusalCorrectionId(runId)]);
    expect([...rows.values()][0]).toMatchObject({ role: "assistant",
      content: `本轮没有提交任何生成任务，也没有扣费；${refusalSummary}` });
    expect(append.mock.calls[0]![0]).toMatchObject({
      contentBlocks: [{ type: "text", text: `本轮没有提交任何生成任务，也没有扣费；${refusalSummary}` }],
    });
  });

  it("writes nothing when the run's message is already true", async () => {
    const append = vi.fn(async () => undefined);
    await expect(appendImageRefusalCorrection({ runId: "run",
      contentBlocks: [refusalBlock(), textBlock("没有提交，工具拒绝了该比例。")], append })).resolves.toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});
