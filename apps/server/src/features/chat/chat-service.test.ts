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
    order: vi.fn(),
    maybeSingle: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    in: vi.fn(),
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

describe("ChatService.truncateFrom (edit and resend)", () => {
  it("removes the edited message and every later one, keeping earlier history", async () => {
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }], error: null },
      { error: null, count: 3 },
    );

    const result = await fixture.service.truncateFrom(user, "session-1", "m2");
    expect(result).toMatchObject({ deleted: 3 });
    // The ids are returned so the route can also stop those jobs: an assistant
    // placeholder's id IS its job id.
    expect(result.deletedIds).toEqual(["m2", "m3", "m4"]);
    // m1 must survive: the cut starts AT the edited message, it is not a session wipe.
    expect(fixture.from).toHaveBeenLastCalledWith("chat_messages");
    expect(fixture.from).toHaveBeenCalledTimes(3);
  });

  it("deletes only the edited message when it is the last one", async () => {
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: [{ id: "m1" }, { id: "m2" }], error: null },
      { error: null, count: 1 },
    );

    await expect(fixture.service.truncateFrom(user, "session-1", "m2"))
      .resolves.toMatchObject({ deleted: 1, deletedIds: ["m2"] });
  });

  it("chunks a long tail so one id list cannot overflow the request URL", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: `m${index}` }));
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: rows, error: null },
      { error: null, count: 100 },
      { error: null, count: 100 },
      { error: null, count: 50 },
    );

    await expect(fixture.service.truncateFrom(user, "session-1", "m0"))
      .resolves.toMatchObject({ deleted: 250 });
    // 1 session check + 1 id read + 3 delete chunks
    expect(fixture.from).toHaveBeenCalledTimes(5);
  });

  it("reports a message outside this session as not found and deletes nothing", async () => {
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: [{ id: "m1" }], error: null },
    );

    await expect(fixture.service.truncateFrom(user, "session-1", "somewhere-else"))
      .rejects.toMatchObject({ code: "chat_message_not_found", statusCode: 404 });
    expect(fixture.from).toHaveBeenCalledTimes(2);
  });

  it("reports an invisible session as not found", async () => {
    const fixture = serviceWith({ data: null, error: null });

    await expect(fixture.service.truncateFrom(user, "session-1", "m1"))
      .rejects.toMatchObject({ code: "session_not_found", statusCode: 404 });
    expect(fixture.from).toHaveBeenCalledOnce();
  });

  it("keeps the RLS write-policy race indistinguishable from a missing session", async () => {
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: [{ id: "m1" }], error: null },
      { error: { code: "42501", message: "policy detail" } },
    );

    await expect(fixture.service.truncateFrom(user, "session-1", "m1"))
      .rejects.toMatchObject({ code: "session_not_found", statusCode: 404 });
  });

  it("surfaces an ordinary delete failure as a server error", async () => {
    const fixture = serviceWith(
      { data: { id: "session-1" }, error: null },
      { data: [{ id: "m1" }], error: null },
      { error: { code: "XX000", message: "database detail" } },
    );

    await expect(fixture.service.truncateFrom(user, "session-1", "m1"))
      .rejects.toMatchObject({ code: "chat_error", statusCode: 500 });
  });
});
