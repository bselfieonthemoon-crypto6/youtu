import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { ServerEnv } from "../../config/env.js";
import { OpenAICompatibleChatModel } from "../../agent/openai-compatible-chat-model.js";

export type ImageTextRecognizer = {
  recognize(input: { buffer: Buffer; mimeType: string }): Promise<string[]>;
};

export function createImageTextRecognizer(env: ServerEnv): ImageTextRecognizer {
  return {
    async recognize({ buffer, mimeType }) {
      if (!env.apiYiApiKey) {
        const error = new Error("Image text recognition is not configured.");
        (error as Error & { code?: string }).code = "vision_not_configured";
        throw error;
      }
      const model = new OpenAICompatibleChatModel({
        model: "deepseek-v4-flash-vision-exp",
        apiKey: env.apiYiApiKey,
        configuration: {
          baseURL: env.apiYiApiBase ?? "https://api.apiyi.com/v1",
        },
        streaming: false,
        temperature: 0,
        maxTokens: 1_000,
      });
      const response = await model.invoke([
        new SystemMessage(
          "You are a precise OCR engine. Return JSON only, with no markdown or explanation.",
        ),
        new HumanMessage({
          content: [
            {
              type: "text",
              text: "Read every visible text fragment in this image in natural visual order. Preserve exact spelling, capitalization and punctuation. Ignore purely decorative shapes. Return exactly: {\"texts\":[\"first\",\"second\"]}. Return an empty array when there is no text.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${buffer.toString("base64")}`,
              },
            },
          ],
        }),
      ]);
      return parseRecognizedTexts(response.content);
    },
  };
}

export function parseRecognizedTexts(content: unknown): string[] {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
      : "";
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    const parsed = JSON.parse(candidate.trim()) as { texts?: unknown };
    if (!Array.isArray(parsed.texts)) return [];
    return [...new Set(parsed.texts
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean))].slice(0, 30);
  } catch {
    return [];
  }
}
