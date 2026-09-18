"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ImageGenerationPreference } from "@loomic/shared";

const STORAGE_KEY = "loomic:image-model-preference";
export type ImageModelPreference = ImageGenerationPreference;

const defaultPreference: ImageModelPreference = {
  mode: "auto",
  models: [],
  aspectRatio: "auto",
};

const aspectRatios = new Set<NonNullable<ImageModelPreference["aspectRatio"]>>([
  "auto",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
]);

// Listeners for cross-component reactivity
const listeners = new Set<() => void>();
function emitChange() {
  for (const listener of listeners) listener();
}

// Cache parsed result — useSyncExternalStore requires stable references
let cachedRaw: string | null = null;
let cachedPreference: ImageModelPreference = defaultPreference;

function getSnapshot(): ImageModelPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedPreference = raw
        ? normalizePreference(JSON.parse(raw) as Partial<ImageModelPreference> & { model?: string })
        : defaultPreference;
    }
    return cachedPreference;
  } catch {
    return defaultPreference;
  }
}

function getServerSnapshot(): ImageModelPreference {
  return defaultPreference;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function normalizePreference(
  preference?: Partial<ImageModelPreference> & { model?: string },
): ImageModelPreference {
  if (!preference) return defaultPreference;

  const models = Array.isArray(preference.models)
    ? preference.models.filter(
        (model): model is string =>
          typeof model === "string" && model.trim().length > 0,
      )
    : typeof preference.model === "string" && preference.model.trim().length > 0
      ? [preference.model]
      : defaultPreference.models;

  return {
    mode: preference.mode === "manual" ? "manual" : "auto",
    models,
    // Older stored preferences did not have an aspect ratio. Treat them as
    // automatic rather than allowing an unvalidated value into run payloads.
    aspectRatio:
      typeof preference.aspectRatio === "string" && aspectRatios.has(preference.aspectRatio as NonNullable<ImageModelPreference["aspectRatio"]>)
        ? preference.aspectRatio as NonNullable<ImageModelPreference["aspectRatio"]>
        : "auto",
  };
}

export function useImageModelPreference() {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setPreference = useCallback((next: ImageModelPreference) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    emitChange();
  }, []);

  const setMode = useCallback(
    (mode: "auto" | "manual") => {
      setPreference({ ...preference, mode });
    },
    [preference, setPreference],
  );

  const toggleModel = useCallback(
    (model: string) => {
      const isSelected = preference.models.includes(model);

      if (isSelected && preference.models.length === 1) {
        return;
      }

      const models = isSelected
        ? preference.models.filter((item) => item !== model)
        : [...preference.models, model];

      setPreference({
        ...preference,
        mode: "manual",
        models,
      });
    },
    [preference, setPreference],
  );

  const setAspectRatio = useCallback(
    (aspectRatio: NonNullable<ImageModelPreference["aspectRatio"]>) => {
      setPreference({ ...preference, aspectRatio });
    },
    [preference, setPreference],
  );

  // Image generation needs the ratio preference even while model selection is
  // automatic, so a run can distinguish an automatic ratio from a user choice.
  const activeImageGenerationPreference = preference;

  return {
    preference,
    setPreference,
    setMode,
    toggleModel,
    setAspectRatio,
    activeImageGenerationPreference,
  };
}
