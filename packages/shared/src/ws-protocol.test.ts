import { describe, expect, it } from "vitest";

import { wsCommandSchema } from "./ws-protocol.js";

describe("agent destructive confirmation websocket command", () => {
  it("accepts only an opaque confirmation id and explicit decision", () => {
    const command = wsCommandSchema.parse({
      type: "command",
      action: "agent.confirm_action",
      payload: {
        confirmationId: "4b4aa127-751d-4a21-a38d-98a4f568da73",
        decision: "confirm",
      },
    });
    expect(command.action).toBe("agent.confirm_action");
  });

  it("rejects model-controlled operations in place of a confirmation id", () => {
    expect(() => wsCommandSchema.parse({
      type: "command",
      action: "agent.confirm_action",
      payload: {
        decision: "confirm",
        operations: [{ action: "delete", element_id: "image" }],
      },
    })).toThrow();
  });

  it("rejects extra operations even when the confirmation id is valid", () => {
    expect(() => wsCommandSchema.parse({
      type: "command",
      action: "agent.confirm_action",
      payload: {
        confirmationId: "4b4aa127-751d-4a21-a38d-98a4f568da73",
        decision: "confirm",
        operations: [{ action: "delete", element_id: "image" }],
      },
    })).toThrow();
  });

  it("rejects extra outer command fields", () => {
    expect(() => wsCommandSchema.parse({
      type: "command",
      action: "agent.confirm_action",
      payload: {
        confirmationId: "4b4aa127-751d-4a21-a38d-98a4f568da73",
        decision: "cancel",
      },
      operations: [],
    })).toThrow();
  });
});

describe("agent tool retry websocket command", () => {
  it("accepts only opaque execution and idempotency identifiers", () => {
    expect(wsCommandSchema.parse({
      type: "command",
      action: "agent.retry_tool",
      payload: {
        toolExecutionId: "4b4aa127-751d-4a21-a38d-98a4f568da73",
        requestId: "f439db5b-94ae-4df7-b765-31d586e569f4",
      },
    }).action).toBe("agent.retry_tool");
  });

  it("rejects client-supplied tool names or inputs", () => {
    expect(() => wsCommandSchema.parse({
      type: "command",
      action: "agent.retry_tool",
      payload: {
        toolExecutionId: "4b4aa127-751d-4a21-a38d-98a4f568da73",
        requestId: "f439db5b-94ae-4df7-b765-31d586e569f4",
        toolName: "manipulate_canvas",
        input: { operations: [] },
      },
    })).toThrow();
  });
});
