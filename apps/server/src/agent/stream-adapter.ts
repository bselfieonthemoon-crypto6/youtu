import type {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
} from "@langchain/core/messages";
import {
  AIMessageChunk as AIMessageChunkClass,
  AIMessage as AIMessageClass,
  ToolMessage as ToolMessageClass,
} from "@langchain/core/messages";

import { imageArtifactSchema, videoArtifactSchema } from "@loomic/shared";
import type { PlanStep, StreamEvent, ToolArtifact } from "@loomic/shared";

import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";

/**
 * Shape of a LangChain v2 stream event from `streamEvents()`.
 */
type LangChainStreamEvent = {
  event: string;
  name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  run_id?: string;
  tags?: string[];
};

type AdaptDeepAgentStreamOptions = {
  conversationId: string;
  now?: () => string;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  stream: AsyncIterable<LangChainStreamEvent | unknown>;
};

/**
 * Sub-agent parent tool names whose inner tools should have their
 * artifacts suppressed (the parent re-emits them with placement).
 */
const SUB_AGENT_PARENT_TOOLS = new Set(["video_generate"]);
/** Inner tools that may be suppressed when running inside a sub-agent. */
const INNER_SUB_AGENT_TOOLS = new Set(["generate_video"]);

export async function* adaptDeepAgentStream(
  options: AdaptDeepAgentStreamOptions,
): AsyncGenerator<StreamEvent> {
  const now = options.now ?? (() => new Date().toISOString());
  const seenCompletedToolCalls = new Set<string>();
  const seenFailedToolCalls = new Set<string>();
  const seenStreamedMessageIds = new Set<string>();
  const seenStartedToolCalls = new Set<string>();
  const planId = `plan_${options.runId}`;
  let planRevision = 0;
  let nextPlanStepOrdinal = 1;
  let committedPlanSteps: PlanStep[] = [];
  const pendingPlanDrafts = new Map<string, PlanStepDraft[]>();
  const planLinkByToolCall = new Map<
    string,
    { planId: string; planStepId: string }
  >();
  /** Tracks active sub-agent parent runs so we can detect nested inner tools. */
  const activeSubAgentRuns = new Set<string>();

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

      // Per-token streaming from the chat model
      if (evt.event === "on_chat_model_stream") {
        const chunk = evt.data?.chunk;
        if (!chunk) continue;

        // Skip chunks that are tool calls (no text to emit)
        if (
          AIMessageChunkClass.isInstance(chunk) ||
          AIMessageClass.isInstance(chunk)
        ) {
          const msg = chunk as AIMessageChunk | AIMessage;
          if ((msg.tool_calls?.length ?? 0) > 0) continue;
        }

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

        if (
          AIMessageClass.isInstance(output) ||
          AIMessageChunkClass.isInstance(output)
        ) {
          const msg = output as AIMessage | AIMessageChunk;
          const messageId = msg.id ?? `message_${options.runId}`;

          // Skip if this was a tool call message (tool lifecycle via on_tool_*)
          if ((msg.tool_calls?.length ?? 0) > 0) continue;
          if (seenStreamedMessageIds.has(messageId)) continue;

          const delta = extractChunkText(msg);
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

        // DeepAgents exposes its execution plan through the built-in
        // write_todos tool. Stage the candidate here, then publish it only
        // after the matching successful tool end.
        if (toolName === "write_todos") {
          const drafts = readPlanDrafts(toolInput);
          if (drafts) pendingPlanDrafts.set(toolCallId, drafts);
          continue;
        }

        // Track sub-agent parent tools so we can detect nested inner calls.
        if (SUB_AGENT_PARENT_TOOLS.has(toolName)) {
          activeSubAgentRuns.add(toolCallId);
        }

        const planLink = getUniqueInProgressPlanLink(
          planId,
          committedPlanSteps,
        );
        if (planLink) planLinkByToolCall.set(toolCallId, planLink);

        yield {
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          ...(toolInput ? { input: toolInput } : {}),
          ...(planLink ?? {}),
          type: "tool.started",
        };
        continue;
      }

      // Tool execution completed
      if (evt.event === "on_tool_error") {
        const toolName = evt.name ?? "unknown_tool";
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;
        if (toolName === "write_todos") {
          pendingPlanDrafts.delete(toolCallId);
          continue;
        }
        if (
          seenFailedToolCalls.has(toolCallId) ||
          seenCompletedToolCalls.has(toolCallId)
        ) continue;
        seenFailedToolCalls.add(toolCallId);
        const planLink = planLinkByToolCall.get(toolCallId);

        yield {
          type: "tool.failed",
          runId: options.runId,
          toolCallId,
          toolName,
          error: {
            code: "tool_failed",
            message: sanitizeErrorForClient(evt.data?.error),
          },
          ...(planLink ?? {}),
          timestamp: now(),
        };
        planLinkByToolCall.delete(toolCallId);
        continue;
      }

      // Tool execution completed
      if (evt.event === "on_tool_end") {
        const toolName = evt.name ?? "unknown_tool";
        // Use run_id for consistent pairing with on_tool_start
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;

        if (toolName === "write_todos") {
          const drafts = pendingPlanDrafts.get(toolCallId);
          pendingPlanDrafts.delete(toolCallId);
          if (drafts) {
            committedPlanSteps = reconcilePlanSteps(
              committedPlanSteps,
              drafts,
              () => `step_${nextPlanStepOrdinal++}`,
            );
            planRevision += 1;
            yield {
              type: "plan.updated",
              runId: options.runId,
              planId,
              revision: planRevision,
              timestamp: now(),
              steps: committedPlanSteps,
            } satisfies StreamEvent;
          }
          continue;
        }

        if (
          seenCompletedToolCalls.has(toolCallId) ||
          seenFailedToolCalls.has(toolCallId)
        ) continue;
        seenCompletedToolCalls.add(toolCallId);
        const planLink = planLinkByToolCall.get(toolCallId);

        const output = evt.data?.output;

        // When an inner tool runs inside an active sub-agent parent,
        // suppress its artifacts because the parent will re-emit them.
        const isNestedInSubAgent =
          INNER_SUB_AGENT_TOOLS.has(toolName) && activeSubAgentRuns.size > 0;
        const extractedArtifacts = isNestedInSubAgent ? undefined : extractArtifacts(output);
        const extractedOutput = extractOutput(output, (extractedArtifacts?.length ?? 0) > 0);
        yield {
          output: extractedOutput,
          outputSummary: summarizeOutput(output),
          artifacts: extractedArtifacts,
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          ...(planLink ?? {}),
          type: "tool.completed",
        };
        planLinkByToolCall.delete(toolCallId);

        // Clean up sub-agent parent tracking after its tool.completed is emitted.
        if (SUB_AGENT_PARENT_TOOLS.has(toolName)) {
          activeSubAgentRuns.delete(toolCallId);
        }

        if (toolName === "manipulate_canvas") {
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

    // Log full error detail server-side
    console.error(
      `[stream-adapter] Stream error for run ${options.runId}:`,
      error,
    );

    yield {
      error: {
        code: "run_failed",
        message: sanitizeErrorForClient(error),
      },
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

type PlanStepDraft = {
  explicitId?: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
};

function readPlanDrafts(
  input: Record<string, unknown> | undefined,
): PlanStepDraft[] | null {
  if (!input || !Array.isArray(input.todos)) return null;

  const steps: PlanStepDraft[] = [];

  for (const todo of input.todos) {
    if (!todo || typeof todo !== "object" || Array.isArray(todo)) continue;
    const item = todo as Record<string, unknown>;
    const title = typeof item.content === "string" ? item.content.trim() : "";
    if (!title || !isTodoStatus(item.status)) continue;

    steps.push({
      ...(typeof item.id === "string" && item.id.trim()
        ? { explicitId: item.id.trim() }
        : {}),
      title,
      status: item.status,
    });
  }

  return steps;
}

function reconcilePlanSteps(
  previous: PlanStep[],
  drafts: PlanStepDraft[],
  nextId: () => string,
): PlanStep[] {
  const previousByTitle = groupByNormalizedTitle(previous);
  const currentTitleCounts = countValues(
    drafts.map((draft) => normalizePlanTitle(draft.title)),
  );
  const explicitIdCounts = countValues(
    drafts
      .map((draft) => draft.explicitId)
      .filter((id): id is string => id !== undefined),
  );
  const usedIds = new Set<string>();

  return drafts.map((draft) => {
    let id: string | undefined;
    if (
      draft.explicitId &&
      explicitIdCounts.get(draft.explicitId) === 1
    ) {
      const explicitCandidate = `todo_${draft.explicitId}`;
      if (!usedIds.has(explicitCandidate)) id = explicitCandidate;
    }

    if (!id) {
      const titleKey = normalizePlanTitle(draft.title);
      const previousMatches = previousByTitle.get(titleKey) ?? [];
      if (
        currentTitleCounts.get(titleKey) === 1 &&
        previousMatches.length === 1 &&
        !usedIds.has(previousMatches[0]!.id)
      ) {
        id = previousMatches[0]!.id;
      }
    }

    while (!id || usedIds.has(id)) id = nextId();
    usedIds.add(id);
    return { id, title: draft.title, status: draft.status };
  });
}

function getUniqueInProgressPlanLink(
  planId: string,
  steps: PlanStep[],
): { planId: string; planStepId: string } | undefined {
  const active = steps.filter((step) => step.status === "in_progress");
  return active.length === 1
    ? { planId, planStepId: active[0]!.id }
    : undefined;
}

function groupByNormalizedTitle(steps: PlanStep[]): Map<string, PlanStep[]> {
  const result = new Map<string, PlanStep[]>();
  for (const step of steps) {
    const key = normalizePlanTitle(step.title);
    result.set(key, [...(result.get(key) ?? []), step]);
  }
  return result;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function normalizePlanTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

function isTodoStatus(
  value: unknown,
): value is "pending" | "in_progress" | "completed" {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed"
  );
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

function extractOutput(
  output: unknown,
  hasArtifacts: boolean,
): Record<string, unknown> | undefined {
  let text = "";
  if (ToolMessageClass.isInstance(output)) {
    text = extractChunkText(output);
  } else if (typeof output === "string") {
    text = output;
  } else if (output && typeof output === "object") {
    text = JSON.stringify(output);
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

  // Size limit check
  const serialized = JSON.stringify(result);
  if (serialized.length > OUTPUT_SIZE_LIMIT) return undefined;

  return result;
}

function extractArtifacts(output: unknown): ToolArtifact[] | undefined {
  let text = "";
  if (ToolMessageClass.isInstance(output)) {
    text = extractChunkText(output);
  } else if (typeof output === "string") {
    text = output;
  } else if (output && typeof output === "object") {
    text = JSON.stringify(output);
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

  // AIMessageChunk / AIMessage with string content
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
  if (ToolMessageClass.isInstance(output)) {
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
    const serialized = JSON.stringify(output);
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

function isStreamEvent(value: unknown): value is LangChainStreamEvent {
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
