"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ModelListStatus = "loading" | "ready" | "error";

export interface ModelListState<T> {
  status: ModelListStatus;
  models: T[];
  /** A user-facing sentence; never an upstream error code or raw server text. */
  error: string | null;
}

/**
 * One sentence for the state the user is actually in.
 *
 * The reported defect was that these two states looked identical: a workspace that has
 * no published models at all and a list that never loaded both rendered as an empty
 * picker. "Nothing is configured here" is actionable (an administrator has to publish a
 * model); "the list did not load" is a transient failure the user can retry.
 */
export const MODEL_LIST_LOAD_FAILED_MESSAGE = "模型列表加载失败，请检查网络后重试。";

export function modelListEmptyMessage(kind: "text" | "image" | "video") {
  const label = kind === "text" ? "对话" : kind === "image" ? "图片" : "视频";
  return `当前工作区还没有可用的${label}模型，请管理员在后台配置并发布模型。`;
}

export interface ModelListResult<T> extends ModelListState<T> {
  reload: () => void;
  /** The actionable sentence to show when the list legitimately loaded and is empty. */
  emptyMessage: string;
}

/**
 * Loads a model list for ONE identity.
 *
 * Two things matter here, both of them reported defects:
 *
 * - The state carries the identity it was loaded for. When the signed-in account (or its
 *   access token) changes, the list resets to `loading` and is re-derived for the new
 *   identity - the previous account's models are never reused.
 * - Responses are tagged with a request id, so a slow response for the previous identity
 *   cannot overwrite the new identity's list.
 */
export function useModelList<T>({
  enabled,
  identity,
  load,
  kind,
}: {
  enabled: boolean;
  identity: string | undefined;
  load: () => Promise<T[]>;
  kind: "text" | "image" | "video";
}): ModelListResult<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  const requestRef = useRef(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ModelListState<T>>({
    status: "loading",
    models: [],
    error: null,
  });

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;

    if (!enabled) {
      setState({ status: "ready", models: [], error: null });
      return;
    }

    // Drop the previous identity's list before the new one is known.
    setState({ status: "loading", models: [], error: null });

    void (async () => {
      try {
        const models = await loadRef.current();
        if (requestRef.current !== request) return;
        setState({ status: "ready", models, error: null });
      } catch {
        if (requestRef.current !== request) return;
        setState({
          status: "error",
          models: [],
          error: MODEL_LIST_LOAD_FAILED_MESSAGE,
        });
      }
    })();
  }, [enabled, identity, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  return { ...state, reload, emptyMessage: modelListEmptyMessage(kind) };
}
