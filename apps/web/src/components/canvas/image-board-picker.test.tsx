import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageBoardPicker } from "./image-board-picker";

afterEach(cleanup);

const image = { id: "image", fileId: "file", x: 120, y: 120, width: 20, height: 20, mimeType: "image/png" };
const boards = [
  { elementId: "inside", designId: "one", name: "封面", x: 100, y: 100, width: 100, height: 100 },
  { elementId: "outside", designId: "two", name: "详情页", x: 300, y: 100, width: 100, height: 100 },
];

describe("ImageBoardPicker", () => {
  it("requires an explicit board choice and uses adopt only for contained images", async () => {
    const onChoose = vi.fn();
    render(<ImageBoardPicker image={image} boards={boards} busy={false} onChoose={onChoose} onCreate={vi.fn()} onClose={vi.fn()} onHighlight={vi.fn()} />);
    expect(screen.getByText(/不会自动复制图片/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "加入此画板" }));
    expect(onChoose).toHaveBeenCalledWith(boards[0], "adopt");
    await userEvent.click(screen.getByRole("button", { name: "添加到画板" }));
    expect(onChoose).toHaveBeenLastCalledWith(boards[1], "copy");
  });

  it("highlights targets on hover and clears the highlight when leaving", async () => {
    const onHighlight = vi.fn();
    render(<ImageBoardPicker image={image} boards={boards} busy={false} onChoose={vi.fn()} onCreate={vi.fn()} onClose={vi.fn()} onHighlight={onHighlight} />);
    await userEvent.hover(screen.getByText("封面"));
    expect(onHighlight).toHaveBeenCalledWith(boards[0]);
    await userEvent.unhover(screen.getByRole("dialog"));
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });
});
