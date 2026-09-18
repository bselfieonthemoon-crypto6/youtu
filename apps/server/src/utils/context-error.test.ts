import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_ERROR_MESSAGES, contextErrorForClient } from "./context-error.js";
import { sanitizeErrorForClient, sanitizeRunErrorForClient } from "./error-sanitizer.js";

afterEach(() => vi.restoreAllMocks());

describe("safe context failure guidance", () => {
  it.each(Object.entries(CONTEXT_ERROR_MESSAGES))("maps %s to static Chinese guidance without raw details", (code, message) => {
    const error = Object.assign(new Error("PRIVATE_SOURCE_TEXT provider sk-private-value"), { code, estimatedInputTokens: 800000 });
    expect(contextErrorForClient(error)).toEqual({ code, message });
    expect(sanitizeErrorForClient(error)).toBe(message);
    expect(sanitizeRunErrorForClient(error)).toEqual({ code: "run_failed", message, details: { reasonCode: code, automaticRetry: false } });
    expect(JSON.stringify(sanitizeRunErrorForClient(error))).not.toMatch(/PRIVATE_SOURCE|sk-private|800000/);
  });
  it("unwraps framework causes without losing the precise reason", () => {
    const inner = Object.assign(new Error("details"), { code: "agent_context_budget_exceeded" });
    const wrapped = new Error("LangChain wrapper", { cause: new Error("nested", { cause: inner }) });
    expect(sanitizeRunErrorForClient(wrapped).details?.reasonCode).toBe("agent_context_budget_exceeded");
  });
  it("supports safe code-only errors and bounds cyclic or unrelated cause chains", () => {
    expect(contextErrorForClient(new Error("agent_context_scope_forbidden"))?.code).toBe("agent_context_scope_forbidden");
    const cycle: Record<string, unknown> = { code: "unknown" }; cycle.cause = cycle;
    expect(contextErrorForClient(cycle)).toBeNull();
    expect(contextErrorForClient(new Error("prefix agent_context_conflict arbitrary message"))).toBeNull();
  });
  it("retains the generic sanitizer for unrelated provider errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(sanitizeRunErrorForClient(new Error("OpenAI upstream private body"))).toEqual({ code: "run_failed", message: "AI 服务暂时不可用，请稍后重试。" });
  });
});
