import {
  isAssistantStreamMessage,
  isToolResultEnvelope,
} from "./agent-message-shapes.js";

import { imageArtifactSchema, videoArtifactSchema } from "@loomic/shared";
import type { StreamEvent, ToolArtifact } from "@loomic/shared";

import { sanitizeErrorForClient, sanitizeRunErrorForClient } from "../utils/error-sanitizer.js";

/**
 * Shape of a v2-style agent stream event yielded by the Mastra bridge
 * (`mastra-agent.ts`): `on_chat_model_*`, `on_tool_*` and `on_custom_event`.
 * This is a Loomic-local envelope, not a LangChain type.
 */
type AgentStreamEvent = {
  event: string;
  name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  run_id?: string;
  tags?: string[];
};

type AdaptAgentStreamOptions = {
  conversationId: string;
  now?: () => string;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  stream: AsyncIterable<AgentStreamEvent | unknown>;
};

export async function* adaptAgentStream(
  options: AdaptAgentStreamOptions,
): AsyncGenerator<StreamEvent> {
  const now = options.now ?? (() => new Date().toISOString());
  const seenCompletedToolCalls = new Set<string>();
  const seenFailedToolCalls = new Set<string>();
  const seenStreamedMessageIds = new Set<string>();
  const seenStartedToolCalls = new Set<string>();

  yield {
    conversationId: options.conversationId,
    runId: options.runId,
    sessionId: options.sessionId,
    timestamp: now(),
    type: "run.started",
  };

  if (options.signal?.aborted) {
    yield canceledEvent(options.runId, now);
    return;
  }

  try {
    for await (const rawEvent of options.stream) {
      if (options.signal?.aborted) {
        yield canceledEvent(options.runId, now);
        return;
      }

      if (!isStreamEvent(rawEvent)) {
        continue;
      }

      const evt = rawEvent;
      if (evt.tags?.includes("loomic-internal-expert")) continue;
      if (evt.tags?.some(tag => tag === "loomic-context-summary" || tag === "loomic-intent-review")) continue;
      // Vision preprocessing/review is a nested tool result, not the assistant's
      // final answer. Its text is shown inside the verification result only.
      if (evt.tags?.includes("loomic-internal-vision") && evt.event.startsWith("on_chat_model_")) continue;

      // A terminal image failure is closed by server middleware, not another
      // free-form model response. Its trusted receipt still needs to reach the
      // normal text/persistence path even though no model tokens are emitted.
      if (evt.event === "on_custom_event" && ["loomic.image_failure_receipt", "loomic.intent_clarification"].includes(evt.name ?? "")) {
        const messageId = evt.data?.messageId;
        const text = evt.data?.text;
        const prefix = evt.name === "loomic.intent_clarification" ? "intent-clarification-" : "image-failure-receipt-";
        if (typeof messageId !== "string" || !messageId.startsWith(prefix) ||
            typeof text !== "string" || !text.trim() || seenStreamedMessageIds.has(messageId)) continue;
        seenStreamedMessageIds.add(messageId);
        yield { type: "message.delta", runId: options.runId, timestamp: now(), messageId, delta: text };
        continue;
      }

      // A write denied by middleware never enters on_tool_start/on_tool_error.
      // Expose that outcome without leaking reviewer content or raw arguments.
      if (evt.event === "on_custom_event" && evt.name === "loomic.intent_write_blocked") {
        const id = readString(evt.data?.toolCallId);
        const toolName = readString(evt.data?.toolName);
        if (!id || !toolName) continue;
        const toolCallId = `intent-blocked-${id}`;
        if (seenFailedToolCalls.has(toolCallId)) continue;
        seenFailedToolCalls.add(toolCallId);
        yield { type: "tool.failed", runId: options.runId, timestamp: now(), toolCallId, toolName,
          error: { code: "tool_failed", message: "本次操作未执行：工具参数或目标未通过核对。" } };
        continue;
      }

      // Per-token streaming from the chat model
      if (evt.event === "on_chat_model_stream") {
        const chunk = evt.data?.chunk;
        if (!chunk) continue;

        // Skip chunks that are tool calls (no text to emit). Only a producer
        // branded assistant message can carry parsed tool calls, so a value
        // that merely happens to have a `content` field is never reclassified.
        if (
          isAssistantStreamMessage(chunk) &&
          (chunk.tool_calls?.length ?? 0) > 0
        ) continue;

        const messageId =
          (chunk as { id?: string }).id ?? `message_${options.runId}`;

        const content = (chunk as { content: unknown }).content;

        // Handle array content (e.g. Gemini thinking + text blocks)
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "thinking" &&
              "thinking" in part &&
              typeof part.thinking === "string" &&
              part.thinking
            ) {
              yield {
                type: "thinking.delta" as const,
                runId: options.runId,
                messageId,
                delta: part.thinking,
                timestamp: now(),
              };
            } else {
              const text =
                typeof part === "string"
                  ? part
                  : part &&
                      typeof part === "object" &&
                      "text" in part &&
                      typeof (part as { text: unknown }).text === "string"
                    ? (part as { text: string }).text
                    : "";
              if (text) {
                seenStreamedMessageIds.add(messageId);
                yield {
                  type: "message.delta" as const,
                  runId: options.runId,
                  messageId,
                  delta: text,
                  timestamp: now(),
                };
              }
            }
          }
          continue;
        }

        // String content (normal text)
        const delta = extractChunkText(chunk);
        if (!delta) continue;

        seenStreamedMessageIds.add(messageId);
        yield {
          delta,
          messageId,
          runId: options.runId,
          timestamp: now(),
          type: "message.delta",
        };
        continue;
      }

      // Fallback: complete message from non-streaming model (on_chat_model_end)
      if (evt.event === "on_chat_model_end") {
        const output = evt.data?.output;
        if (!output) continue;

        if (isAssistantStreamMessage(output)) {
          const messageId = output.id ?? `message_${options.runId}`;

          // Skip if this was a tool call message (tool lifecycle via on_tool_*)
          if ((output.tool_calls?.length ?? 0) > 0) continue;
          if (seenStreamedMessageIds.has(messageId)) continue;

          const delta = extractChunkText(output);
          if (!delta) continue;

          yield {
            delta,
            messageId,
            runId: options.runId,
            timestamp: now(),
            type: "message.delta",
          };
        }
        continue;
      }

      // Tool execution started
      if (evt.event === "on_tool_start") {
        const toolName = evt.name ?? "unknown_tool";
        // Use run_id as the tool call identifier for consistent start/end pairing
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;

        if (seenStartedToolCalls.has(toolCallId)) continue;
        seenStartedToolCalls.add(toolCallId);

        // Extract tool input arguments for frontend display
        const rawInput = evt.data?.input;
        const toolInput =
          rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
            ? (rawInput as Record<string, unknown>)
            : undefined;

        yield {
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          ...(toolInput ? { input: toolInput } : {}),
          type: "tool.started",
        };
        continue;
      }

      // Tool execution completed
      if (evt.event === "on_tool_error") {
        const toolName = evt.name ?? "unknown_tool";
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;
        if (
          seenFailedToolCalls.has(toolCallId) ||
          seenCompletedToolCalls.has(toolCallId)
        ) continue;
        seenFailedToolCalls.add(toolCallId);

        yield {
          type: "tool.failed",
          runId: options.runId,
          toolCallId,
          toolName,
          error: {
            code: "tool_failed",
            message: sanitizeErrorForClient(evt.data?.error),
          },
          timestamp: now(),
        };
        continue;
      }

      // Tool execution completed
      if (evt.event === "on_tool_end") {
        const toolName = evt.name ?? "unknown_tool";
        // Use run_id for consistent pairing with on_tool_start
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;

        if (
          seenCompletedToolCalls.has(toolCallId) ||
          seenFailedToolCalls.has(toolCallId)
        ) continue;
        seenCompletedToolCalls.add(toolCallId);

        const output = evt.data?.output;

        const extractedArtifacts = extractArtifacts(output);
        const extractedOutput = extractOutput(output, (extractedArtifacts?.length ?? 0) > 0);
        yield {
          output: extractedOutput,
          outputSummary: summarizeOutput(output),
          artifacts: extractedArtifacts,
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          type: "tool.completed",
        };

        if (toolName === "manipulate_canvas" || toolName === "create_design_boards") {
          yield {
            type: "canvas.sync" as const,
            runId: options.runId,
            timestamp: now(),
          } satisfies StreamEvent;
        }
        continue;
      }
    }
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      yield canceledEvent(options.runId, now);
      return;
    }

    const publicError = sanitizeRunErrorForClient(error);
    // Context failures can wrap raw source text; keep only stable public details.
    console.error(
      `[stream-adapter] Stream error for run ${options.runId}:`,
      publicError.details ? publicError : error,
    );

    yield {
      error: publicError,
      runId: options.runId,
      timestamp: now(),
      type: "run.failed",
    };
    return;
  }

  yield {
    runId: options.runId,
    timestamp: now(),
    type: "run.completed",
  };
}

