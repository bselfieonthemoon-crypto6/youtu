// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignSelectionToolbar } from "./design-selection-toolbar";

afterEach(cleanup);

const design = {
  designId: "24fb3221-cb46-4878-b729-cd3299e1f18e",
  canvasElementId: "design-node",
  x: 20,
  y: 30,
  width: 320,
  height: 180,
  screenBounds: { x: 20, y: 80, width: 320, height: 180, viewportWidth: 1000 },
};

describe("DesignSelectionToolbar", () => {
  it("exposes production open and copy actions", async () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    render(
      <DesignSelectionToolbar
        design={design}
        copying={false}
        onOpen={onOpen}
        onCopy={onCopy}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开设计" }));
    await userEvent.click(screen.getByRole("button", { name: "复制设计" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("prevents a second copy while the request is in flight", () => {
    render(
      <DesignSelectionToolbar
        design={design}
        copying
        onOpen={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "复制中…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
