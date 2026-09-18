import { describe, expect, it } from "vitest";

import {
  createAssistantStreamMessage,
  createToolResultEnvelope,
  isAssistantStreamMessage,
  isToolResultEnvelope,
} from "./agent-message-shapes.js";

describe("agent message shape brands", () => {
  it("recognizes only tool result envelopes built by the producer factory", () => {
    const envelope = createToolResultEnvelope({ content: "{}", name: "generate_image", toolCallId: "call-1" });
    expect(isToolResultEnvelope(envelope)).toBe(true);

    // The pinned fields are not the brand. Arbitrary tool results and artifacts
    // reach the same code path, so a duck-typed guard would reclassify any
    // object that happens to carry these keys.
    expect(isToolResultEnvelope({
      content: "{}", name: "generate_image", tool_call_id: "call-1", status: "success",
    })).toBe(false);
    expect(isToolResultEnvelope({ content: "{}" })).toBe(false);
    expect(isToolResultEnvelope({ ...envelope })).toBe(false);
    expect(isToolResultEnvelope(Object.assign({}, envelope))).toBe(false);
    expect(isToolResultEnvelope([envelope])).toBe(false);
    for (const value of [null, undefined, "content", 42, true, () => "{}"]) {
      expect(isToolResultEnvelope(value)).toBe(false);
    }
  });

  it("recognizes only assistant stream messages built by the producer factory", () => {
    const message = createAssistantStreamMessage({ content: "你好", id: "run-1_chunk-1" });
    expect(isAssistantStreamMessage(message)).toBe(true);

    expect(isAssistantStreamMessage({ content: "你好", id: "run-1_chunk-1" })).toBe(false);
    expect(isAssistantStreamMessage({ content: "你好", id: "run-1_chunk-1", type: "ai" })).toBe(false);
    expect(isAssistantStreamMessage({ ...message })).toBe(false);
    expect(isAssistantStreamMessage(null)).toBe(false);
    expect(isAssistantStreamMessage(undefined)).toBe(false);
  });

  it("keeps the two branded shapes mutually exclusive", () => {
    const envelope = createToolResultEnvelope({ content: "x", name: "t", toolCallId: "c" });
    const message = createAssistantStreamMessage({ content: "x" });
    expect(isAssistantStreamMessage(envelope)).toBe(false);
    expect(isToolResultEnvelope(message)).toBe(false);
  });

  it("omits absent optional fields instead of writing undefined keys", () => {
    const message = createAssistantStreamMessage({ content: "hi" });
    expect(Object.keys(message)).toEqual(["content"]);
    expect("id" in message).toBe(false);
    expect("tool_calls" in message).toBe(false);

    const withCalls = createAssistantStreamMessage({ content: "", toolCalls: [{ id: "call", name: "edit", args: {} }] });
    expect(withCalls.tool_calls).toEqual([{ id: "call", name: "edit", args: {} }]);
    expect(isAssistantStreamMessage(withCalls)).toBe(true);
  });

  it("keeps the brand out of copies and serialized payloads", () => {
    const envelope = createToolResultEnvelope({ content: "{}", name: "edit_image", toolCallId: "call-2" });
    expect(Object.keys(envelope)).toEqual(["content", "name", "tool_call_id", "status"]);
    expect(JSON.stringify(envelope)).toBe(
      '{"content":"{}","name":"edit_image","tool_call_id":"call-2","status":"success"}',
    );
    // The brand is an in-process symbol: a structural clone cannot carry it, so
    // no serialized tool output can ever be mistaken for an envelope.
    expect(isToolResultEnvelope(structuredClone(envelope))).toBe(false);
    expect(isToolResultEnvelope(JSON.parse(JSON.stringify(envelope)))).toBe(false);
  });
});
