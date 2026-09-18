// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GeneratingOverlay } from "../src/components/canvas/generating-overlay";

afterEach(cleanup);

describe("GeneratingOverlay", () => {
  it("shows canceled placeholders without a failure or shimmer", () => {
    const { container, getByText, queryByText } = render(<GeneratingOverlay id="canceled" screenX={0} screenY={0} screenW={300} screenH={200} status="error" canceled />);
    expect(getByText("生成已取消")).toBeVisible();
    expect(queryByText("生成失败")).toBeNull();
    expect(container.querySelector(".animate-shimmer-scan")).toBeNull();
  });
  it("stays in the canvas stacking context instead of a viewport portal", () => {
    const { container } = render(
      <div className="relative overflow-hidden">
        <GeneratingOverlay
          id="job-node"
          screenX={760}
          screenY={120}
          screenW={320}
          screenH={240}
          label="正在生成图片…"
        />
      </div>,
    );

    const overlay = container.querySelector('[data-canvas-generating-overlay="job-node"]');
    expect(overlay).toHaveClass("absolute");
    expect(overlay).not.toHaveClass("fixed");
    expect(overlay).toHaveStyle({ left: "760px", top: "120px", zIndex: "5" });
  });

  it.each([0.1, 0.2, 0.5, 1, 2])("scales the whole status layout with canvas zoom %s", (zoom) => {
    const { container, getByText } = render(
      <GeneratingOverlay id="scaled" screenX={20} screenY={30}
        screenW={300 * zoom} screenH={200 * zoom} zoom={zoom}
        model="local/feynobg" label="正在拆分图层…" />,
    );
    const content = container.querySelector('[data-generating-content]');
    expect(content).toHaveStyle({ width: "300px", height: "200px", transform: `scale(${zoom})`, transformOrigin: "top left" });
    expect(content).toContainElement(getByText("正在拆分图层…"));
    expect(content).toContainElement(getByText("Feynobg"));
    expect(content?.querySelector("svg")).toBeTruthy();
    expect(container.querySelector('[data-canvas-generating-overlay]')).toHaveStyle({ width: `${300 * zoom}px`, height: `${200 * zoom}px` });
  });

  it("updates scale when zoom changes, including failed jobs", () => {
    const props = { id: "failed", screenX: 0, screenY: 0, status: "error" as const };
    const { container, rerender, getByText } = render(<GeneratingOverlay {...props} screenW={300} screenH={200} zoom={1} />);
    rerender(<GeneratingOverlay {...props} screenW={60} screenH={40} zoom={0.2} />);
    expect(container.querySelector('[data-generating-content]')).toHaveStyle({ width: "300px", transform: "scale(0.2)" });
    expect(getByText("生成失败")).toBeVisible();
    expect(container.querySelector('.animate-shimmer-scan')).toBeNull();
  });
});
