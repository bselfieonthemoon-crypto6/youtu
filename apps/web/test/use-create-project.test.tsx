// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_EXECUTION_MODE_KEY,
  useCreateProject,
} from "../src/hooks/use-create-project";

const { createProjectMock, pushMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
  }),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    session: { access_token: "token" },
    signOut: vi.fn(),
  }),
}));

vi.mock("../src/components/toast", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("../src/lib/server-api", () => ({
  ApiAuthError: class ApiAuthError extends Error {},
  createProject: createProjectMock,
}));

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

describe("useCreateProject canvas handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: createStorage(),
    });
    vi.spyOn(window, "open").mockImplementation(() => null);
    createProjectMock.mockResolvedValue({
      project: { primaryCanvas: { id: "canvas-new" } },
    });
  });

  it("stores the selected mode before navigating to the auto-send canvas", async () => {
    const { result } = renderHook(() => useCreateProject());

    await act(() =>
      result.current.create({
        prompt: "design a logo",
        executionMode: "thinking",
      }),
    );

    expect(sessionStorage.getItem(INITIAL_EXECUTION_MODE_KEY)).toBe("thinking");
    expect(pushMock).toHaveBeenCalledWith(
      "/canvas?id=canvas-new&prompt=design%20a%20logo",
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("navigates in the current tab instead of leaving a placeholder tab", async () => {
    const { result } = renderHook(() => useCreateProject());

    await act(() => result.current.create({ prompt: "设计logo" }));

    expect(window.open).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith(
      `/canvas?id=canvas-new&prompt=${encodeURIComponent("设计logo")}`,
    );
  });
});
