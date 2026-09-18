/**
 * Plain-object message envelopes exchanged between the Mastra producer
 * (`mastra-agent.ts`) and the frozen stream contract (`stream-adapter.ts`).
 *
 * `@langchain/core` used to provide these shapes and the adapter matched them
 * with `ToolMessage.isInstance(v)` / `AIMessageChunk.isInstance(v)`. That is a
 * *branded* check, not duck typing: it requires
 * `Symbol.for("langchain.message")`, a callable `_getType()`, `type === "tool"`
 * / `"ai"`, and (for chunks) the real prototype chain. Replacing it with loose
 * duck typing such as `"content" in v` would silently widen the contract —
 * `extractArtifacts`, `extractOutput` and `summarizeOutput` receive arbitrary
 * tool results and artifacts, so any plain object that happens to carry
 * `content` would be reclassified as a message envelope and change what the
 * server emits to the UI.
 *
 * `AGENT_MESSAGE_SHAPE` keeps the same strength:
 * - it is a plain `Symbol()`, never `Symbol.for(...)`, so it is absent from the
 *   global symbol registry and no other module can name it;
 * - it is never exported — only the factories below can install it;
 * - it is installed as a non-enumerable, non-writable own property, so object
 *   spread / `Object.assign` copies do not inherit the brand either;
 * - each guard requires an own brand property with its exact shape value.
 *
 * The brand travels in-process (`streamMastraDesignAgent` yields its events
 * straight into `adaptAgentStream`) and, unlike a string discriminator, a
 * symbol cannot survive `JSON` or `structuredClone` — which is exactly why
 * untrusted tool output cannot forge one.
 */

const AGENT_MESSAGE_SHAPE: unique symbol = Symbol("loomic.agent-message-shape");

const TOOL_RESULT_ENVELOPE_SHAPE = "tool-result-envelope";
const ASSISTANT_STREAM_MESSAGE_SHAPE = "assistant-stream-message";

/**
 * Raw tool result in the envelope `stream-adapter.ts` reads.
 *
 * Pinned to what the production producer always writes and what the frozen
 * adapter reads: only `content` (a serialized payload that the adapter parses),
 * plus the LangChain-compatible `name` / `tool_call_id` / `status` receipt
 * fields the envelope format kept.
 */
export type ToolResultEnvelope = {
  readonly content: string;
  readonly name: string;
  readonly tool_call_id: string;
  readonly status: "success";
  readonly [AGENT_MESSAGE_SHAPE]: typeof TOOL_RESULT_ENVELOPE_SHAPE;
};

/**
 * Assistant chunk/message in the shape `stream-adapter.ts` reads: `id` for
 * message identity, `content` (string or content-part array) for the emitted
 * delta, and `tool_calls` to skip a tool-call turn instead of streaming it.
 */
export type AssistantStreamMessage = {
  readonly content: string | readonly unknown[];
  readonly id?: string;
  readonly tool_calls?: readonly unknown[];
  readonly [AGENT_MESSAGE_SHAPE]: typeof ASSISTANT_STREAM_MESSAGE_SHAPE;
};

/** Build the only value that satisfies `isToolResultEnvelope`. */
export function createToolResultEnvelope(fields: {
  content: string;
  name: string;
  toolCallId: string;
}): ToolResultEnvelope {
  const envelope = {
    content: fields.content,
    name: fields.name,
    tool_call_id: fields.toolCallId,
    status: "success" as const,
  };
  return brand(envelope, TOOL_RESULT_ENVELOPE_SHAPE) as ToolResultEnvelope;
}

/**
 * Build the only value that satisfies `isAssistantStreamMessage`.
 *
 * Absent optional fields are omitted rather than set to `undefined` so the
 * brand stays the single source of truth and no reader sees a stray key.
 */
export function createAssistantStreamMessage(fields: {
  content: string | readonly unknown[];
  id?: string;
  toolCalls?: readonly unknown[];
}): AssistantStreamMessage {
  const message: Record<string, unknown> = { content: fields.content };
  if (fields.id !== undefined) message.id = fields.id;
  if (fields.toolCalls !== undefined) message.tool_calls = fields.toolCalls;
  return brand(message, ASSISTANT_STREAM_MESSAGE_SHAPE) as AssistantStreamMessage;
}

/** Own-property brand check; inherited or forged keys never match. */
export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return hasShape(value, TOOL_RESULT_ENVELOPE_SHAPE);
}

/** Own-property brand check; inherited or forged keys never match. */
export function isAssistantStreamMessage(value: unknown): value is AssistantStreamMessage {
  return hasShape(value, ASSISTANT_STREAM_MESSAGE_SHAPE);
}

function brand(target: object, shape: string): object {
  // Non-enumerable/non-writable: a copy made with `{ ...envelope }` or
  // `Object.assign` must not be able to claim the envelope identity.
  Object.defineProperty(target, AGENT_MESSAGE_SHAPE, {
    value: shape,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return target;
}

function hasShape(value: unknown, shape: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, AGENT_MESSAGE_SHAPE) &&
    (value as Record<PropertyKey, unknown>)[AGENT_MESSAGE_SHAPE] === shape
  );
}
