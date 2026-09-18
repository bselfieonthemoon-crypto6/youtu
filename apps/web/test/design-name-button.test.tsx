import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesignNameButton } from "../src/components/design/design-name-button";
afterEach(cleanup);
it("renames with trimmed input and supports cancellation", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<DesignNameButton name="原名称" onRename={save} />);
  fireEvent.click(screen.getByRole("button", { name: "重命名画板" }));
  fireEvent.change(screen.getByLabelText("画板名称"), { target: { value: "  新名称  " } });
  fireEvent.click(screen.getByText("保存名称"));
  await waitFor(() => expect(save).toHaveBeenCalledWith("新名称"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "重命名画板" }));
  fireEvent.click(screen.getByText("取消"));
  expect(save).toHaveBeenCalledTimes(1);
});
it("keeps the dialog open for invalid input and a failed request", async () => {
  const save = vi.fn().mockRejectedValue(new Error("网络错误"));
  render(<DesignNameButton name="原名称" onRename={save} />);
  fireEvent.click(screen.getByRole("button", { name: "重命名画板" }));
  fireEvent.change(screen.getByLabelText("画板名称"), { target: { value: " " } });
  fireEvent.click(screen.getByText("保存名称"));
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("画板名称"), { target: { value: "新名称" } });
  fireEvent.click(screen.getByText("保存名称"));
  expect(await screen.findByRole("alert")).toHaveTextContent("网络错误");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
