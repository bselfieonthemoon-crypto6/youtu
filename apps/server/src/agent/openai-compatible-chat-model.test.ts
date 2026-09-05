import { ChatMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  normalizeCompletionsAssistantRole,
  toAIMessage,
  toAIMessageChunk,
} from "./openai-compatible-chat-model.js";

describe("OpenAI-compatible message normalization", () => {
  it("treats a role-less streaming tool call as an assistant delta", () => {
    const message = normalizeCompletionsAssistantRole({
      tool_calls: [
        {
          id: "call-1",
          index: 0,
          type: "function",
          function: { name: "generate_image", arguments: '{"prompt":"logo"}' },
        },
      ],
    });

    expect(message.role).toBe("assistant");
    expect(message.tool_calls[0].function.name).toBe("generate_image");
  });

  it("creates a serializable AIMessage from a non-standard model role", () => {
    const normalized = toAIMessage(
      new ChatMessageChunk({ content: "done", role: "model" }),
    );

    expect(normalized._getType()).toBe("ai");
    expect(normalized.content).toBe("done");
    expect(normalized.toJSON()).toMatchObject({
      type: "constructor",
      kwargs: { content: "done" },
    });
  });

  it("creates a serializable AIMessageChunk from a non-standard model role", () => {
    const normalized = toAIMessageChunk(
      new ChatMessageChunk({ content: "streamed", role: "model" }),
    );

    expect(normalized._getType()).toBe("ai");
    expect(normalized.content).toBe("streamed");
    expect(normalized.toJSON()).toMatchObject({
      type: "constructor",
      kwargs: { content: "streamed" },
    });
  });
});
