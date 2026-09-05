import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import { analyzeAgentVisionAttachments } from "./attachment-vision-analyzer.js";

describe("agent attachment vision preprocessing", () => {
  it("returns compact textual context from a no-tools model call", async () => {
    const invoke = vi.fn(async (_messages: unknown[]) =>
      new AIMessage("粉色卡通吉祥物，文字为 aaaa.com。"));
    const result = await analyzeAgentVisionAttachments({
      images: [{
        assetId: "asset-1",
        dataUri: "data:image/webp;base64,AAAA",
        name: "参考图",
      }],
      model: { invoke } as never,
      prompt: "换一个图案",
    });

    expect(result).toBe("粉色卡通吉祥物，文字为 aaaa.com。");
    expect(invoke).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[0]?.[0] as Array<{ content: unknown }> | undefined;
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "image_url",
        image_url: { url: "data:image/webp;base64,AAAA" },
      }),
    ]));
  });

  it("rejects an empty vision response", async () => {
    await expect(analyzeAgentVisionAttachments({
      images: [{ assetId: "asset-1", dataUri: "data:image/webp;base64,AAAA" }],
      model: { invoke: vi.fn(async () => new AIMessage("")) } as never,
      prompt: "描述图片",
    })).rejects.toThrow("vision_analysis_empty");
  });
});
