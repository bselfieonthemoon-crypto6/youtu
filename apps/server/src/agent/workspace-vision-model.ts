import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { createSafeProviderFetch } from "../security/safe-provider-fetch.js";
import {
  assertContextBudget,
  createContextBudget,
  estimateContextTokens,
  resolveContextOperatingPolicy,
  type ContextBudget,
  type ContextModelOptions,
  type ContextModelProfile,
  type ContextTokenEstimate,
  type ContextUsageObservation,
} from "./context-budget.js";
import { prepareWorkspaceVisionTools } from "./provider-tool-schema.js";
import { withNormalizedAssistantRole } from "./provider-message-role.js";

/** The AI SDK language-model surface, inferred so no undeclared package is imported. */
type LanguageModel = ReturnType<OpenAICompatibleProvider["chatModel"]>;
/** The standardized wire prompt, taken from the model's own call signature. */
type WirePrompt = Parameters<LanguageModel["doGenerate"]>[0]["prompt"];

/**
 * A provider-agnostic text/vision call path on the AI SDK.
 *
 * Deliberately not a chat abstraction: every consumer of this module makes one
 * tool-free call and reads text back (`attachment-vision-analyzer`,
 * `image-result-verification`, `tools/screenshot-canvas`,
 * `tools/review-image-results`, `features/images/image-text-recognizer`).
 * A surface this small retires the LangChain model dependency without
 * inventing a second agent runtime.
 */
export type WorkspaceVisionImage = {
  /** `data:<media-type>;base64,<payload>`; the media type is read from here. */
  dataUri: string;
};

export type WorkspaceVisionGenerateInput = {
  system?: string;
  user: string;
  images?: WorkspaceVisionImage[];
  signal?: AbortSignal;
  /** Caller requirement; always capped to `budget.generationReserveTokens`. */
  maxOutputTokens?: number;
  /** Feeds `ContextUsageObservation.purpose`; defaults to "agent". */
  purpose?: ContextModelOptions["purpose"];
};

export type WorkspaceVisionUsage = {
  /** Null means the provider reported no usage; never a fabricated estimate. */
  inputTokens: number | null;
  outputTokens: number | null;
};

export type WorkspaceVisionModel = {
  /** Frozen budget/evidence this instance was built with. */
  readonly contextBudget: ContextBudget;
  generate(input: WorkspaceVisionGenerateInput): Promise<{ text: string; usage: WorkspaceVisionUsage }>;
};

export type WorkspaceVisionSnapshot = {
  apiKey: string;
  baseUrl: string;
  upstreamModelId: string;
  contextProfile?: ContextModelProfile;
};

/** Bounded observation history; optional so callers can inspect the guard. */
export type WorkspaceVisionUsageBuffer = {
  sequence: number;
  records: ContextUsageObservation[];
};

export type CreateWorkspaceVisionModelOptions = {
  temperature?: number;
  operatingPolicy?: ContextModelOptions["operatingPolicy"];
  onUsage?: ContextModelOptions["onUsage"];
  /** Shared across models so a caller can read one bounded usage history. */
  usageBuffer?: WorkspaceVisionUsageBuffer;
  /**
   * Provider tool schemas that would be sent on this channel. They are charged
   * by the final wire-level budget check exactly like the retired LangChain
   * adapter charged `invocationParams().tools`.
   */
  tools?: readonly unknown[];
  /**
   * Explicit transport injection for the opt-in live eval scripts. Production
   * callers must leave this undefined so `createSafeProviderFetch` stays the
   * only outbound path.
   *
   * An injected fetch REPLACES that boundary rather than wrapping it, matching
   * the retired adapter, which passed `configuration.fetch` straight through.
   * Callers that inject one must therefore already enforce their own endpoint,
   * method and payload confinement; `scripts/intent-live-model.ts` does.
   */
  fetch?: typeof fetch;
};

