import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@loomic/shared";
import type { Message } from "../src/hooks/use-chat-sessions";
import { projectGenerationMessages } from "../src/lib/chat-generation-presentation";

const tool = (id: string, status: string, summary = status): ContentBlock => ({ type: "tool", toolName: status === "succeeded" ? "generate_image" : "confirm_image_generation", toolCallId: `${id}-${status}`, status: "completed", output: { jobId: id, status, summary }, outputSummary: summary });
const message = (id: string, ...contentBlocks: ContentBlock[]): Message => ({ id, role: "assistant", contentBlocks });

describe("generation message presentation", () => {
  it("replaces a Mastra edit submission with the worker result without a duplicate card", () => {
    const pending = tool("edit-job", "processing");
    if (pending.type === "tool") pending.toolName = "edit_image";
    const completed = tool("edit-job", "succeeded");
    const projected = projectGenerationMessages([message("edit-run", pending), message("edit-job", completed)]);
    expect(projected).toEqual([message("edit-run", completed)]);
    expect(projectGenerationMessages(projected)).toEqual(projected);
  });
  it("preserves unchanged message identity and remains stable when projected again", () => {
    const raw = message("job", tool("job", "succeeded"));
    const result = projectGenerationMessages([raw]);
    expect(result[0]).toBe(raw);
    expect(projectGenerationMessages(result)[0]).toBe(raw);
  });
  it("does not move user messages while the earlier task slot receives its result", () => {
    const user: Message = { id: "later-user", role: "user", contentBlocks: [{ type: "text", text: "下一张用蓝色" }] };
    const success = tool("job", "succeeded");
    const result = projectGenerationMessages([message("first", tool("job", "processing")), user, message("done", success)]);
    expect(result).toEqual([message("first", success), user]);
  });
  it("collapses the real result-plus-two-submissions pattern without modifying records", () => {
    const raw = [message("job", tool("job", "succeeded")), message("run", tool("job", "processing")), message("audit", tool("job", "processing"))];
    const original = structuredClone(raw);
    expect(projectGenerationMessages(raw)).toEqual([raw[0]]);
    expect(raw).toEqual(original);
  });
  it("replaces the first submission slot with the eventual result", () => {
    const success = tool("job", "succeeded");
    const projected = projectGenerationMessages([message("run", tool("job", "processing")), message("job", success)]);
    expect(projected).toEqual([message("run", success)]);
  });
  it("deduplicates while the task is still processing", () => {
    expect(projectGenerationMessages([message("a", tool("job", "processing")), message("b", tool("job", "processing"))])).toHaveLength(1);
  });
  it.each(["failed", "dead_letter", "canceled"])("keeps %s instead of stale waiting cards", status => {
    const result = projectGenerationMessages([message("a", tool("job", status)), message("b", tool("job", "processing"))]);
    expect(result[0]!.contentBlocks).toEqual([tool("job", status)]);
  });
  it("preserves distinct tasks and user messages even with identical prompts", () => {
    const user: Message = { id: "u", role: "user", contentBlocks: [{ type: "text", text: "确认生成" }] };
    const result = projectGenerationMessages([user, message("a", tool("one", "succeeded")), message("b", tool("two", "succeeded"))]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(user);
  });
  it("keeps unrelated explanation while removing exact duplicated status text", () => {
    const explanation: ContentBlock = { type: "text", text: "这是保留的设计说明" };
    const result = projectGenerationMessages([message("job", tool("job", "succeeded")), message("run", tool("job", "processing", "排队中"), { type: "text", text: "排队中" }, explanation)]);
    expect(result[1]!.contentBlocks).toEqual([explanation]);
  });
  it("does not hide a proposal, an unrelated tool or an empty streaming row", () => {
    const raw = [message("proposal", { type: "tool", toolName: "generate_image", toolCallId: "p", status: "completed", output: { status: "awaiting_confirmation" } }), message("stream")];
    expect(projectGenerationMessages(raw)).toEqual(raw);
  });
  it("keeps richer success artifacts instead of a later sparse success replay", () => {
    const rich = tool("job", "succeeded");
    if (rich.type === "tool") rich.artifacts = [{ type: "image", url: "https://example.com/result.png", title: "result" }] as typeof rich.artifacts;
    const result = projectGenerationMessages([message("job", rich), message("audit", tool("job", "succeeded"))]);
    expect(result[0]!.contentBlocks[0]).toBe(rich);
  });
});
