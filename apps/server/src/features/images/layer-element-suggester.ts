import type { ServerEnv } from "../../config/env.js";
import { createSafeProviderFetch } from "../../security/safe-provider-fetch.js";

export type LayerElementSuggester = {
  /**
   * Names for the elements a generative layer split should extract. One paid
   * vision call; the image split itself is quoted separately per element.
   */
  suggest(input: { buffer: Buffer; mimeType: string }): Promise<string[]>;
};

/** Naming the elements of one still image is a bounded single-image task. */
const SUGGEST_MODEL = "deepseek-v4-flash-vision-exp";
// The workspace's published text model is a reasoning model: the upstream
// `deepseek-flash` spent 2 000-2 200 reasoning tokens on this listing before
// emitting a ~30-token answer, so a small cap truncates it into empty content
// (finish_reason "length"). The budget therefore has to cover the deliberation,
// not the answer. Verified against the real provider on 2026-09-19.
const SUGGEST_MAX_OUTPUT_TOKENS = 4_000;
/** A listing is a single bounded call; the user is waiting on the toolbar. */
const LISTING_TIMEOUT_MS = 120_000;
const MAX_ELEMENTS = 4;
const MIN_ELEMENTS = 2;
const MAX_NAME_LENGTH = 40;
// Exported so the acceptance harness can reproduce the exact same request and
// inspect what the model actually answered when a listing comes back unusable.
export const LAYER_ELEMENT_SYSTEM_PROMPT = "You return JSON only, with no markdown, no explanation and no deliberation.";
// Short on purpose: every extra rule is extra reasoning the model performs before
// answering, and reasoning tokens are what the budget has to survive.
export const LAYER_ELEMENT_USER_PROMPT = [
  `列出这张图里适合拆成独立透明图层的 ${MIN_ELEMENTS} 到 ${MAX_ELEMENTS} 个元素，按重要程度排序。`,
  "每个名字用简短具体的中文写清内容和位置，例如 左下角人物、标题文字。",
  "不要用 元素、图层、背景、前景 这类泛称，不要列出整张图。",
  `只输出 {"elements":["名字","名字"]}。`,
].join("");

export function createLayerElementSuggester(env: ServerEnv): LayerElementSuggester {
  return {
    async suggest({ buffer, mimeType }) {
      if (!env.apiYiApiKey) {
        const error = new Error("Layer element suggestion is not configured.");
        (error as Error & { code?: string }).code = "vision_not_configured";
        throw error;
      }
      // Deliberately a direct, confined request rather than the shared vision
      // adapter. Measured against this gateway on 2026-09-19 with the exact same
      // prompt and model: the adapter's `{type:"file"}` image part produced
      // finish_reason "stop" with EMPTY content, while this OpenAI-shaped
      // `image_url` part returned the expected JSON. The transport confinement is
      // unchanged — createSafeProviderFetch is still the only outbound path — and
      // the listing needs a 4 000-token generation reserve, which the adapter's
      // frozen context budget cannot express for a caller that has no run
      // snapshot. See docs/layer-element-listing-20260919.md for the evidence.
      const baseUrl = (env.apiYiApiBase ?? "https://api.apiyi.com/v1").replace(/\/$/, "");
      const response = await createSafeProviderFetch(baseUrl)(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.apiYiApiKey}` },
        body: JSON.stringify({
          model: SUGGEST_MODEL,
          max_tokens: SUGGEST_MAX_OUTPUT_TOKENS,
          temperature: 0,
          messages: [
            { role: "system", content: LAYER_ELEMENT_SYSTEM_PROMPT },
            { role: "user", content: [
              { type: "text", text: LAYER_ELEMENT_USER_PROMPT },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
            ] },
          ],
        }),
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
      });
      if (!response.ok) {
        const error = new Error(`The element listing provider answered HTTP ${response.status}.`);
        (error as Error & { code?: string }).code = "layer_elements_unavailable";
        throw error;
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const text = body.choices?.[0]?.message?.content;
      const elements = parseSuggestedLayerElements(text);
      // Too few names cannot drive a split (one name is the box flow), and a
      // silently padded list would extract an element the user never asked for.
      if (elements.length < MIN_ELEMENTS) {
        // A failed listing is otherwise invisible: log what the model said, so an
        // unusable answer can be diagnosed from the API log instead of re-running
        // the paid call to find out.
        console.warn("[layer-elements] unusable listing", {
          parsed: elements.length,
          raw: typeof text === "string" ? text.slice(0, 600) : text,
        });
        const error = new Error(`The model returned ${elements.length} usable element name(s).`);
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
