import { describe, expect, it, vi } from "vitest";

import { createChatService } from "./chat-service.js";

const user = {
  id: "user-1",
  accessToken: "test-token",
  email: "user@example.test",
  userMetadata: {},
} as any;

function query(result: unknown) {
  const value: any = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    single: vi.fn(),
  };
  for (const method of Object.keys(value)) value[method].mockReturnValue(value);
  value.then = (resolve: (result: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return value;
}

function serviceWith(...results: unknown[]) {
  const queries = results.map(query);
  const from: any = vi.fn(() => {
    const next = queries.shift();
    if (!next) throw new Error("Unexpected database query");
    return next;
  });
  return {
    from,
    service: createChatService({
      createUserClient: vi.fn(() => ({ from })) as any,
      threadService: { createThreadId: () => "thread-1" },
    }),
  };
}

describe("ChatService write authorization", () => {
  it("creates a session after the user-scoped canvas visibility check", async () => {
    const fixture = serviceWith(
      { data: { id: "canvas-1" }, error: null },
      { data: { id: "session-1", title: "New chat", updated_at: "2026-09-11T00:00:00Z" }, error: null },
    );

    await expect(fixture.service.createSession(user, "canvas-1", "New chat")).resolves.toEqual({
      id: "session-1",
      title: "New chat",
      updatedAt: "2026-09-11T00:00:00Z",
    });
    expect(fixture.from).toHaveBeenNthCalledWith(1, "canvases");
    expect(fixture.from).toHaveBeenNthCalledWith(2, "chat_sessions");
  });

  it.each([
    ["canvas", (service: ReturnType<typeof createChatService>) => service.createSession(user, "other-canvas")],
    ["session", (service: ReturnType<typeof createChatService>) => service.createMessage(user, "other-session", { role: "user", content: "hello" })],
  ])("returns the same 404 for an inaccessible %s without writing", async (_target, operation) => {
    const fixture = serviceWith({ data: null, error: null });

    await expect(operation(fixture.service)).rejects.toMatchObject({
      code: "session_not_found",
      statusCode: 404,
      message: "Chat target not found.",
    });
    expect(fixture.from).toHaveBeenCalledOnce();
  });

  it.each([
    ["canvas", (service: ReturnType<typeof createChatService>) => service.createSession(user, "canvas-1")],
    ["session", (service: ReturnType<typeof createChatService>) => service.createMessage(user, "session-1", { role: "user", content: "hello" })],
  ])("keeps visibility-check database failures as 500 for %s", async (_target, operation) => {
    const fixture = serviceWith({ data: null, error: { code: "XX000", message: "database detail" } });

    await expect(operation(fixture.service)).rejects.toMatchObject({
      code: "chat_error",
      statusCode: 500,
      message: "Failed to verify chat access.",
    });
  });

  it("maps a write-side RLS race to 404 after a visible session check", async () => {
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: null, error: { code: "42501", message: "policy detail" } },
    );

    await expect(fixture.service.createMessage(user, "session-1", { role: "user", content: "hello" })).rejects.toMatchObject({
      code: "session_not_found",
      statusCode: 404,
      message: "Chat target not found.",
    });
  });
});
