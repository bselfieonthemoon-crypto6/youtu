import { describe, expect, it, vi } from "vitest";

import { compileMastraConversationContext } from "./mastra-context.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function row(value: number, content = `message ${value}`) {
  return {
    id: id(value),
    role: value % 2 ? "user" : "assistant",
    content,
    created_at: `2026-09-13T00:00:${String(value).padStart(2, "0")}.000Z`,
  };
}

function historyClient(newestFirst: ReturnType<typeof row>[]) {
  const range = vi.fn(async (from: number, to: number) => ({
    data: newestFirst.slice(from, to + 1),
    error: null,
  }));
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    range,
  };
  return { client: { from: vi.fn(() => chain) }, chain, range };
}

const limits = {
  pageSize: 3,
  maxPages: 3,
  recentMessages: 2,
  maxContextBytes: 4_000,
  summaryTargetBytes: 1_000,
  summarizerInputBytes: 1_500,
};

describe("Mastra conversation context compiler", () => {
  it("survives 1000 synthetic conversation turns with repeated summary outages and bounded latest corrections", async () => {
    const rows: ReturnType<typeof row>[] = [];
    let snapshot: { summary: string; coverage: { messageIds: string[]; omissions: string[] } } | undefined;
    let reductions = 0, fallbacks = 0;
    for (let turn = 1; turn <= 1000; turn++) {
      const correction = `LATEST-${turn}: brand LARK STUDIO, color ${turn % 2 ? 'purple' : 'cream'}, source asset-${turn}.`;
      rows.unshift({ ...row(turn * 2 - 1, correction + ' supporting historical design detail'.repeat(10)), role: 'user' });
      rows.unshift({ ...row(turn * 2, `acknowledged ${turn}`), role: 'assistant' });
      const history = historyClient(rows);
      const result = await compileMastraConversationContext({
        client: history.client, sessionId: id(9999), currentPrompt: 'continue', ...(snapshot ? { snapshot } : {}),
        limits: { ...limits, pageSize: 80, maxPages: 25, recentMessages: 4, maxContextBytes: 8000, summaryTargetBytes: 1000, summarizerInputBytes: 3000 },
        summarize: async ({ previousSummary, messages }) => {
          reductions++;
          if (turn % 7 === 0) throw new Error('injected summary outage');
          return `Older evidence available; ${messages.filter(m => m.role === 'user').at(-1)?.content.slice(0, 300) ?? previousSummary.slice(-300)}`;
        },
      });
      expect(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages }), 'utf8')).toBeLessThanOrEqual(8000);
      expect(result.messages.some(m => m.content.includes(correction))).toBe(true);
      expect(result.coverageMessageIds.length).toBeLessThanOrEqual(2000);
      if (result.omissions.some(v => v.includes('summary refresh was unavailable'))) fallbacks++;
      snapshot = { summary: result.summary, coverage: { messageIds: result.coverageMessageIds, omissions: result.omissions } };
    }
    expect(reductions).toBeGreaterThan(20);
    expect(fallbacks).toBeGreaterThan(0);
  });

  it("paginates but keeps a short ordinary conversation verbatim without summarization", async () => {
    const history = historyClient([8, 7, 6, 5, 4, 3, 2, 1].map(value => row(value)));
    const summarize = vi.fn(async ({ previousSummary, messages }: any) =>
      [previousSummary, messages.map((message: any) => message.id).join(",")].filter(Boolean).join("|"));

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      summarize,
      limits,
    });

    expect(history.range).toHaveBeenCalledTimes(3);
    expect(result.messages.map(message => message.id)).toEqual([id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8)]);
    expect(result.coverageMessageIds).toEqual([]);
    expect(result.summary).toBe("");
    expect(summarize).not.toHaveBeenCalled();
    expect(result.sourceExhausted).toBe(true);
    expect(result.omissions).toEqual([]);
    expect(history.chain.select).toHaveBeenCalledWith("id,role,content,created_at");
  });

  it("stops at a covered snapshot boundary and carries its summary forward", async () => {
    const history = historyClient([10, 9, 8, 7, 6, 5, 4].map(value => row(value)));
    const summarize = vi.fn(async ({ previousSummary, messages }: any) =>
      `${previousSummary}|${messages.map((message: any) => message.content).join(",")}`);

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      snapshot: { summary: "trusted older facts", coverage: { messageIds: [id(6)] } },
      summarize,
      limits,
    });

    expect(history.range).toHaveBeenCalledTimes(2);
    expect(result.messages.map(message => message.id)).toEqual([id(7), id(8), id(9), id(10)]);
    expect(result.summary).toBe("trusted older facts");
    expect(summarize).not.toHaveBeenCalled();
    expect(result.sourceExhausted).toBe(true);
    expect(result.coverageMessageIds).toEqual([id(6)]);
  });

  it("keeps one hundred short messages including the earliest without a model call", async () => {
    const history = historyClient(Array.from({ length: 100 }, (_, index) => row(100 - index, "ok")));
    const summarize = vi.fn(async () => "should not run");

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(200),
      currentPrompt: "new prompt",
      summarize,
    });

    expect(result.messages).toHaveLength(100);
    expect(result.messages[0]?.id).toBe(id(1));
    expect(result.messages.at(-1)?.id).toBe(id(100));
    expect(summarize).not.toHaveBeenCalled();
  });

  it("does not mistake filtered rows for database EOF", async () => {
    const invalid = { ...row(5), content: "" };
    const history = historyClient([invalid, row(4), row(3), row(2)]);

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      summarize: async () => "summary",
      limits,
    });

    expect(history.range).toHaveBeenCalledTimes(2);
    expect(result.messages.map(message => message.id)).toEqual([id(2), id(3), id(4)]);
    expect(result.sourceExhausted).toBe(true);
  });

  it("continues at the finite scan bound with an explicit evidence omission", async () => {
    const history = historyClient([5, 4, 3, 2, 1].map(value => row(value)));
    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      summarize: async ({ messages }) => messages.map(message => message.content).join(","),
      limits: { ...limits, maxPages: 1 },
    });

    expect(result.sourceExhausted).toBe(false);
    expect(result.messages.map(message => message.id)).toEqual([id(4), id(5)]);
    expect(result.coverageMessageIds).toEqual([id(3)]);
    expect(result.omissions[0]).toContain("conversation evidence tool");
  });

  it("removes the current durable user message without dropping an older duplicate prompt", async () => {
    const duplicate = "same prompt";
    const history = historyClient([
      { ...row(5, duplicate), role: "user" },
      row(4),
      { ...row(3, duplicate), role: "user" },
    ]);
    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: duplicate,
      currentUserMessageId: id(5),
      summarize: async ({ messages }) => messages.map(message => message.content).join(","),
      limits,
    });

    expect(result.messages.map(message => message.id)).toEqual([id(3), id(4)]);
    expect(result.messages.some(message => message.id === id(5))).toBe(false);
  });

  it("does not remove an older duplicate prompt when the newest row is not the current user message", async () => {
    const duplicate = "same prompt";
    const history = historyClient([
      { ...row(5, "new assistant text"), role: "assistant" },
      { ...row(4, duplicate), role: "user" },
    ]);

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: duplicate,
      summarize: async () => "summary",
      limits,
    });

    expect(result.messages.map(message => message.id)).toEqual([id(4), id(5)]);
  });

  it("reduces oversized text in bounded fragments instead of returning an oversized packet", async () => {
    const history = historyClient([row(2, "甲".repeat(3_000)), row(1, "older")]);
    const summarize = vi.fn(async ({ messages, priorSummaryFragment }: any) =>
      `facts:${messages.length}:${priorSummaryFragment?.length ?? 0}`);
    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      snapshot: { summary: "旧".repeat(1_000) },
      summarize,
      limits,
    });

    expect(summarize.mock.calls.length).toBeGreaterThan(2);
    expect(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages }), "utf8"))
      .toBeLessThanOrEqual(limits.maxContextBytes);
  });

  it.each([
    ["throws", async () => { throw new Error("summary provider unavailable"); }],
    ["returns empty text", async () => ""],
    ["remains oversized after a retry", async () => "x".repeat(limits.summaryTargetBytes + 1)],
  ])("keeps a bounded verbatim fallback when the summarizer %s", async (_case, summarize) => {
    const long = "historical detail ".repeat(100);
    const history = historyClient([
      { ...row(6, "literal current request"), role: "user" },
      row(5, long), row(4, long), row(3, long), row(2, long), row(1, long),
    ]);

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "literal current request",
      currentUserMessageId: id(6),
      snapshot: { summary: "trusted older facts", coverage: { messageIds: [id(1)] } },
      summarize: summarize as any,
      limits,
    });

    expect(result.summary).toBe("trusted older facts");
    expect(result.coverageMessageIds).toEqual([id(1)]);
    expect(result.messages.at(-1)?.id).toBe(id(5));
    expect(result.messages.some(message => message.id === id(6))).toBe(false);
    expect(result.omissions.some(item => item.includes("summary refresh was unavailable"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages }), "utf8"))
      .toBeLessThanOrEqual(limits.maxContextBytes);
  });

  it("drops an invalid prior summary but still returns recent bounded history after a summary failure", async () => {
    const long = "historical detail ".repeat(100);
    const history = historyClient([row(5, long), row(4, long), row(3, long), row(2, long), row(1, long)]);

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      snapshot: { summary: "x".repeat(limits.summaryTargetBytes + 1), coverage: { messageIds: [id(1)] } },
      summarize: async () => "",
      limits,
    });

    expect(result.summary).toBe("");
    expect(result.coverageMessageIds).toEqual([]);
    expect(result.messages.at(-1)?.id).toBe(id(5));
    expect(result.omissions.some(item => item.includes("was not used"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages }), "utf8"))
      .toBeLessThanOrEqual(limits.maxContextBytes);
  });

  it("keeps both the opening and latest correction when fallback truncates one oversized message", async () => {
    const history = historyClient([row(5, `OPENING REQUIREMENT ${"x".repeat(8_000)} LATEST CORRECTION: use 16:9`)]);

    const result = await compileMastraConversationContext({
      client: history.client,
      sessionId: id(20),
      currentPrompt: "new prompt",
      summarize: async () => "",
      limits,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toContain("OPENING REQUIREMENT");
    expect(result.messages[0]?.content).toContain("LATEST CORRECTION: use 16:9");
    expect(result.messages[0]?.content).toContain("[... historical message omitted ...]");
    expect(Buffer.byteLength(JSON.stringify({ summary: result.summary, messages: result.messages }), "utf8"))
      .toBeLessThanOrEqual(limits.maxContextBytes);
  });
});
