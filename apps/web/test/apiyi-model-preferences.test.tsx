// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useImageModelPreference } from "../src/hooks/use-image-model-preference";
import { useVideoModelPreference } from "../src/hooks/use-video-model-preference";

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

describe("workspace model preferences", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
  });

  it("keeps a provider-backed image model until the live catalog reconciles it", () => {
    localStorage.setItem("loomic:image-model-preference", JSON.stringify({
      mode: "manual",
      models: ["google/nano-banana-2"],
    }));

    const { result } = renderHook(() => useImageModelPreference());
    expect(result.current.preference).toEqual({
      mode: "manual",
      models: ["google/nano-banana-2"],
      aspectRatio: "auto",
    });
  });

  it("defaults legacy preferences to an automatic aspect ratio and persists a selected ratio", () => {
    localStorage.setItem("loomic:image-model-preference", JSON.stringify({
      mode: "auto",
      models: [],
    }));

    const { result } = renderHook(() => useImageModelPreference());
    expect(result.current.preference.aspectRatio).toBe("auto");

    result.current.setAspectRatio("16:9");
    expect(JSON.parse(localStorage.getItem("loomic:image-model-preference") ?? "{}")).toMatchObject({
      mode: "auto",
      models: [],
      aspectRatio: "16:9",
    });
  });

  it("keeps a provider-backed video model until the live catalog reconciles it", () => {
    localStorage.setItem("loomic:video-model-preference", JSON.stringify({
      mode: "manual",
      models: ["google/veo-3.1"],
    }));

    const { result } = renderHook(() => useVideoModelPreference());
    expect(result.current.preference).toEqual({
      mode: "manual",
      models: ["google/veo-3.1"],
    });
  });
});