export function createWorkspaceVisionModel(
  snapshot: WorkspaceVisionSnapshot,
  options: CreateWorkspaceVisionModelOptions = {},
): WorkspaceVisionModel {
  const budget = createContextBudget(snapshot.contextProfile, resolveOperatingPolicyFor(snapshot, options));
  const guardedTools = prepareWorkspaceVisionTools(options.tools);
  const usageBuffer = options.usageBuffer ?? { sequence: 0, records: [] };
  const model: LanguageModel = createOpenAICompatible({
    name: "loomic-workspace-vision",
    baseURL: snapshot.baseUrl,
    apiKey: snapshot.apiKey,
    // SECURITY: origin/path-confined fetch remains the only outbound path. The
    // wrapper only repairs non-standard response roles; it never loosens the
    // confinement or DNS checks createSafeProviderFetch already performs.
    fetch: withNormalizedAssistantRole(options.fetch ?? createSafeProviderFetch(snapshot.baseUrl)),
    includeUsage: false,
  }).chatModel(snapshot.upstreamModelId);

  /** Record one observation into the bounded buffer and notify the caller. */
  const observe = (
    estimate: ContextTokenEstimate,
    phase: "preflight" | "completed",
    purpose: ContextModelOptions["purpose"],
    usage?: unknown,
  ): void => {
    const observation: ContextUsageObservation = Object.freeze({
      sequence: ++usageBuffer.sequence,
      purpose: purpose ?? "agent",
      ...estimate,
      phase,
      model: snapshot.upstreamModelId,
      budget,
      allowed: estimate.estimatedInputTokens <= budget.inputCeilingTokens,
      actualInputTokens: readActualToken(usage, "input_tokens"),
      actualOutputTokens: readActualToken(usage, "output_tokens"),
    });
    usageBuffer.records.push(observation);
    if (usageBuffer.records.length > 64) usageBuffer.records.splice(0, usageBuffer.records.length - 64);
    try {
      options.onUsage?.(observation);
    } catch {
      // Telemetry failure must never cause a successful paid call to be retried.
    }
  };

  return {
    contextBudget: budget,
    async generate(input) {
      const prompt = workspaceVisionWirePrompt(input);
      const maxOutputTokens = workspaceVisionOutputCap(input.maxOutputTokens, budget);
      // SAFETY: guard the exact object that goes on the wire, including any
      // bound tool schemas, before the provider is ever called.
      const estimate = estimateContextTokens(prompt, { tools: guardedTools }, snapshot.contextProfile);
      observe(estimate, "preflight", input.purpose);
      assertContextBudget(estimate, budget);

      const result = await model.doGenerate({
        prompt,
        maxOutputTokens,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      observe(estimate, "completed", input.purpose, wireUsage(result.usage));
      return {
        text: generatedText(result.content),
        usage: {
          inputTokens: result.usage.inputTokens.total ?? null,
          outputTokens: result.usage.outputTokens.total ?? null,
        },
      };
    },
  };
}

/**
 * A gateway alias must not inherit guessed OpenAI catalog capacity: only an
 * explicit administrator profile is trusted. `resolveContextOperatingPolicy`
 * supplies the documented lean policy for the lean model ids, and the
 * "extended output is opt-in by an actual caller requirement" rule lives in the
 * output cap below rather than being inferred from conversation length.
 */
function resolveOperatingPolicyFor(
  snapshot: WorkspaceVisionSnapshot,
  options: CreateWorkspaceVisionModelOptions,
): ContextModelOptions["operatingPolicy"] {
  return options.operatingPolicy ?? resolveContextOperatingPolicy(snapshot.upstreamModelId);
}

/**
 * Capped output request. An explicit caller requirement can never raise the
 * frozen generation reserve, and a missing requirement never lowers it.
 */
export function workspaceVisionOutputCap(requested: number | undefined, budget: ContextBudget): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.floor(Math.min(requested, budget.generationReserveTokens))
    : budget.generationReserveTokens;
}

/**
 * Build the exact wire-level prompt the provider serializes. Kept separate so
 * the budget guard and the real request can never diverge.
 */
/**
 * Build the exact wire-level prompt the provider serializes. Kept separate so
 * the budget guard and the real request can never diverge.
 */
export function workspaceVisionWirePrompt(input: WorkspaceVisionGenerateInput): WirePrompt {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "file"; data: { type: "url"; url: URL }; mediaType: string }
  > = [{ type: "text", text: input.user }];
  for (const image of input.images ?? []) {
    parts.push({
      type: "file",
      // The AI SDK provider turns this into `{ type: "image_url", image_url: { url } }`,
      // which is the strict shape APIYI DeepSeek Vision requires.
      data: { type: "url", url: new URL(image.dataUri) },
      mediaType: mediaTypeFromDataUri(image.dataUri),
    });
  }
  const messages: WirePrompt = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: parts });
  return messages;
}

/** `data:<type>/<subtype>[;params];base64,<payload>` -> `<type>/<subtype>`. */
function mediaTypeFromDataUri(dataUri: string): string {
  return /^data:([^;,]+)/i.exec(dataUri)?.[1] ?? "image/png";
}

/** Concatenate every generated text part; reasoning and tool calls are ignored. */
function generatedText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("");
}

/** Adapt AI SDK usage to the wire-level names the observation records. */
function wireUsage(usage: Awaited<ReturnType<LanguageModel["doGenerate"]>>["usage"]): Record<string, unknown> {
  return { input_tokens: usage.inputTokens.total, output_tokens: usage.outputTokens.total };
}

function readActualToken(usage: unknown, key: string): number | null {
  const record = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
