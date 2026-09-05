"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { AgentExecutionMode } from "@loomic/shared";

export const EXECUTION_MODE_STORAGE_KEY = "loomic:execution-mode";
export const DEFAULT_EXECUTION_MODE: AgentExecutionMode = "fast";

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedMode: AgentExecutionMode = DEFAULT_EXECUTION_MODE;

function isExecutionMode(value: string | null): value is AgentExecutionMode {
  return value === "fast" || value === "thinking";
}

function emitChange() {
  for (const listener of listeners) listener();
}

function getSnapshot(): AgentExecutionMode {
  try {
    const raw = localStorage.getItem(EXECUTION_MODE_STORAGE_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedMode = isExecutionMode(raw) ? raw : DEFAULT_EXECUTION_MODE;
    }
  } catch {
    cachedMode = DEFAULT_EXECUTION_MODE;
  }
  return cachedMode;
}

function getServerSnapshot(): AgentExecutionMode {
  return DEFAULT_EXECUTION_MODE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === EXECUTION_MODE_STORAGE_KEY) {
      cachedRaw = undefined;
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useExecutionMode() {
  const executionMode = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setExecutionMode = useCallback((mode: AgentExecutionMode) => {
    try {
      localStorage.setItem(EXECUTION_MODE_STORAGE_KEY, mode);
    } catch {
      // Storage can be unavailable in privacy-restricted contexts. The app
      // remains usable with the fast default in that case.
    }
    cachedRaw = undefined;
    emitChange();
  }, []);

  return { executionMode, setExecutionMode };
}