function canceledEvent(runId: string, now: () => string): StreamEvent {
  return {
    runId,
    timestamp: now(),
    type: "run.canceled",
  };
}

/**
 * LangChain sub-agent tools return a Command object whose real payload
 * lives inside update.messages[0].kwargs.content (a JSON string).
 * Unwrap it so extractArtifacts can find url/placement at the top level.
 */
function unwrapCommandOutput(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record.lg_name !== "Command") return record;
  try {
    const messages = (record.update as any)?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return record;
    const content = messages[0]?.kwargs?.content ?? messages[0]?.content;
    if (typeof content !== "string") return record;
    const inner = JSON.parse(content);
    if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  } catch {
    // fall through
  }
  return record;
}

const ARTIFACT_KEYS = new Set([
  "url",
  "imageUrl",
  "screenshotUrl",
  "videoUrl",
  "durationSeconds",
  "mimeType",
  "width",
  "height",
  "placement",
]);
const OUTPUT_SIZE_LIMIT = 10240; // 10KB
/**
 * Bounding applied before the size limit gives up. A tool result that exceeds the
 * limit used to arrive with NO payload at all: `list_skills` (24.8KB for the 15
 * enabled packages) and a prompt-library search both reached the client and the
 * transcript as `{}`, so no UI card could render them and nothing was auditable —
 * while the model itself still saw the full result. Truncating structurally keeps
 * the entries and identifiers that make a result checkable.
 *
 * The stages are tried in order and the first one that fits wins, so a payload
 * only as large as it must be is shortened only as far as it must be.
 */
