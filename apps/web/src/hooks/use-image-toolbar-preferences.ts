"use client";

import { useCallback, useEffect, useState } from "react";
import type { ImageToolbarActionId } from "../components/canvas/image-toolbar-types";

const STORAGE_KEY = "loomic:image-toolbar:v2";

export const IMAGE_TOOLBAR_ACTIONS: ReadonlyArray<{
  id: ImageToolbarActionId;
  label: string;
  available: boolean;
}> = [
  { id: "replace-text", label: "文字替换", available: true },
  { id: "regenerate", label: "重新生成", available: true },
  { id: "crop", label: "裁剪", available: true },
  { id: "upscale", label: "高清", available: true },
  { id: "remove-background", label: "去除背景", available: true },
  { id: "split-layers", label: "图层拆分", available: true },
  { id: "add-to-chat", label: "添加到对话", available: true },
  { id: "details", label: "详细信息", available: true },
  { id: "download", label: "下载", available: true },
  { id: "edit-region", label: "框选编辑", available: false },
  { id: "panorama", label: "生成全景图", available: false },
  { id: "erase", label: "局部重绘", available: true },
  { id: "outpaint", label: "扩图", available: true },
] as const;

export type ImageToolbarPreferences = {
  pinned: ImageToolbarActionId[];
  showLabels: boolean;
};

export const DEFAULT_IMAGE_TOOLBAR_PREFERENCES: ImageToolbarPreferences = {
  pinned: ["replace-text", "regenerate", "crop", "upscale", "remove-background", "split-layers", "download"],
  showLabels: true,
};

const validIds = new Set(IMAGE_TOOLBAR_ACTIONS.filter((item) => item.available).map((item) => item.id));

export function normalizeImageToolbarPreferences(value: unknown): ImageToolbarPreferences {
  if (!value || typeof value !== "object") return DEFAULT_IMAGE_TOOLBAR_PREFERENCES;
  const raw = value as Partial<ImageToolbarPreferences>;
  const pinned = Array.isArray(raw.pinned)
    ? raw.pinned.filter((id): id is ImageToolbarActionId => typeof id === "string" && validIds.has(id as ImageToolbarActionId))
    : DEFAULT_IMAGE_TOOLBAR_PREFERENCES.pinned;
  return {
    pinned: [...new Set(pinned)].slice(0, 7),
    showLabels: typeof raw.showLabels === "boolean" ? raw.showLabels : true,
  };
}

export function useImageToolbarPreferences() {
  const [preferences, setPreferencesState] = useState<ImageToolbarPreferences>(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setPreferencesState(normalizeImageToolbarPreferences(JSON.parse(stored)));
    } catch {
      setPreferencesState(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);
    }
  }, []);

  const setPreferences = useCallback((next: ImageToolbarPreferences) => {
    const normalized = normalizeImageToolbarPreferences(next);
    setPreferencesState(normalized);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Preferences still apply for this session when storage is unavailable.
    }
  }, []);

  const reset = useCallback(() => setPreferences(DEFAULT_IMAGE_TOOLBAR_PREFERENCES), [setPreferences]);
  return { preferences, setPreferences, reset };
}
