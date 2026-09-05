// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateImageDirectMock, insertImageOnCanvasMock } = vi.hoisted(() => ({
  generateImageDirectMock: vi.fn(),
  insertImageOnCanvasMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  generateImageDirect: generateImageDirectMock,
}));

vi.mock("../src/lib/canvas-elements", () => ({
  insertImageOnCanvas: insertImageOnCanvasMock,
}));

vi.mock("../src/hooks/use-generation-error-handler", () => ({
  useGenerationErrorHandler: () => ({ handleGenerationError: vi.fn(() => false) }),
}));

import { CanvasImageGenPanel } from "../src/components/canvas-image-gen-panel";

describe("CanvasImageGenPanel confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateImageDirectMock.mockResolvedValue({
      url: "https://example.com/image.png",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
  });

  it("asks for confirmation in plain Chinese before generation", async () => {
    const user = userEvent.setup();
    render(
      <CanvasImageGenPanel
        accessToken="token"
        excalidrawApi={{}}
        onClose={vi.fn()}
      />,
    );

    await user.type(
      screen.getByPlaceholderText("Describe the image you want to create..."),
      "红金配色的彩票文字 Logo",
    );
    await user.click(screen.getByRole("button", { name: "查看生成描述" }));

    expect(generateImageDirectMock).not.toHaveBeenCalled();
    expect(screen.getByText("准备生成一张这样的图片：")).toBeInTheDocument();
    expect(screen.getAllByText("红金配色的彩票文字 Logo")).toHaveLength(2);
    expect(screen.getByText("是否确认生成？")).toBeInTheDocument();
    expect(screen.queryByText(/gpt-image-2-all/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认生成" }));
    expect(generateImageDirectMock).toHaveBeenCalledWith(
      "token",
      "红金配色的彩票文字 Logo",
    );
  });
});
