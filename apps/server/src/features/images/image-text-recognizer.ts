import type { ServerEnv } from "../../config/env.js";
import { createWorkspaceVisionModel } from "../../agent/workspace-vision-model.js";

export type ImageTextRecognizer = {
  recognize(input: { buffer: Buffer; mimeType: string }): Promise<string[]>;
};

/** OCR is a bounded single-image extraction task, not a chat turn. */
const OCR_MODEL = "deepseek-v4-flash-vision-exp";
const OCR_MAX_OUTPUT_TOKENS = 1_000;
const OCR_SYSTEM = "You are a precise OCR engine. Return JSON only, with no markdown or explanation.";
const OCR_USER = "Read every visible text fragment in this image in natural visual order. Preserve exact spelling, capitalization and punctuation. Ignore purely decorative shapes. Return exactly: {\"texts\":[\"first\",\"second\"]}. Return an empty array when there is no text.";

export function createImageTextRecognizer(env: ServerEnv): ImageTextRecognizer {
  return {
    async recognize({ buffer, mimeType }) {
      if (!env.apiYiApiKey) {
        const error = new Error("Image text recognition is not configured.");
        (error as Error & { code?: string }).code = "vision_not_configured";
        throw error;
      }
      // Built per call: the OCR channel has no per-run snapshot, and the model
      // carries no cross-call state. `baseUrl` still goes through
      // createSafeProviderFetch inside the abstraction.
      const model = createWorkspaceVisionModel({
        apiKey: env.apiYiApiKey,
        baseUrl: env.apiYiApiBase ?? "https://api.apiyi.com/v1",
        upstreamModelId: OCR_MODEL,
      }, { temperature: 0 });
      const response = await model.generate({
        system: OCR_SYSTEM,
        user: OCR_USER,
        images: [{ dataUri: `data:${mimeType};base64,${buffer.toString("base64")}` }],
        maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
      });
      return parseRecognizedTexts(response.text);
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
