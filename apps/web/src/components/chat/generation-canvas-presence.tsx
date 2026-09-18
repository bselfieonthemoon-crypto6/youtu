"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type SceneApi = {
  getSceneElementsIncludingDeleted: () => readonly { id: string; isDeleted?: boolean; customData?: { jobId?: string; sourceJobId?: string } }[];
  onChange: (listener: () => void) => () => void;
};

// Deleted elements count as accounted for: the recovery UI must not undo a
// user's deletion. This is display state, not permission to restore a job.
export function generationSceneKeys(elements: ReturnType<SceneApi["getSceneElementsIncludingDeleted"]>): string[] {
  return [...new Set(elements.flatMap(element => [element.id, element.customData?.jobId, element.customData?.sourceJobId]
    .filter((id): id is string => typeof id === "string" && id.length > 0)))].sort();
}

const Presence = createContext<(() => ReadonlySet<string> | null)>(() => null);

export function GenerationCanvasPresenceProvider({ api, children }: { api: SceneApi | null; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<{ api: SceneApi; key: string } | null>(null);
  useEffect(() => {
    if (!api?.getSceneElementsIncludingDeleted || !api.onChange) return;
    const update = () => {
      const key = JSON.stringify(generationSceneKeys(api.getSceneElementsIncludingDeleted()));
      setSnapshot(previous => previous?.api === api && previous.key === key ? previous : { api, key });
    };
    update();
    return api.onChange(update);
  }, [api]);
  const read = useMemo(() => () => {
    if (!api || snapshot?.api !== api) return null;
    // Re-read at click time too, including changes made since the last render.
    return new Set(generationSceneKeys(api.getSceneElementsIncludingDeleted()));
  }, [api, snapshot]);
  return <Presence.Provider value={read}>{children}</Presence.Provider>;
}

export function useGenerationCanvasPresence() { return useContext(Presence); }
