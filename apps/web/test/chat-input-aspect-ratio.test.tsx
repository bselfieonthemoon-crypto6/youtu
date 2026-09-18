// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "../src/components/chat-input";

vi.mock("../src/components/agent-model-selector", () => ({
  AgentModelSelector: () => <button type="button">Agent</button>,
}));

vi.mock("../src/components/image-model-preference", () => ({
  ImageModelPreferencePopover: () => null,
}));

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

describe("ChatInput aspect ratio selector", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
  });

  it("persists the selected ratio through the shared image preference", async () => {
    render(<ChatInput onSend={vi.fn()} />);

    const selector = screen.getByTestId("image-aspect-ratio-selector");
    expect(selector).toHaveAccessibleName("图片比例：自动");
    await userEvent.click(selector);
    await userEvent.click(screen.getByTestId("image-aspect-ratio-option-16-9"));

    expect(selector).toHaveAccessibleName("图片比例：16:9");
    expect(JSON.parse(localStorage.getItem("loomic:image-model-preference") ?? "{}")).toMatchObject({
      mode: "auto",
      models: [],
      aspectRatio: "16:9",
    });
  });
});
