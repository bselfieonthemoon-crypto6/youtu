// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GeneratingOverlay } from "../src/components/canvas/generating-overlay";

afterEach(cleanup);

describe("GeneratingOverlay", () => {
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
});
