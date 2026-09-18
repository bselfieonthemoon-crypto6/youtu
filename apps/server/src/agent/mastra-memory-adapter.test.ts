import { MastraCompositeStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import type { ObservationalMemoryRecord } from "@mastra/core/storage";
import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { compileMastraMemoryContext, deriveMemoryIds } from "./mastra-memory-adapter.js";

const scope = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  sessionId: "10000000-0000-4000-8000-000000000003",
};
const ids = deriveMemoryIds(scope);

function row(index: number, content = `message ${index}`, createdAt?: string) {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    role: index % 2 ? "user" : "assistant",
    content,
    created_at: createdAt ?? `2026-09-14T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

function historyClient(newestFirst: ReturnType<typeof row>[]) {
  const range = vi.fn(async (from: number, to: number) => ({ data: newestFirst.slice(from, to + 1), error: null }));
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    range,
  };
  return { from: vi.fn(() => chain), range };
}

function record(overrides: Partial<ObservationalMemoryRecord> = {}): ObservationalMemoryRecord {
  const now = new Date("2026-09-14T00:00:00.000Z");
  return {
    id: "om-record",
    scope: "thread",
    threadId: ids.threadId,
    resourceId: ids.resourceId,
    createdAt: now,
    updatedAt: now,
    originType: "initial",
    generationCount: 0,
    activeObservations: "",
    totalTokensObserved: 0,
    observationTokenCount: 0,
    pendingMessageTokens: 0,
    isReflecting: false,
    isObserving: false,
    isBufferingObservation: false,
    isBufferingReflection: false,
    lastBufferedAtTokens: 0,
    lastBufferedAtTime: null,
    config: {},
    ...overrides,
  };
}

function fakeEngine(options: {
  current?: ObservationalMemoryRecord | null;
  shouldObserve?: boolean;
  observeError?: Error;
} = {}) {
  const current = options.current ?? record();
  return {
    getRecord: vi.fn(async () => options.current === null ? null : current),
    buildContextSystemMessage: vi.fn(async ({ record: value }: any) => value?.activeObservations || undefined),
    getStatus: vi.fn(async () => ({
      record: current,
      shouldObserve: options.shouldObserve ?? false,
      shouldBuffer: false,
      shouldReflect: false,
    })),
    observe: vi.fn(async ({ messages }: any) => {
      if (options.observeError) throw options.observeError;
      return {
        observed: true,
        reflected: false,
        record: record({
          activeObservations: "native observations",
          observedMessageIds: messages.map((message: any) => message.id),
          lastObservedAt: messages.at(-1)?.createdAt,
        }),
      };
    }),
  } as any;
}

describe("Mastra observational memory adapter", () => {
  it("derives distinct authenticated identities across workspace, user, and session boundaries", () => {
    const base = deriveMemoryIds(scope);
    const otherWorkspace = deriveMemoryIds({ ...scope, workspaceId: "20000000-0000-4000-8000-000000000001" });
    const otherUser = deriveMemoryIds({ ...scope, userId: "20000000-0000-4000-8000-000000000002" });
    const otherSession = deriveMemoryIds({ ...scope, sessionId: "20000000-0000-4000-8000-000000000003" });

    expect(new Set([base.resourceId, otherWorkspace.resourceId, otherUser.resourceId]).size).toBe(3);
    expect(new Set([base.threadId, otherWorkspace.threadId, otherUser.threadId, otherSession.threadId]).size).toBe(4);
    expect(otherSession.resourceId).toBe(base.resourceId);
    expect(deriveMemoryIds({
      workspaceId: "10000000-0000-7000-8000-000000000001",
      userId: "10000000-0000-7000-8000-000000000002",
      sessionId: "10000000-0000-7000-8000-000000000003",
    }).threadId).toContain("10000000-0000-7000-8000-000000000003");
  });

  it("does no storage or history work when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const client = historyClient([]);
    const createEngine = vi.fn(async () => fakeEngine());

    await expect(compileMastraMemoryContext({
      client, scope, model: {} as any, currentPrompt: "new", signal: controller.signal,
      connectionString: "postgres://unused", dependencies: { createEngine },
    })).rejects.toThrow("cancelled");
    expect(createEngine).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("labels missing storage configuration and falls back to bounded canonical history", async () => {
    const client = historyClient([row(2), row(1)]);
    const createEngine = vi.fn(async () => fakeEngine());
    const result = await compileMastraMemoryContext({
      client, scope, model: {} as any, currentPrompt: "new", connectionString: "",
      dependencies: { createEngine }, limits: { pageSize: 10, maxPages: 2 },
    });

    expect(createEngine).not.toHaveBeenCalled();
    expect(result.observationalMemory).toMatchObject({ mode: "degraded", degradedPhase: "storage" });
    expect(result.messages.map(message => message.id)).toEqual([row(1).id, row(2).id]);
  });

  it("keeps every below-threshold unobserved message that fits, not only a fixed row window", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(20 - index, index === 19 ? "EARLIEST FACT" : undefined));
    const engine = fakeEngine();
    const result = await compileMastraMemoryContext({
      client: historyClient(rows), scope, model: {} as any, currentPrompt: "new",
      connectionString: "postgres://unused", dependencies: { createEngine: async () => engine },
      limits: { pageSize: 25, maxPages: 2, maxContextBytes: 10_000, summaryTargetBytes: 1_000 },
    });

    expect(result.messages).toHaveLength(20);
    expect(result.messages[0]?.content).toBe("EARLIEST FACT");
    expect(engine.observe).not.toHaveBeenCalled();
    expect(result.omissions).toEqual([]);
  });

  it("does not observe when only the retained long tail crosses the native threshold", async () => {
    const current = record();
    const engine = fakeEngine({ current });
    engine.getStatus.mockImplementation(async ({ messages }: any) => ({
      record: current,
      shouldObserve: messages.reduce((bytes: number, message: any) =>
        bytes + Buffer.byteLength(message.content.parts[0]?.text ?? "", "utf8"), 0) >= 500,
      shouldBuffer: false,
      shouldReflect: false,
    }));
    const createEngine = vi.fn(async (_input: any) => engine);
    const newestFirst = Array.from({ length: 14 }, (_, index) => {
      const id = 14 - index;
      return row(id, id >= 3 ? `retained tail ${id} ${"x".repeat(700)}` : `small prefix ${id}`);
    });
    const result = await compileMastraMemoryContext({
      client: historyClient(newestFirst), scope, model: {} as any, currentPrompt: "new",
      connectionString: "postgres://unused", dependencies: { createEngine },
      limits: { pageSize: 20, maxPages: 2, recentMessages: 12,
        maxContextBytes: 20_000, summaryTargetBytes: 1_000 },
    });

    expect(engine.getStatus).toHaveBeenCalledTimes(2);
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(engine.observe).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(14);
    expect(result.omissions).toEqual([]);
  });

  it("observes once the candidate prefix itself crosses the native threshold", async () => {
    const current = record();
    const engine = fakeEngine({ current });
    engine.getStatus.mockImplementation(async ({ messages }: any) => ({
      record: current,
      shouldObserve: messages.reduce((bytes: number, message: any) =>
        bytes + Buffer.byteLength(message.content.parts[0]?.text ?? "", "utf8"), 0) >= 500,
      shouldBuffer: false,
      shouldReflect: false,
    }));
    const createEngine = vi.fn(async (_input: any) => engine);
    const newestFirst = Array.from({ length: 20 }, (_, index) =>
      row(20 - index, `accumulated ${20 - index} ${"x".repeat(100)}`));
    const result = await compileMastraMemoryContext({
      client: historyClient(newestFirst), scope, model: {} as any, currentPrompt: "new",
      connectionString: "postgres://unused", dependencies: { createEngine },
      limits: { pageSize: 25, maxPages: 2, recentMessages: 12,
        maxContextBytes: 20_000, summaryTargetBytes: 1_000 },
    });

    expect(engine.getStatus).toHaveBeenCalledTimes(2);
    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(engine.observe).toHaveBeenCalledTimes(1);
    expect(engine.observe.mock.calls[0]?.[0].messages).toHaveLength(8);
    expect(result.messages).toHaveLength(12);
  });

  it("keeps a bounded head and latest correction for one oversized newest message", async () => {
    const content = `OPENING REQUIREMENT ${"x".repeat(8_000)} LATEST CORRECTION: use 16:9`;
    const result = await compileMastraMemoryContext({
      client: historyClient([row(1, content)]), scope, model: {} as any, currentPrompt: "different prompt",
      connectionString: "postgres://unused", dependencies: { createEngine: async () => fakeEngine() },
      limits: { pageSize: 10, maxPages: 2, maxContextBytes: 1_500, summaryTargetBytes: 300 },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toContain("OPENING REQUIREMENT");
    expect(result.messages[0]?.content).toContain("LATEST CORRECTION: use 16:9");
    expect(result.omissions.some(value => value.includes("newest message"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages }), "utf8"))
      .toBeLessThanOrEqual(1_500);
  });

  it("uses observed IDs as the tie-breaker when rows share the watermark timestamp", async () => {
    const tied = "2026-09-14T00:00:10.000Z";
    const prior = record({ lastObservedAt: new Date(tied), observedMessageIds: [row(10).id], activeObservations: "prior facts" });
    const engine = fakeEngine({ current: prior });
    const result = await compileMastraMemoryContext({
      client: historyClient([row(11, "LATEST CORRECTION", tied), row(10, "already observed", tied)]),
      scope, model: {} as any, currentPrompt: "new", connectionString: "postgres://unused",
      dependencies: { createEngine: async () => engine },
      limits: { pageSize: 10, maxPages: 2, maxContextBytes: 4_000, summaryTargetBytes: 1_000 },
    });

    expect(result.messages.map(message => message.content)).toEqual(["LATEST CORRECTION"]);
  });

  it("reports an observe-phase degraded fallback without retrying the paid observation", async () => {
    const engine = fakeEngine({ shouldObserve: true, observeError: new Error("secret provider failure") });
    const createEngine = vi.fn(async (_input: any) => engine);
    const result = await compileMastraMemoryContext({
      client: historyClient(Array.from({ length: 14 }, (_, index) => row(14 - index))),
      scope, model: {} as any, currentPrompt: "new", connectionString: "postgres://unused",
      dependencies: { createEngine },
      limits: { pageSize: 20, maxPages: 2, recentMessages: 2, maxContextBytes: 5_000, summaryTargetBytes: 1_000 },
    });

    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(createEngine.mock.calls[1]?.[0].limits.observationTokens).toBe(1);
    expect(engine.observe).toHaveBeenCalledTimes(1);
    expect(result.observationalMemory).toMatchObject({ mode: "degraded", degradedPhase: "observe", observed: false });
    expect(JSON.stringify(result)).not.toContain("secret provider failure");
    expect(result.messages).toHaveLength(14);
  });

  it("shrinks the verbatim tail when fewer than recentMessages already exceed the byte budget", async () => {
    const engine = fakeEngine();
    const createEngine = vi.fn(async (_input: any) => engine);
    const rows = Array.from({ length: 5 }, (_, index) =>
      row(5 - index, `message ${5 - index} ${"x".repeat(900)}`));
    const result = await compileMastraMemoryContext({
      client: historyClient(rows), scope, model: {} as any, currentPrompt: "new",
      connectionString: "postgres://unused", dependencies: { createEngine },
      limits: { pageSize: 10, maxPages: 2, recentMessages: 12,
        maxContextBytes: 2_500, summaryTargetBytes: 400 },
    });

    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(engine.getStatus).toHaveBeenCalledTimes(1);
    expect(engine.observe).toHaveBeenCalledTimes(1);
    const observedMessages = engine.observe.mock.calls[0]?.[0].messages;
    expect(observedMessages.length).toBeGreaterThan(0);
    expect(observedMessages.at(-1)?.id).not.toBe(row(5).id);
    expect(result.observationalMemory.observed).toBe(true);
    expect(result.messages.at(-1)?.id).toBe(row(5).id);
  });

  it("uses native observation text without truncating it to make room for the generic Mastra wrapper", async () => {
    const observations = `- 🔴 ${"exact historical fact ".repeat(45)}`;
    const native = record({ activeObservations: observations });
    const engine = fakeEngine({ current: native });
    engine.buildContextSystemMessage.mockResolvedValue(`${"generic wrapper ".repeat(100)}${observations}`);
    const result = await compileMastraMemoryContext({
      client: historyClient([]), scope, model: {} as any, currentPrompt: "new",
      connectionString: "postgres://unused", dependencies: { createEngine: async () => engine },
      limits: { maxContextBytes: 4_000, summaryTargetBytes: 1_100 },
    });

    expect(result.summary).toBe(observations);
    expect(result.summary).not.toContain("generic wrapper");
    expect(engine.buildContextSystemMessage).not.toHaveBeenCalled();
  });

  it("runs the real Memory.omEngine observer over canonical text only", async () => {
    const memoryStore = new TestMemoryStorage();
    const storage = new MastraCompositeStore({ id: "test-memory", domains: { memory: memoryStore as any } });
    const model = createOpenAICompatible({
      name: "deepseek-test",
      baseURL: "https://deepseek.test/v1",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const serialized = JSON.stringify(body.messages);
        expect(serialized).not.toContain("<current_context>");
        const isReflection = serialized.includes("OBSERVATIONS TO REFLECT ON");
        if (isReflection) expect(serialized).toContain("compact CURRENT STATE summary");
        if (!isReflection) expect(serialized).toContain("LATEST CORRECTION: 品牌名必须逐字写作“原研哉”");
        const output = isReflection
          ? "<observations>\n- 🔴 CURRENT CONFIRMED STATE: 品牌名“原研哉”，主色 #6B4EFF\n</observations>"
          : `<observations>\n- 🔴 User confirmed exact display text: 原研哉; current color #6B4EFF\n${Array.from({ length: 50 }, (_, index) => `- 🟡 Obsolete verbose assistant analysis ${index} that may be discarded.`).join("\n")}\n</observations>`;
        if (body.stream) {
          return new Response(`data: ${JSON.stringify({ id: "om", object: "chat.completion.chunk", created: 1,
            model: "deepseek-test", choices: [{ index: 0, delta: { role: "assistant", content: output }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "om", object: "chat.completion.chunk", created: 1,
            model: "deepseek-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ id: "om", object: "chat.completion", created: 1, model: "deepseek-test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: output } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }),
        { headers: { "content-type": "application/json" } });
      },
    }).chatModel("deepseek-test");
    const createEngine = vi.fn(async ({ limits, suppressAutomaticReflection }: any) => {
      const memory = new Memory({
        storage,
        options: { observationalMemory: {
          model, scope: "thread", retrieval: false,
          observation: { messageTokens: limits.observationTokens, bufferTokens: false,
            continuationHints: { currentTask: false, suggestedResponse: false } },
          reflection: { observationTokens: suppressAutomaticReflection ? 1_000_000 :
            Math.max(2_000, Math.floor(limits.summaryTargetBytes / 4)),
            continuationHints: { currentTask: false, suggestedResponse: false } },
        } },
      });
      const engine = await memory.omEngine;
      if (!engine) throw new Error("missing test engine");
      return engine;
    });

    const result = await compileMastraMemoryContext({
      client: historyClient([
        row(4, `assistant acknowledgement ${"x".repeat(1_000)}`),
        row(3, "LATEST CORRECTION: 品牌名必须逐字写作“原研哉”，主色改为 #6B4EFF"),
        row(2, `old assistant suggestion ${"x".repeat(5_000)}`),
        row(1, "品牌名必须逐字写作“原研哉”，主色先定为 #243B53"),
      ]),
      scope, model, currentPrompt: "<current_context>transient receipt</current_context>",
      currentUserMessageId: row(99).id,
      connectionString: "postgres://unused",
      dependencies: { createEngine },
      limits: { pageSize: 10, maxPages: 2, recentMessages: 1, observationTokens: 100,
        maxContextBytes: 4_000, summaryTargetBytes: 1_500 },
    });

    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(createEngine.mock.calls.map(call => call[0].limits.observationTokens)).toEqual([100, 1]);
    expect(createEngine.mock.calls.map(call => call[0].suppressAutomaticReflection)).toEqual([undefined, true]);
    expect(result.observationalMemory).toMatchObject({
      mode: "observational", observed: true, reflected: true,
      lastObservedAt: row(3).created_at,
    });
    expect(result.summary).toContain("原研哉");
    expect(result.summary).toContain("#6B4EFF");
    expect(result.summary).not.toContain("#243B53");
    expect(result.messages.map(message => message.content)).toEqual([
      "LATEST CORRECTION: 品牌名必须逐字写作“原研哉”，主色改为 #6B4EFF",
      `assistant acknowledgement ${"x".repeat(1_000)}`,
    ]);
    expect(memoryStore.savedRawMessages).toEqual([]);

    const normalEngine = await createEngine({ limits: { observationTokens: 100 } } as any);
    const nextStatus = await normalEngine.getStatus({
      threadId: ids.threadId,
      resourceId: ids.resourceId,
      messages: [{
        id: row(5).id,
        role: "user",
        createdAt: new Date(row(5).created_at),
        threadId: ids.threadId,
        resourceId: ids.resourceId,
        content: { format: 2, parts: [{ type: "text", text: "tiny next turn" }] },
      }],
    });
    expect(nextStatus.shouldObserve).toBe(false);
  });
});

class TestMemoryStorage {
  supportsObservationalMemory = true;
  savedRawMessages: unknown[] = [];
  private current: ObservationalMemoryRecord | null = null;

  async init() {}
  async getObservationalMemory(threadId: string | null, resourceId: string) {
    return this.current?.threadId === threadId && this.current.resourceId === resourceId ? this.current : null;
  }
  async initializeObservationalMemory(input: any) {
    if (!this.current) this.current = record({
      id: "native-record", threadId: input.threadId, resourceId: input.resourceId, scope: input.scope,
      config: input.config, observedTimezone: input.observedTimezone,
    });
    return this.current;
  }
  async updateActiveObservations(input: any) {
    if (!this.current) throw new Error("missing record");
    this.current = { ...this.current, activeObservations: input.observations,
      observationTokenCount: input.tokenCount, lastObservedAt: input.lastObservedAt,
      observedMessageIds: input.observedMessageIds, updatedAt: new Date() };
  }
  async createReflectionGeneration(input: any) {
    this.current = record({
      ...input.currentRecord,
      id: `reflection-${input.currentRecord.generationCount + 1}`,
      originType: "reflection",
      generationCount: input.currentRecord.generationCount + 1,
      activeObservations: input.reflection,
      observationTokenCount: input.tokenCount,
      lastObservedAt: input.currentRecord.lastObservedAt,
      // Match MemoryPG 1.24.0: reflection generations do not copy IDs.
      observedMessageIds: undefined,
      updatedAt: new Date(),
    });
    return this.current;
  }
  async setObservingFlag(_id: string, value: boolean) { if (this.current) this.current.isObserving = value; }
  async setReflectingFlag(_id: string, value: boolean) { if (this.current) this.current.isReflecting = value; }
  async setPendingMessageTokens(_id: string, value: number) { if (this.current) this.current.pendingMessageTokens = value; }
  async saveMessages({ messages }: any) { this.savedRawMessages.push(...messages); return { messages }; }
  async getThreadById() { return null; }
  async updateThread() { return null; }
}
