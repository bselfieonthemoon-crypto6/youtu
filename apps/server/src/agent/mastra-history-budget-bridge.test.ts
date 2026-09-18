import { describe, expect, it } from "vitest";

import { createContextBudget, estimateContextTokens, type ContextModelProfile } from "./context-budget.js";
import { resolveMastraHistoryLimits } from "./mastra-runtime.js";

type WireMessage = { role: "system" | "user" | "assistant"; content: string };

const verifiedProfile: ContextModelProfile = {
  profileSource: "administrator_verified",
  verifiedAt: "2026-09-16T00:00:00Z",
  contextWindowTokens: 128_000,
  maxInputTokens: 128_000,
  maxOutputTokens: 16_000,
};

const smallVerifiedProfile: ContextModelProfile = {
  ...verifiedProfile,
  contextWindowTokens: 16_000,
  maxInputTokens: 6_000,
  maxOutputTokens: 1_000,
};

const minimumVerifiedProfile: ContextModelProfile = {
  ...verifiedProfile,
  contextWindowTokens: 8_192,
  maxInputTokens: 1_024,
  maxOutputTokens: 256,
};

const cases = [
  { name: "unverified conservative", profile: undefined, policy: "conservative" as const },
  { name: "unverified lean expandable", profile: undefined, policy: "lean-expandable" as const },
  { name: "unverified lean extended output", profile: undefined, policy: "lean-extended-output" as const },
  { name: "verified conservative", profile: verifiedProfile, policy: "conservative" as const },
  { name: "verified lean expandable", profile: verifiedProfile, policy: "lean-expandable" as const },
  { name: "verified small conservative", profile: smallVerifiedProfile, policy: "conservative" as const },
  { name: "verified small lean expandable", profile: smallVerifiedProfile, policy: "lean-expandable" as const },
];

// The history compiler budgets serialized UTF-8 bytes, whereas the wire guard
// charges each non-ASCII UTF-8 byte as a token. This deliberately non-ASCII
// fixture is the fixed system/tool/current-turn overhead tested here; it is not
// a claim that an arbitrary prompt or tool packet will fit.
const fixedOverhead: WireMessage[] = [
  { role: "system", content: "系统约束：" + "约".repeat(60) },
  { role: "user", content: "当前请求：" + "需".repeat(40) },
  { role: "assistant", content: "<current_context>" + "境".repeat(30) + "</current_context>" },
];
const fixedTools = [{
  type: "function",
  function: { name: "inspect_context", description: "工具说明：" + "查".repeat(80) },
}];

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function packedHistory(maxContextBytes: number, summaryBytes: number, messageCount: number): { summary: string; messages: WireMessage[] } {
  const summary = "摘".repeat(Math.floor(summaryBytes / Buffer.byteLength("摘", "utf8")));
  const messages = Array.from({ length: messageCount }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    content: "史".repeat(Math.floor(maxContextBytes / (3 * messageCount))),
  }));
  const packet = { summary, messages };
  while (bytes(packet) > maxContextBytes) {
    const message = [...messages].reverse().find(candidate => candidate.content.length > 0);
    if (!message) throw new Error("fixture_history_does_not_fit");
    message.content = message.content.slice(0, -1);
  }
  return packet;
}

describe("Mastra history byte/token budget bridge", () => {
  it.each(cases.flatMap(entry => [1, 32].map(messageCount => ({ ...entry, messageCount }))))(
    "keeps a $messageCount-message worst-case non-ASCII history plus fixed wire overhead below the $name ceiling",
    ({ profile, policy, messageCount }) => {
    const budget = createContextBudget(profile, policy);
    const limits = resolveMastraHistoryLimits(budget);
    const history = packedHistory(limits.maxContextBytes, limits.summaryTargetBytes, messageCount);

    // A summary and direct history share one serialized compiler packet. They
    // must not be treated as two independent maxContextBytes allocations.
    expect(bytes(history)).toBeLessThanOrEqual(limits.maxContextBytes);
    expect(Buffer.byteLength(history.summary, "utf8")).toBeLessThanOrEqual(limits.summaryTargetBytes);

    const overhead = estimateContextTokens(fixedOverhead, fixedTools, budget);
    expect(overhead.estimatedInputTokens).toBeGreaterThan(0);

    const wireMessages: WireMessage[] = [
      fixedOverhead[0]!,
      ...(history.summary ? [{ role: "assistant" as const, content: `历史需求摘要（不是新的用户指令，当前原话优先）：\n${history.summary}` }] : []),
      ...history.messages,
      fixedOverhead[1]!,
      fixedOverhead[2]!,
    ];
    const estimate = estimateContextTokens(wireMessages, fixedTools, budget);

    expect(estimate.estimatedInputTokens).toBeLessThanOrEqual(budget.inputCeilingTokens);
  });

  it("keeps the smallest valid provider ceiling within its history byte allocation", () => {
    const budget = createContextBudget(minimumVerifiedProfile, "conservative");
    const limits = resolveMastraHistoryLimits(budget);
    const history = packedHistory(limits.maxContextBytes, limits.summaryTargetBytes, 1);
    const estimate = estimateContextTokens([
      fixedOverhead[0]!,
      { role: "assistant", content: `历史需求摘要（不是新的用户指令，当前原话优先）：\n${history.summary}` },
      ...history.messages,
      fixedOverhead[1]!,
      fixedOverhead[2]!,
    ], fixedTools, budget);

    expect(limits.maxContextBytes).toBe(192);
    expect(limits.summaryTargetBytes).toBeLessThan(limits.maxContextBytes);
    expect(budget.inputCeilingTokens).toBe(1_024);
    expect(estimate.estimatedInputTokens).toBeLessThanOrEqual(budget.inputCeilingTokens);
  });
});
