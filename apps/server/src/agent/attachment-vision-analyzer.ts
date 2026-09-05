import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { HumanMessage } from "@langchain/core/messages";

export type VisionInputImage = {
  assetId: string;
  dataUri: string;
  name?: string;
};

/**
 * Analyze reference images without binding the full DeepAgent tool catalog.
 * The returned text is safe to persist as conversation context; the original
 * image data stays in per-run runtime context for generation tools.
 */
export async function analyzeAgentVisionAttachments(input: {
  images: VisionInputImage[];
  model: BaseLanguageModel;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const imageList = input.images
    .map((image, index) => `${index + 1}. asset_id=${image.assetId}${image.name ? ` name=${image.name}` : ""}`)
    .join("\n");
  const message = new HumanMessage({
    content: [
      {
        type: "text" as const,
        text: [
          "你是图片理解预处理器。请为下游设计 Agent 准确提取参考图信息。",
          "逐图概括主体、构图、配色、风格、可见文字/OCR，并结合用户要求指出需要保留或修改的部分。",
          "只陈述图片事实与修改目标，不制定执行计划，不调用工具。总长度控制在 500 个中文字符以内。",
          `用户要求：${input.prompt}`,
          `图片清单：\n${imageList}`,
        ].join("\n"),
      },
      ...input.images.map((image) => ({
        type: "image_url" as const,
        // Use the strict OpenAI-compatible shape. Some providers accept a
        // plain string here, but APIYI DeepSeek Vision requires `{ url }`.
        image_url: { url: image.dataUri },
      })),
    ],
  });

  const response = await input.model.invoke(
    [message],
    input.signal ? { signal: input.signal } : undefined,
  );
  const text = extractMessageText(response.content).trim();
  if (!text) throw new Error("vision_analysis_empty");
  return text.slice(0, 2_000);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}