const OUTPUT_BOUNDING_STAGES = [
  { stringLimit: 400, arrayLimit: 16, keyLimit: 40 },
  { stringLimit: 240, arrayLimit: 8, keyLimit: 24 },
  { stringLimit: 120, arrayLimit: 4, keyLimit: 16 },
  { stringLimit: 60, arrayLimit: 2, keyLimit: 8 },
] as const;
const OUTPUT_DEPTH_LIMIT = 4;

/** Depth- and size-bounded copy of a tool payload; never throws on plain data. */
function boundPayload(
  value: unknown,
  stage: (typeof OUTPUT_BOUNDING_STAGES)[number],
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return value.length <= stage.stringLimit
      ? value
      : `${value.slice(0, stage.stringLimit)}…[truncated ${value.length - stage.stringLimit} chars]`;
  }
  if (Array.isArray(value)) {
    const kept = depth >= OUTPUT_DEPTH_LIMIT
      ? []
      : value.slice(0, stage.arrayLimit).map(entry => boundPayload(entry, stage, depth + 1));
    return value.length > kept.length
      ? [...kept, `…[truncated ${value.length - kept.length} entries]`]
      : kept;
  }
  if (value && typeof value === "object") {
    if (depth >= OUTPUT_DEPTH_LIMIT) return "[truncated: nesting too deep]";
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries.slice(0, stage.keyLimit)
      .map(([key, entry]) => [key, boundPayload(entry, stage, depth + 1)] as const);
    const result: Record<string, unknown> = Object.fromEntries(kept);
    if (entries.length > kept.length) result.truncatedKeys = entries.length - kept.length;
    return result;
  }
  return value;
}

/** A cyclic or otherwise non-serializable tool result must not fail the run. */
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text ?? "";
  } catch {
    return "";
  }
}

function extractOutput(
  output: unknown,
  hasArtifacts: boolean,
): Record<string, unknown> | undefined {
  let text = "";
  if (isToolResultEnvelope(output)) {
    text = extractChunkText(output);
  } else if (typeof output === "string") {
    text = output;
  } else if (output && typeof output === "object") {
    text = safeStringify(output);
  }

  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;

  const unwrapped = unwrapCommandOutput(parsed as Record<string, unknown>);

  // Strip artifact keys if artifacts were extracted
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unwrapped)) {
    if (hasArtifacts && ARTIFACT_KEYS.has(key)) continue;
    result[key] = value;
  }

  // Skip if empty after stripping
  if (Object.keys(result).length === 0) return undefined;

  // Size limit check: shorten a large payload instead of dropping it whole.
  if (JSON.stringify(result).length > OUTPUT_SIZE_LIMIT) {
    for (const stage of OUTPUT_BOUNDING_STAGES) {
      const bounded = boundPayload(result, stage) as Record<string, unknown>;
      const serialized = safeStringify(bounded);
      if (serialized && serialized.length <= OUTPUT_SIZE_LIMIT) return { ...bounded, truncated: true };
    }
    return undefined;
  }

  return result;
}

