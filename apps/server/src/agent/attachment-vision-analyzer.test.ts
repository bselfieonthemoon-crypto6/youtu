import { describe, expect, it, vi } from "vitest";

import { analyzeAgentVisionAttachments } from "./attachment-vision-analyzer.js";

describe("agent attachment vision preprocessing", () => {
  it("returns compact textual context from a no-tools model call", async () => {
    const generate = vi.fn(async (_input: unknown) => ({
      text: "粉色卡通吉祥物，文字为 aaaa.com。",
      usage: { inputTokens: null, outputTokens: null },
    }));
    const result = await analyzeAgentVisionAttachments({
      images: [{
        assetId: "asset-1",
        dataUri: "data:image/webp;base64,AAAA",
        name: "参考图",
      }],
      model: { generate } as never,
      prompt: "换一个图案",
    });

    expect(result).toBe("粉色卡通吉祥物，文字为 aaaa.com。");
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0]?.[0] as { user: string; images?: { dataUri: string }[] } | undefined;
    // The image is carried as a single media-type-qualified data URI; the
    // abstraction converts it to the strict `image_url` wire shape.
    expect(input?.images).toEqual([{ dataUri: "data:image/webp;base64,AAAA" }]);
    expect(input?.user).toContain("换一个图案");
  });

  it("rejects an empty vision response", async () => {
    await expect(analyzeAgentVisionAttachments({
      images: [{ assetId: "asset-1", dataUri: "data:image/webp;base64,AAAA" }],
      model: { generate: vi.fn(async () => ({ text: "", usage: {} })) } as never,
      prompt: "描述图片",
    })).rejects.toThrow("vision_analysis_empty");
  });

  it("uses a dedicated objective result-review prompt without reference-analysis instructions", async () => {
    const generate = vi.fn(async (_input: unknown) => ({
      text: '{"blockingIssues":[],"suggestions":[],"uncertainties":[]}',
      usage: { inputTokens: null, outputTokens: null },
    }));
    await analyzeAgentVisionAttachments({
      images: [{ assetId: "preview", dataUri: "data:image/webp;base64,AAAA" }],
      model: { generate } as never, prompt: "保留 Arial 和完整标题", purpose: "design_verification",
    });
    const input = generate.mock.calls[0]![0] as { user: string };
    expect(input.user).toContain("blockingIssues");
    expect(input.user).toContain("审美偏好");
    expect(input.user).toContain("不能从图像推断原始画布尺寸");
    expect(input.user).toContain("不等于最终可见背景");
    expect(input.user).toContain("authoritativeComparison");
    expect(input.user).not.toContain("为下游设计 Agent 准确提取参考图信息");
  });

  it("stays internal on the wire: no caller-supplied tags or chat config cross the boundary", async () => {
    const generate = vi.fn(async (_input: unknown) => ({ text: "ok", usage: {} }));
    await analyzeAgentVisionAttachments({
      images: [{ assetId: "asset-1", dataUri: "data:image/webp;base64,AAAA" }],
      model: { generate } as never, prompt: "描述图片",
    });
    // The retired LangChain adapter passed `tags: ["loomic-internal-vision"]`
    // so `stream-adapter.ts` could drop nested vision chat-model events. The AI
    // SDK path never joins the agent's stream, so the tags concept is gone and
    // the only argument is the generate input itself.
    expect(generate.mock.calls[0]).toHaveLength(1);
    expect(Object.keys(generate.mock.calls[0]![0] as object).sort())
      .toEqual(["images", "user"]);
  });
});
