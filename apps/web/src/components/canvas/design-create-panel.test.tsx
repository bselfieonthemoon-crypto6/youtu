// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignCreatePanel } from "./design-create-panel";

afterEach(cleanup);

describe("DesignCreatePanel", () => {
  it("submits a blank design and keeps the request id stable across retry", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce(undefined);
    render(<DesignCreatePanel onClose={vi.fn()} onCreate={onCreate} />);

    await userEvent.click(screen.getByRole("button", { name: "创建设计" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "网络中断",
    );
    await userEvent.click(screen.getByRole("button", { name: "创建设计" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      width: 1080,
      height: 1080,
      background: "#ffffff",
    });
    expect(onCreate.mock.calls[1]?.[0].requestId).toBe(
      onCreate.mock.calls[0]?.[0].requestId,
    );
  });

  it("validates integer dimensions and closes with Escape", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn();
    render(<DesignCreatePanel onClose={onClose} onCreate={onCreate} />);

    const width = screen.getByLabelText("设计宽度");
    await userEvent.clear(width);
    await userEvent.type(width, "10.5");
    await userEvent.click(screen.getByRole("button", { name: "创建设计" }));
    expect(screen.getByRole("alert").textContent).toContain("整数像素");
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
