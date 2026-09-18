/**
 * Per-run tool context for Mastra-native agent tools.
 *
 * ## Design choice (LangChain -> Mastra `createTool` migration)
 *
 * Before this migration every tool received a LangChain `RunnableConfig` and read
 * run facts from `config.configurable`. That object — built once per run in
 * `mastra-runtime.ts` — is the single source of truth for ~25 keys
 * (`user_id`, `access_token`, `canvas_id`, `run_id`, session flags, ...), and the
 * runtime both reads and *writes* it (for example
 * `nonstandard_size_skill_loaded_run_id`, which `mastra-image-tool.ts` checks
 * inside the same run).
 *
 * Mastra's native transport for run facts is `RequestContext`
 * (`agent.stream({ requestContext })`), which reaches a tool as the
 * non-optional second `execute` argument `context.requestContext`. To keep ONE
 * mutable record per run — no key-by-key copying, no duplicated state that could
 * drift from what `mastra-runtime.ts` reads after the run — the runtime stores
 * the whole record as a single `RequestContext` entry under
 * {@link TOOL_RUN_CONTEXT_KEY}. `RequestContext.get` returns the stored value by
 * reference, so every tool observes the same object and runtime-side mutations
 * remain visible to later tools and to post-run bookkeeping.
 *
 * Every tool therefore reads its context with one line:
 *
 * ```ts
 * execute: async (input, context) => {
 *   const runContext = runContextOf(context);
 *   const signal = toolAbortSignalOf(context);
 * }
 * ```
 *
 * Tools must be created with {@link createAgentTool} rather than raw
 * `createTool` so the model-only projection of the raw result is installed once,
 * in a single place, instead of being re-wrapped per tool.
 */

import { RequestContext } from "@mastra/core/request-context";
import { createTool, isValidationError, type Tool, type ToolExecuteContext, type ToolExecutionContext } from "@mastra/core/tools";
import { toolResultForModel } from "../tool-result-projection.js";

/**
 * RequestContext key holding the complete per-run tool run-context record.
 *
 * A single container entry (rather than one RequestContext entry per key) is
 * what preserves object identity: `RequestContext.all` builds a fresh object,
 * so per-key entries could not carry runtime mutations back to the caller.
 */
export const TOOL_RUN_CONTEXT_KEY = "loomic_run_context";

/** The per-run record built once in `mastra-runtime.ts`. */
export type ToolRunContext = Record<string, unknown>;

/**
 * Mastra tool with erased generics — the shared type for tool collections
 * (`mastra-toolkit.ts`, `Agent({ tools })`), where each tool has its own schema.
 */
export type MastraAgentTool = Tool<any, any, any, any, any, string, any>;

/** Execution context shape received by a Mastra tool's `execute` callback. */
export type AgentToolExecutionContext = ToolExecuteContext<ToolExecutionContext, unknown>;

const isRecord = (value: unknown): value is ToolRunContext =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Wrap a run-context record for `agent.stream({ requestContext })`.
 *
 * The wrapped object is usually created per run, but tests may build one for a
 * direct tool call; nothing here mutates or copies the record.
 */
export function toolRequestContext(runContext: ToolRunContext): RequestContext {
  return new RequestContext([[TOOL_RUN_CONTEXT_KEY, runContext]]);
}

/**
 * Read the per-run record from a Mastra tool execution context.
 *
 * Returns `{}` when a caller supplied no usable context, which makes the tools
 * produce their existing "context unavailable" receipts instead of throwing.
 * A bare record passed as `requestContext` is also accepted so direct
 * (non-agent) invocation needs no RequestContext instance.
 */
export function runContextOf(context: unknown): ToolRunContext {
  const requestContext = (context as { requestContext?: unknown } | null | undefined)?.requestContext;
  const get = (requestContext as { get?: unknown } | null | undefined)?.get;
  if (typeof get === "function") {
    const stored = (get as (key: string) => unknown).call(requestContext, TOOL_RUN_CONTEXT_KEY);
    if (isRecord(stored)) return stored;
  }
  return isRecord(requestContext) ? requestContext : {};
}

/** Abort signal for the current tool call, when the runtime supplied one. */
export function toolAbortSignalOf(context: unknown): AbortSignal | undefined {
  const signal = (context as { abortSignal?: unknown } | null | undefined)?.abortSignal;
  return signal && typeof (signal as AbortSignal).aborted === "boolean" ? signal as AbortSignal : undefined;
}

/**
 * Build a Mastra tool execution context for direct invocation outside the agent
 * loop: the read-only retry executor and unit tests. `configurable` is the same
 * per-run record the agent runtime stores in the RequestContext.
 */
export function toolExecutionContext(input: {
  configurable?: ToolRunContext;
  signal?: AbortSignal;
}): AgentToolExecutionContext {
  return {
    requestContext: toolRequestContext(input.configurable ?? {}),
    ...(input.signal ? { abortSignal: input.signal } : {}),
  } as AgentToolExecutionContext;
}

/**
 * Loose view of `createTool` used only inside the wrapper below; every caller of
 * `createAgentTool` still gets `createTool`'s exact generic signature.
 */
const createToolLoose = createTool as unknown as (options: Record<string, unknown>) => {
  id: string;
  execute?: (input: unknown, context: unknown) => Promise<unknown>;
};

/**
 * `createTool` validates input and *returns* a `ValidationError` value instead
 * of throwing. The agent runtime has always treated a schema violation as a
 * failed tool call (`on_tool_error` → `tool.failed`), and the model must not
 * receive a plausible "successful" payload for arguments it got wrong, so the
 * validation result is rethrown. Nothing executes before this point, so no
 * authorization, billing or idempotency behaviour changes.
 */
class ToolInputValidationError extends Error {
  readonly code = "tool_input_invalid";
  constructor(toolId: string, detail: string) {
    super(`Tool input validation failed for ${toolId}: ${detail}`);
    this.name = "ToolInputValidationError";
  }
}

/**
 * `createTool` plus the model-visible result projection.
 *
 * Raw results stay raw for the runtime stream, the UI and the durable ledger,
 * while the model receives `compactMastraToolResult` (binary payloads, signed
 * URLs and credentials never travel back to the provider). This replaces the
 * per-tool compaction the deleted LangChain adapter performed inside
 * `mastra-agent.ts`.
 */
export const createAgentTool: typeof createTool = ((options: Record<string, unknown>) => {
  const created = createToolLoose({
    ...options,
    toModelOutput: options.toModelOutput ?? toolResultForModel,
  });
  const inner = created.execute;
  if (typeof inner === "function") {
    created.execute = async (input: unknown, context: unknown) => {
      const result = await inner(input, context);
      if (isValidationError(result)) {
        throw new ToolInputValidationError(created.id, result.message);
      }
      return result;
    };
  }
  return created;
}) as unknown as typeof createTool;