function extractArtifacts(output: unknown): ToolArtifact[] | undefined {
  let text = "";
  if (isToolResultEnvelope(output)) {
    text = extractChunkText(output);
  } else if (typeof output === "string") {
    text = output;
  } else if (output && typeof output === "object") {
    text = safeStringify(output);
  }

  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== "object") return undefined;

  // If this is a LangChain Command object (from sub-agent), dig into
  // update.messages[0].kwargs.content to find the real structured response.
  const unwrapped = unwrapCommandOutput(parsed as Record<string, unknown>);

  const artifacts: ToolArtifact[] = [];
  const record = unwrapped;

  // New format: sub-agent structured response with url + placement
  if (typeof record.url === "string" && record.url.length > 0) {
    const candidate: Record<string, unknown> = {
      type: "image" as const,
      url: record.url,
      mimeType: (record.mimeType as string) ?? "image/png",
      width: (record.placement as any)?.width ?? 512,
      height: (record.placement as any)?.height ?? 512,
    };
    if (typeof record.title === "string" && record.title.length > 0) {
      candidate.title = record.title;
    }
    if (record.placement && typeof record.placement === "object") {
      candidate.placement = record.placement;
    }
    const result = imageArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  // Legacy format: direct tool response with imageUrl
  if (artifacts.length === 0 && typeof record.imageUrl === "string") {
    const candidate: Record<string, unknown> = {
      type: "image" as const,
      url: record.imageUrl,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
    };
    if (typeof record.title === "string" && record.title.length > 0) {
      candidate.title = record.title;
    }
    if (record.placement && typeof record.placement === "object") {
      candidate.placement = record.placement;
    }
    const result = imageArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  // Screenshot format: tool response with screenshotUrl
  if (artifacts.length === 0 && typeof record.screenshotUrl === "string") {
    const candidate: Record<string, unknown> = {
      type: "image" as const,
      url: record.screenshotUrl,
      mimeType: "image/png",
      width: typeof record.width === "number" ? record.width : 1024,
      height: typeof record.height === "number" ? record.height : 1024,
    };
    const result = imageArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  // Video format: tool response with videoUrl from generate_video
  if (typeof record.videoUrl === "string" && record.videoUrl.length > 0) {
    const candidate: Record<string, unknown> = {
      type: "video" as const,
      url: record.videoUrl,
      mimeType: (record.mimeType as string) ?? "video/mp4",
      width: typeof record.width === "number" ? record.width : 1280,
      height: typeof record.height === "number" ? record.height : 720,
    };
    if (typeof record.durationSeconds === "number") {
      candidate.durationSeconds = record.durationSeconds;
    }
    // Prefer LLM-authored title, then original prompt, then technical summary
    if (typeof record.title === "string" && record.title.length > 0) {
      candidate.title = record.title.slice(0, 120);
    } else if (typeof record.prompt === "string") {
      candidate.title = record.prompt.slice(0, 200);
    } else if (typeof record.summary === "string") {
      candidate.title = record.summary.slice(0, 100);
    }
    if (record.placement && typeof record.placement === "object") {
      candidate.placement = record.placement;
    }
    const result = videoArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  return artifacts.length > 0 ? artifacts : undefined;
}

/**
 * Extract text from a chat model stream chunk.
 */
function extractChunkText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";

  // Text carried by an assistant chunk. This stays a field-level read: it
  // extracts text from whatever chunk the producer emitted and never decides
  // which message shape the value is.
  if ("content" in chunk) {
    const content = (chunk as { content: unknown }).content;
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }
          return "";
        })
        .join("");
    }
  }

  return "";
}

function summarizeOutput(output: unknown): string | undefined {
  if (isToolResultEnvelope(output)) {
    const textContent = extractChunkText(output);
    const parsed = tryParseJson(textContent);
    if (
      parsed &&
      typeof parsed === "object" &&
      "summary" in parsed &&
      typeof parsed.summary === "string"
    ) {
      return parsed.summary;
    }
    return textContent || undefined;
  }

  if (output && typeof output === "object") {
    const serialized = safeStringify(output);
    const parsed = tryParseJson(serialized);
    if (
      parsed &&
      typeof parsed === "object" &&
      "summary" in parsed &&
      typeof parsed.summary === "string"
    ) {
      return parsed.summary;
    }
    return serialized.length > 200
      ? `${serialized.slice(0, 197)}...`
      : serialized;
  }

  if (typeof output === "string") return output || undefined;
  return undefined;
}

function tryParseJson(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "This operation was aborted")
  );
}

function isStreamEvent(value: unknown): value is AgentStreamEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "event" in value &&
    typeof (value as { event: unknown }).event === "string"
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
