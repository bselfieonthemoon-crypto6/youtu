import { setTimeout as delay } from "node:timers/promises";

import type { StreamEvent } from "@loomic/shared";

import type { MastraRunInput } from "./mastra-run-types.js";

type IntegrateMastraRunStreamOptions = {
  input: MastraRunInput;
  stream: AsyncIterable<StreamEvent>;
  eventDelayMs?: number;
  onEvent: (event: StreamEvent) => void | Promise<void>;
};

/**
 * Validate the framework boundary while leaving lifecycle persistence with the
 * existing run service.  A malformed or incomplete Mastra stream fails closed
 * instead of leaving a durable run stuck in `running`.
 */
export async function* integrateMastraRunStream(
  options: IntegrateMastraRunStreamOptions,
): AsyncGenerator<StreamEvent> {
  let started = false;
  const activeTools = new Map<string, string>();
  const settledTools = new Set<string>();

  for await (const event of options.stream) {
    // A terminal event that was already produced wins over a cancel race; only
    // mid-run events are discarded once the signal aborts.
    if (options.input.signal.aborted && event.type !== "run.canceled" && !isTerminalEvent(event)) {
      throw new Error("mastra_run_canceled");
    }
    if (event.runId !== options.input.runId) {
      throw new Error("mastra_stream_run_mismatch");
    }
    if (!started) {
      if (event.type !== "run.started") {
        throw new Error("mastra_stream_started_missing");
      }
      if (
        event.conversationId !== options.input.conversationId ||
        event.sessionId !== options.input.sessionId
      ) {
        throw new Error("mastra_stream_scope_mismatch");
      }
      started = true;
    } else if (event.type === "run.started") {
      throw new Error("mastra_stream_started_duplicate");
    }

    if (event.type === "tool.started") {
      if (activeTools.has(event.toolCallId) || settledTools.has(event.toolCallId)) {
        throw new Error("mastra_tool_started_duplicate");
      }
      activeTools.set(event.toolCallId, event.toolName);
    } else if (event.type === "tool.completed" || event.type === "tool.failed") {
      const startedToolName = activeTools.get(event.toolCallId);
      if (!startedToolName) throw new Error("mastra_tool_start_missing");
      if (startedToolName !== event.toolName) throw new Error("mastra_tool_name_mismatch");
      activeTools.delete(event.toolCallId);
      settledTools.add(event.toolCallId);
    } else if (event.type === "run.completed" && activeTools.size > 0) {
      throw new Error("mastra_tool_terminal_missing");
    }

    await options.onEvent(event);
    yield event;

    if (isTerminalEvent(event)) return;
    if (options.eventDelayMs) {
      await delay(options.eventDelayMs, undefined, {
        signal: options.input.signal,
      });
    }
  }

  throw new Error(
    started ? "mastra_stream_terminal_missing" : "mastra_stream_started_missing",
  );
}

function isTerminalEvent(event: StreamEvent): boolean {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
}
