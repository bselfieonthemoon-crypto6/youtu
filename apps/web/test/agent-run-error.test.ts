import { describe, expect, it } from "vitest";
import { agentContextErrorMessage, agentRunErrorMessage } from "../src/lib/agent-run-error";
import { agentStartErrorMessage } from "../src/lib/agent-start-error";

describe("public context recovery messages", () => {
  it.each([
    ["agent_context_budget_exceeded", "安全上下文预算"], ["agent_context_summary_failed", "长对话整理未成功"],
    ["agent_context_conflict", "最新要求继续"], ["agent_context_profile_invalid", "配置无效"],
    ["agent_context_profile_unavailable", "无法读取"], ["agent_context_scope_forbidden", "项目权限"],
  ])("renders %s from the existing run.failed details contract", (code, expected) => {
    const error = { code: "run_failed", message: "PRIVATE_PROVIDER_BODY", details: { reasonCode: code, automaticRetry: false } };
    expect(agentRunErrorMessage(error)).toContain(expected);
    expect(agentRunErrorMessage(error)).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(agentStartErrorMessage(Object.assign(new Error("PRIVATE_PROVIDER_BODY"), { code }))).toContain(expected);
  });
  it("keeps safe server Chinese guidance but does not show the old English generic failure", () => {
    expect(agentRunErrorMessage({ code: "run_failed", message: "网络连接异常，请检查网络后重试。" })).toBe("网络连接异常，请检查网络后重试。");
    expect(agentRunErrorMessage({ code: "run_failed", message: "Failed to get response." })).toContain("已有生成任务");
    expect(agentRunErrorMessage({ code: "run_failed", message: "Failed to get response." })).not.toContain("Failed to get response");
    expect(agentContextErrorMessage({ code: "__proto__" })).toBeNull();
  });
});

describe("transient upstream failure copy", () => {
  it("shows the server's status-specific text rather than the shorter local copy", () => {
    const error = {
      code: "run_failed",
      message: "模型服务暂时不可用（502），系统已自动重试仍未成功。这通常是上游临时抖动，稍后重试即可；本轮没有提交任何生成任务，不会产生扣费。",
      details: { reasonCode: "provider_unavailable", automaticRetry: false },
    };
    const shown = agentRunErrorMessage(error);
    // The status is the whole point: the generic table copy cannot name it.
    expect(shown).toContain("502");
    expect(shown).toContain("稍后重试");
    expect(shown).toContain("没有提交任何生成任务");
    expect(shown).toBe(error.message);
  });

  it("still falls back to the local table when only a reason code arrives", () => {
    expect(agentRunErrorMessage({ code: "run_failed", details: { reasonCode: "provider_rate_limited" } }))
      .toContain("稍等");
    expect(agentRunErrorMessage({ code: "run_failed", details: { reasonCode: "agent_context_budget_exceeded" } }))
      .toContain("安全上下文预算");
    // A non-display-ready payload must never be preferred over the table.
    expect(agentRunErrorMessage({ code: "run_failed", message: "<html>502 Bad Gateway</html>", details: { reasonCode: "provider_unavailable" } }))
      .toContain("模型服务暂时不可用");
  });

  it("keeps the single-toast gate for a transient failure", () => {
    // chat-sidebar adds a second "switch model" toast only when this returns
    // null. A transient upstream failure already has its own retry copy, so it
    // must count as recognized and must not stack a second toast on top.
    expect(agentContextErrorMessage({ code: "run_failed", message: "模型服务暂时不可用（502）" })).toBeNull();
    expect(agentContextErrorMessage({ code: "run_failed", details: { reasonCode: "provider_unavailable" } }))
      .toContain("稍后重试");
  });
});
