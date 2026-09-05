// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecutionModeSelector } from "../src/components/execution-mode-selector";
import {
  EXECUTION_MODE_STORAGE_KEY,
  useExecutionMode,
} from "../src/hooks/use-execution-mode";

function installStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

describe("execution mode preference", () => {
  beforeEach(() => installStorage());

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("defaults to fast and persists thinking mode", () => {
    const { result } = renderHook(() => useExecutionMode());
    expect(result.current.executionMode).toBe("fast");

    act(() => result.current.setExecutionMode("thinking"));

    expect(result.current.executionMode).toBe("thinking");
    expect(localStorage.getItem(EXECUTION_MODE_STORAGE_KEY)).toBe("thinking");
  });

  it("lets the user switch between Fast and Thinking", async () => {
    render(<ExecutionModeSelector />);
    const selector = screen.getByRole("combobox", { name: "执行模式" });
    expect(selector).toHaveValue("fast");

    await userEvent.selectOptions(selector, "thinking");

    expect(selector).toHaveValue("thinking");
    expect(localStorage.getItem(EXECUTION_MODE_STORAGE_KEY)).toBe("thinking");
  });
});
