"use client";

import { useCallback } from "react";

import { clarificationRequestSchema, type ContentBlock, type StreamEvent, type ToolBlock } from "@loomic/shared";
import type { Message } from "./use-chat-sessions";
import { agentRunErrorMessage } from "../lib/agent-run-error";

type MessageUpdater = (
  targetSessionId: string,
  updater: (prev: Message[]) => Message[],
) => void;

/**
 * Extracts the stream event handling logic into a reusable hook.
 * Used by both the main send flow and the reconnection resume flow,
 * eliminating the ~70 lines of duplicated event-handling code.
 */
export function useChatStream(updateSessionMessages: MessageUpdater) {
  /**
   * Apply a single StreamEvent to the assistant message identified by assistantId
   * in the given session. This is the single source of truth for how events
   * mutate the message list.
   *
   * Edge case handling:
   * - Empty deltas are ignored to prevent unnecessary re-renders
   * - Missing assistantId in message list is tolerated (logged, not thrown)
   * - Duplicate tool.started events for the same toolCallId are safely deduplicated
   * - Unknown event types from newer server versions are silently ignored
   */
  const applyStreamEvent = useCallback(
    (event: StreamEvent, assistantId: string, sessionId: string) => {
      if (!assistantId || !sessionId) {
        console.warn("[chat-stream] applyStreamEvent called with missing ids:", {
          assistantId,
          sessionId,
          eventType: event.type,
        });
        return;
      }

      const update = (updater: (prev: Message[]) => Message[]) =>
        updateSessionMessages(sessionId, updater);

      // Plans are first-class stream state, not ordinary tool history. Replace
      // the matching plan in place so write_todos revisions do not produce a
      // long stack of stale plan cards.
      if ((event as { type: string }).type === "plan.updated") {
        const planEvent = event as unknown as {
          planId: string;
          revision: number;
          steps: Array<{
            id: string;
            title: string;
            status: "pending" | "in_progress" | "completed" | "failed";
          }>;
        };
        update((prev) =>
          prev.map((message) => {
            if (message.id !== assistantId) return message;
            const planBlock = {
              type: "plan" as const,
              planId: planEvent.planId,
              revision: planEvent.revision,
              steps: planEvent.steps,
            };
            const planIndex = message.contentBlocks.findIndex(
              (block) =>
                (block as { type: string }).type === "plan" &&
                (block as { planId?: string }).planId === planEvent.planId,
            );
            if (planIndex < 0) {
              return {
                ...message,
                contentBlocks: [
                  ...message.contentBlocks,
                  planBlock as unknown as ContentBlock,
                ],
              };
            }
            const blocks = [...message.contentBlocks];
            const currentRevision = (
              blocks[planIndex] as unknown as { revision?: number }
            ).revision ?? -1;
            if (currentRevision > planEvent.revision) return message;
            blocks[planIndex] = planBlock as unknown as ContentBlock;
            return { ...message, contentBlocks: blocks };
          }),
        );
        return;
      }

      switch (event.type) {
        case "message.delta": {
          // Skip truly empty deltas -- they cause unnecessary re-renders
          const delta = event.delta;
          if (delta === undefined || delta === null) break;

          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const blocks = [...m.contentBlocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") {
                blocks[blocks.length - 1] = {
                  ...last,
                  text: last.text + delta,
                };
              } else {
                blocks.push({ type: "text", text: delta });
              }
              return { ...m, contentBlocks: blocks };
            }),
          );
          break;
        }

        case "thinking.delta": {
          const delta = event.delta;
          if (delta === undefined || delta === null) break;

          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const blocks = [...m.contentBlocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "thinking") {
                blocks[blocks.length - 1] = {
                  ...last,
                  thinking: last.thinking + delta,
                };
              } else {
                blocks.push({ type: "thinking", thinking: delta });
              }
              return { ...m, contentBlocks: blocks };
            }),
          );
          break;
        }

        case "tool.started":
          {
          const relatedEvent = event as typeof event & {
            planId?: string;
            planStepId?: string;
          };
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              // Guard against duplicate tool.started events for the same toolCallId
              const alreadyExists = m.contentBlocks.some(
                (b) => b.type === "tool" && b.toolCallId === event.toolCallId,
              );
              if (alreadyExists) {
                console.warn("[chat-stream] duplicate tool.started for:", event.toolCallId);
                return m;
              }
              const newBlock: ToolBlock = {
                type: "tool",
                ...(event.toolExecutionId
                  ? { toolExecutionId: event.toolExecutionId }
                  : {}),
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: "running",
                ...(event.input ? { input: event.input } : {}),
                ...(event.retryable !== undefined
                  ? { retryable: event.retryable }
                  : {}),
                ...(relatedEvent.planId ? { planId: relatedEvent.planId } : {}),
                ...(relatedEvent.planStepId
                  ? { planStepId: relatedEvent.planStepId }
                  : {}),
              };
              return {
                ...m,
                contentBlocks: [...m.contentBlocks, newBlock],
              };
            }),
          );
          break;
          }

        case "tool.completed":
          {
          const relatedEvent = event as typeof event & {
            planId?: string;
            planStepId?: string;
          };
          publishAuthoritativeCreditBalance(event.output);
          const clarification = event.toolName === "ask_clarification"
            ? clarificationRequestSchema.safeParse(event.output)
            : null;
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const blocks = m.contentBlocks.map((block) => {
                if (
                  block.type === "tool" &&
                  block.toolCallId === event.toolCallId
                ) {
                  return {
                    ...block,
                    ...(event.toolExecutionId
                      ? { toolExecutionId: event.toolExecutionId }
                      : {}),
                    status: "completed" as const,
                    output: event.output,
                    outputSummary: event.outputSummary,
                    ...(event.artifacts
                      ? { artifacts: event.artifacts }
                      : {}),
                    ...(relatedEvent.planId ? { planId: relatedEvent.planId } : {}),
                    ...(relatedEvent.planStepId
                      ? { planStepId: relatedEvent.planStepId }
                      : {}),
                  };
                }
                return block;
              });
              if (clarification?.success && !blocks.some(block =>
                block.type === "clarification" && block.clarificationId === event.toolCallId)) {
                blocks.push({
                  type: "clarification",
                  version: 1,
                  clarificationId: event.toolCallId,
                  questions: clarification.data.questions,
                });
              }
              return {
                ...m,
                contentBlocks: blocks,
              };
            }),
          );
          break;
          }

        case "tool.failed":
          {
          const relatedEvent = event as typeof event & {
            planId?: string;
            planStepId?: string;
          };
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              return {
                ...m,
                contentBlocks: m.contentBlocks.map((block) =>
                  block.type === "tool" && block.toolCallId === event.toolCallId
                    ? {
                        ...block,
                        ...(event.toolExecutionId
                          ? { toolExecutionId: event.toolExecutionId }
                          : {}),
                        status: "failed" as const,
                        outputSummary: event.error.message,
                        ...(relatedEvent.planId ? { planId: relatedEvent.planId } : {}),
                        ...(relatedEvent.planStepId
                          ? { planStepId: relatedEvent.planStepId }
                          : {}),
                      }
                    : block,
                ),
              };
            }),
          );
          break;
          }

        case "run.failed": {
          const failureMessage = agentRunErrorMessage(event.error);
          console.error("[chat-stream] run.failed:", { code: event.error.code, reasonCode: event.error.details?.reasonCode, message: failureMessage });
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              // Mark all running tool blocks as completed so spinners stop
              const blocks = m.contentBlocks.map((block) =>
                block.type === "tool" && block.status === "running"
                  ? {
                      ...block,
                      status: "failed" as const,
                      outputSummary: "处理失败",
                    }
                  : block,
              );
              // Preserve partial useful text but never hide the terminal error.
              // A replay after reconnect must not append the same notice twice.
              const alreadyShown = blocks.some((b) => b.type === "text" && b.text === failureMessage);
              return {
                ...m,
                contentBlocks: alreadyShown
                  ? blocks
                  : [
                      ...blocks,
                      {
                        type: "text" as const,
                        text: failureMessage,
                      },
                    ],
              };
            }),
          );
          break;
        }

        case "run.canceled":
          // Clean up running tool blocks when run is aborted (e.g. billing error)
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const hasRunning = m.contentBlocks.some(
                (b) => b.type === "tool" && b.status === "running",
              );
              if (!hasRunning) return m;
              return {
                ...m,
                contentBlocks: m.contentBlocks.map((block) =>
                  block.type === "tool" && block.status === "running"
                    ? {
                        ...block,
                        status: "canceled" as const,
                        outputSummary: "已取消",
                      }
                    : block,
                ),
              };
            }),
          );
          break;

        default:
          // Unknown event types are silently ignored -- new event types may be
          // added server-side before the frontend is updated
          break;
      }
    },
    [updateSessionMessages],
  );

  return { applyStreamEvent };
}

function publishAuthoritativeCreditBalance(
  output: Record<string, unknown> | undefined,
) {
  if (typeof window === "undefined" || !output) return;
  const billing = output.billing;
  if (!billing || typeof billing !== "object" || Array.isArray(billing)) return;
  const balanceAfter = (billing as Record<string, unknown>).balanceAfter;
  if (typeof balanceAfter !== "number" || !Number.isFinite(balanceAfter)) return;
  window.dispatchEvent(
    new CustomEvent("loomic:credits-updated", {
      detail: { balance: balanceAfter },
    }),
  );
}
