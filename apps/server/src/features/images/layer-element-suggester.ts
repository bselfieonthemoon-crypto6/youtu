import type { ServerEnv } from "../../config/env.js";
import { createWorkspaceVisionModel } from "../../agent/workspace-vision-model.js";

export type LayerElementSuggester = {
  /**
   * Names for the elements a generative layer split should extract. One paid
   * vision call; the image split itself is quoted separately per element.
   */
  suggest(input: { buffer: Buffer; mimeType: string }): Promise<string[]>;
};

/** Naming the elements of one still image is a bounded single-image task. */
const SUGGEST_MODEL = "deepseek-v4-flash-vision-exp";
const SUGGEST_MAX_OUTPUT_TOKENS = 600;
const MAX_ELEMENTS = 4;
const MIN_ELEMENTS = 2;
const MAX_NAME_LENGTH = 40;
const SUGGEST_SYSTEM = "You are an art director preparing a layered file. Return JSON only, with no markdown or explanation.";
const SUGGEST_USER = [
  "List the elements in this image that a designer would want on separate transparent layers.",
  `Return ${MIN_ELEMENTS} to ${MAX_ELEMENTS} of them, ordered from the most important deliverable to the least.`,
  "Typical candidates are the main subject, a separately recognizable product, a logo, a distinct headline text block, or a decoration that stands on its own.",
  "Name each one with short concrete Chinese words that identify both its content and its place, for example 左侧人物, 标题文字, 右下角金币.",
  "Never use generic names such as 元素, 图层, 背景 or 前景: the name is the instruction the extraction model receives, and the background is repaired separately.",
  "Do not list an element that is only part of another listed element, and do not list the whole image.",
  `Return exactly {"elements":["name","name"]}.`,
].join(" ");

export function createLayerElementSuggester(env: ServerEnv): LayerElementSuggester {
  return {
    async suggest({ buffer, mimeType }) {
      if (!env.apiYiApiKey) {
        const error = new Error("Layer element suggestion is not configured.");
        (error as Error & { code?: string }).code = "vision_not_configured";
        throw error;
      }
      // Built per call, exactly like the OCR channel: this task has no per-run
      // snapshot and the model keeps no cross-call state. `baseUrl` still goes
      // through createSafeProviderFetch inside the abstraction.
      const model = createWorkspaceVisionModel({
        apiKey: env.apiYiApiKey,
        baseUrl: env.apiYiApiBase ?? "https://api.apiyi.com/v1",
        upstreamModelId: SUGGEST_MODEL,
      }, { temperature: 0 });
      const response = await model.generate({
        system: SUGGEST_SYSTEM,
        user: SUGGEST_USER,
        images: [{ dataUri: `data:${mimeType};base64,${buffer.toString("base64")}` }],
        maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
      });
      const elements = parseSuggestedLayerElements(response.text);
      // Too few names cannot drive a split (one name is the box flow), and a
      // silently padded list would extract an element the user never asked for.
      if (elements.length < MIN_ELEMENTS) {
        const error = new Error("The model did not return enough separable elements.");
        (error as Error & { code?: string }).code = "layer_elements_unavailable";
        throw error;
      }
      return elements;
    },
  };
}

/** Defensive parse: the model's prose, markdown or extra fields never leak out. */
export function parseSuggestedLayerElements(content: unknown): string[] {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
      : "";
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    const parsed = JSON.parse(candidate.trim()) as { elements?: unknown };
    if (!Array.isArray(parsed.elements)) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of parsed.elements) {
      if (typeof item !== "string") continue;
      const name = item.trim().slice(0, MAX_NAME_LENGTH);
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length === MAX_ELEMENTS) break;
    }
    return names;
  } catch {
    return [];
  }
}
