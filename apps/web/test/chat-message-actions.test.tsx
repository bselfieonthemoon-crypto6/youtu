import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessage } from "../src/components/chat-message";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const blocks = [{ type: "text" as const, text: "生成一个画板，658*176" }];

describe("user message actions", () => {
  it("copies exact text and acknowledges success without sending", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const send = vi.fn();
    render(<ChatMessage role="user" contentBlocks={blocks} onEditSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    await screen.findByRole("button", { name: "已复制" });
    expect(writeText).toHaveBeenCalledWith(blocks[0]!.text);
    expect(send).not.toHaveBeenCalled();
  });
  it("edits inline, cancels without changing history, and starts fresh next time", () => {
    const send = vi.fn();
    render(<ChatMessage role="user" contentBlocks={blocks} onEditSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    expect(screen.getByRole("textbox", { name: "编辑消息" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new text" } });
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(screen.getByText(blocks[0]!.text)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    expect(screen.getByRole("textbox")).toHaveValue(blocks[0]!.text);
  });
  it("rejects empty edits, guards double clicks, and preserves draft after rejection", async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<ChatMessage role="user" contentBlocks={blocks} onEditSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "发送编辑后的消息" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "生成 800*600" } });
    fireEvent.click(screen.getByRole("button", { name: "发送编辑后的消息" }));
    fireEvent.click(screen.getByRole("button", { name: "发送编辑后的消息" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("生成 800*600");
    await act(async () => reject(new Error("连接已断开")));
    expect(screen.getByRole("textbox")).toHaveValue("生成 800*600");
    expect(screen.getByText("连接已断开")).toBeInTheDocument();
  });
  it("updates disabled state through the memo boundary but keeps copy available", () => {
    const send = vi.fn();
    const { rerender } = render(<ChatMessage role="user" contentBlocks={blocks} onEditSend={send} />);
    rerender(<ChatMessage role="user" contentBlocks={blocks} onEditSend={send} editDisabled />);
    expect(screen.getByRole("button", { name: "编辑消息" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "复制消息" })).toBeEnabled();
  });
  it("does not submit while composing Chinese and closes only after successful send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ChatMessage role="user" contentBlocks={blocks} onEditSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送编辑后的消息" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
