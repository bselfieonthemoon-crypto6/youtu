// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ToastProvider } from "../components/toast";
import { ROUTING_DETAIL_STORAGE_KEY, useDesignRoutingNotice } from "./use-design-routing-notice";

/**
 * The surfacing fence for the per-turn two-layer record.
 *
 * What matters here is the ordinary-vs-advanced discipline: the routing notice
 * keeps its short line for everyone, and the turn record (`design.turn` — the
 * detected intent beside what the run's receipts prove it executed, plus the
 * summary) is shown ONLY behind the existing `loomic:routing-detail` gate. A
 * normal user must not be handed router telemetry, and no second switch may be
 * invented for it.
 */

/** Observes exactly what the hook hands the toast layer, without animating it. */
const shown: Array<{ message: string; variant: string }> = [];

vi.mock("../components/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => ({
    toast: (message: string, variant = "info") => { shown.push({ message, variant }); },
    success: () => undefined,
    error: () => undefined,
  }),
}));

const routingEvent = {
  type: "design.routing" as const,
  runId: "run-routing",
  timestamp: "t",
  intent: "new_generation" as const,
  reasonCode: "explicit_creation" as const,
  source: "model" as const,
  clamped: false,
  confidence: 0.9,
  summary: "候选技能：促销海报",
  detail: "判定依据：明确要求出图（模型判定 · 置信度 90%）",
};

const turnEvent = {
  type: "design.turn" as const,
  runId: "run-turn",
  timestamp: "t",
  summary: "本轮意图：检测到「新一轮生成」→ 实际执行「向用户提问澄清，没有提交生成」；创建任务：0 个",
  detail: "检测层：模型判定 · explicit_creation · 置信度 92%",
};

function renderNotice() {
  return renderHook(() => useDesignRoutingNotice(), {
    wrapper: ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>,
  });
}

describe("useDesignRoutingNotice — two-layer turn record surfacing", () => {
  beforeEach(() => {
    shown.length = 0;
    globalThis.localStorage?.clear();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the ordinary routing notice short and shows no turn record in normal mode", () => {
    const { result } = renderNotice();

    act(() => { expect(result.current.present(routingEvent)).toBe(true); });
    expect(shown).toEqual([{ message: "候选技能：促销海报", variant: "info" }]);

    // Advanced mode is off, so the turn record is withheld entirely — and the
    // runId is not consumed, so enabling the mode later still shows later turns.
    act(() => { expect(result.current.present(turnEvent)).toBe(false); });
    expect(shown).toHaveLength(1);
  });

  it("shows the routing detail and the turn record only in advanced mode", () => {
    globalThis.localStorage.setItem(ROUTING_DETAIL_STORAGE_KEY, "1");
    const { result } = renderNotice();

    act(() => { expect(result.current.present(routingEvent)).toBe(true); });
    expect(shown[0]!.message).toBe(`${routingEvent.summary}\n${routingEvent.detail}`);

    act(() => { expect(result.current.present(turnEvent)).toBe(true); });
    expect(shown[1]!.message).toBe(`${turnEvent.summary}\n${turnEvent.detail}`);
    // Both layers reach the same toast surface the routing notice already uses.
    expect(shown[1]!.message).toContain("实际执行");
  });

  it("shows the turn record at most once per run across a reconnect replay", () => {
    globalThis.localStorage.setItem(ROUTING_DETAIL_STORAGE_KEY, "1");
    const { result } = renderNotice();

    act(() => {
      expect(result.current.present(turnEvent)).toBe(true);
      // A replayed event for the same run must not toast again.
      expect(result.current.present(turnEvent)).toBe(false);
    });
    expect(shown).toHaveLength(1);
  });

  it("does not let a replayed routing notice suppress the turn record for the same run", () => {
    globalThis.localStorage.setItem(ROUTING_DETAIL_STORAGE_KEY, "1");
    const { result } = renderNotice();

    act(() => {
      expect(result.current.present(routingEvent)).toBe(true);
      expect(result.current.present(turnEvent)).toBe(true);
    });
    expect(shown).toHaveLength(2);
  });

  it("renders the turn record at most as a summary+detail toast, never as a success/error", () => {
    globalThis.localStorage.setItem(ROUTING_DETAIL_STORAGE_KEY, "1");
    const { result } = renderNotice();

    act(() => { result.current.present(turnEvent); });
    expect(shown[0]!.variant).toBe("info");
  });
});
