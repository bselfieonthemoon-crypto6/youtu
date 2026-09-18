// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DesignRoutingEvent } from "@loomic/shared";

import { ToastProvider } from "../src/components/toast";
import { useDesignRoutingNotice } from "../src/hooks/use-design-routing-notice";

let present: ((event: DesignRoutingEvent) => boolean) | undefined;

function Harness() {
  present = useDesignRoutingNotice().present;
  return <div>chat</div>;
}

function routedNotice(overrides: Partial<DesignRoutingEvent> = {}): DesignRoutingEvent {
  return {
    type: "design.routing",
    runId: "run-1",
    timestamp: "2026-09-15T00:00:00.000Z",
    intent: "new_generation",
    reasonCode: "explicit_creation",
    source: "deterministic",
    clamped: false,
    confidence: 1,
    summary: "识别为：活动海报与宣传图（命中 活动/海报）",
    detail: "判定依据：明确要求出图（新一轮生成）\n已预载助手指南：海报文案\n已启用非标准尺寸技能：非标准尺寸",
    primarySkill: "campaign-design",
    helperSkills: ["design-copywriting"],
    nonstandardSizeSkill: "nonstandard-image-size",
    ...overrides,
  };
}

function renderHarness() {
  present = undefined;
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  return () => present!;
}

afterEach(cleanup);

describe("useDesignRoutingNotice", () => {
  it("shows the routed Skill, the reason and the hidden preloads once", () => {
    const notice = renderHarness();
    act(() => { notice()(routedNotice()); });

    const text = document.body.textContent ?? "";
    expect(text).toContain("识别为：活动海报与宣传图（命中 活动/海报）");
    expect(text).toContain("已预载助手指南：海报文案");
    expect(text).toContain("已启用非标准尺寸技能：非标准尺寸");
    // One toast only: it never repeats per streaming chunk.
    expect(screen.getAllByText(/识别为：活动海报与宣传图/)).toHaveLength(1);
  });

  it("shows a model-authored verdict with its confidence", () => {
    const notice = renderHarness();
    act(() => {
      notice()(routedNotice({ source: "model", confidence: 0.88, clamped: false,
        detail: "判定依据：明确要求出图（模型判定 · 置信度 88%）" }));
    });
    expect(document.body.textContent).toContain("模型判定 · 置信度 88%");
  });

  it("ignores a reconnect replay of the same turn", () => {
    const notice = renderHarness();
    act(() => {
      notice()(routedNotice());
      notice()(routedNotice());
    });
    expect(screen.getAllByText(/识别为：活动海报与宣传图/)).toHaveLength(1);
    // A different turn still gets its own notice.
    act(() => { notice()(routedNotice({ runId: "run-2", summary: "识别为：品牌 Logo 设计（命中 logo）" })); });
    expect(screen.getAllByText(/识别为：/)).toHaveLength(2);
  });

  it("stays silent when the runtime reported no routing decision", () => {
    // A turn with no design decision emits nothing server-side, so the client
    // has no notice to render. Nothing here may invent one.
    renderHarness();
    expect(screen.queryByText(/识别为：/)).toBeNull();
    expect(screen.queryByText(/判定依据：/)).toBeNull();
  });
});
