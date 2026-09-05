import { describe, expect, it, vi } from "vitest";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

import {
  isTransientCheckpointConnectionError,
  repairCorruptedThreadCheckpoint,
} from "./runtime.js";

function checkpointerWithMessages(messages: unknown[]) {
  return {
    deleteThread: vi.fn(async () => undefined),
    getTuple: vi.fn(async () => ({
      checkpoint: { channel_values: { messages } },
    })),
  } as unknown as BaseCheckpointSaver;
}

describe("repairCorruptedThreadCheckpoint", () => {
  it("deletes a thread checkpoint containing an unserializable LangChain message", async () => {
    const checkpointer = checkpointerWithMessages([
      { type: "human", content: "hello" },
      {
        lc: 1,
        type: "not_implemented",
        id: ["langchain_core", "messages", "AIMessage"],
      },
    ]);

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-broken"),
    ).resolves.toBe(true);
    expect(checkpointer.deleteThread).toHaveBeenCalledWith("thread-broken");
  });

  it("preserves a healthy checkpoint", async () => {
    const checkpointer = checkpointerWithMessages([
      { type: "human", content: "hello" },
      { type: "ai", content: "hi" },
    ]);

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-healthy"),
    ).resolves.toBe(false);
    expect(checkpointer.deleteThread).not.toHaveBeenCalled();
  });

  it("deletes a checkpoint containing the legacy string image_url shape", async () => {
    const checkpointer = checkpointerWithMessages([
      {
        type: "human",
        content: [
          { type: "text", text: "修改图片文字" },
          { type: "image_url", image_url: "data:image/webp;base64,AAAA" },
        ],
      },
    ]);

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-legacy-image"),
    ).resolves.toBe(true);
    expect(checkpointer.deleteThread).toHaveBeenCalledWith("thread-legacy-image");
  });

  it("preserves a checkpoint using the strict image_url object shape", async () => {
    const checkpointer = checkpointerWithMessages([
      {
        type: "human",
        content: [
          { type: "text", text: "修改图片文字" },
          {
            type: "image_url",
            image_url: { url: "data:image/webp;base64,AAAA" },
          },
        ],
      },
    ]);

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-modern-image"),
    ).resolves.toBe(false);
    expect(checkpointer.deleteThread).not.toHaveBeenCalled();
  });

  it("requests history recovery when no checkpoint exists", async () => {
    const checkpointer = {
      deleteThread: vi.fn(async () => undefined),
      getTuple: vi.fn(async () => undefined),
    } as unknown as BaseCheckpointSaver;

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-missing"),
    ).resolves.toBe(true);
    expect(checkpointer.deleteThread).not.toHaveBeenCalled();
  });

  it("retries a checkpoint read after a transient database disconnect", async () => {
    const getTuple = vi.fn()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValue({ checkpoint: { channel_values: { messages: [] } } });
    const checkpointer = {
      deleteThread: vi.fn(async () => undefined),
      getTuple,
    } as unknown as BaseCheckpointSaver;

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-reconnected"),
    ).resolves.toBe(false);
    expect(getTuple).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-connection checkpoint errors", async () => {
    const getTuple = vi.fn().mockRejectedValue(new Error("invalid checkpoint payload"));
    const checkpointer = {
      deleteThread: vi.fn(async () => undefined),
      getTuple,
    } as unknown as BaseCheckpointSaver;

    await expect(
      repairCorruptedThreadCheckpoint(checkpointer, "thread-invalid"),
    ).rejects.toThrow("invalid checkpoint payload");
    expect(getTuple).toHaveBeenCalledTimes(1);
  });

  it("recognizes common transient PostgreSQL connection failures", () => {
    expect(isTransientCheckpointConnectionError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientCheckpointConnectionError({ code: "57P01" })).toBe(true);
    expect(isTransientCheckpointConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientCheckpointConnectionError(new Error("permission denied"))).toBe(false);
  });
});
