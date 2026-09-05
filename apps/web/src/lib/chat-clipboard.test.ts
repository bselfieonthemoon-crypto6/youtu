// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { preserveChatCopy } from "./chat-clipboard";

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("preserveChatCopy", () => {
  it("copies a rendered chat selection before canvas listeners can replace it", () => {
    const root = document.createElement("aside");
    const message = document.createElement("p");
    message.textContent = "可复制的对话文字";
    root.append(message);
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(message);
    const selection = window.getSelection();
    selection?.addRange(range);

    const setData = vi.fn();
    const event = {
      target: message,
      clipboardData: { setData },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as ClipboardEvent;

    expect(preserveChatCopy(event, root, selection)).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "可复制的对话文字");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("does not intercept a selection outside the chat sidebar", () => {
    const root = document.createElement("aside");
    const canvasText = document.createElement("p");
    canvasText.textContent = "画布文字";
    document.body.append(root, canvasText);

    const range = document.createRange();
    range.selectNodeContents(canvasText);
    const selection = window.getSelection();
    selection?.addRange(range);
    const event = {
      target: canvasText,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as ClipboardEvent;

    expect(preserveChatCopy(event, root, selection)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
