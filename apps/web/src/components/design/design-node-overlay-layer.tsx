"use client";

import { ImageIcon, Layers3 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LoomicSceneV1 } from "@loomic/shared";
import { DesignAnimationPreview } from "./design-animation-preview";

import { readDesignNodeMetadata } from "../../lib/canvas-design";
import { designBoardLabel } from "../../lib/design-board-label";
import { DesignNameButton } from "./design-name-button";
import { fetchAssetBlob } from "../../lib/canvas-elements";
import { createDesignApiClient } from "../../lib/design-api";

export const DESIGN_PREVIEW_REFRESH_EVENT = 'loomic:design-preview-refresh';
const designClient = createDesignApiClient();

type DesignNodeView = {
  elementId: string;
  designId: string;
  assetId: string | null;
  revision: number;
  previewRevision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
};

type PreviewEntry = { status: "loading" | "ready" | "error"; url?: string };

type DesignNodeElement = {
  id?: unknown;
  isDeleted?: unknown;
  customData?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  angle?: unknown;
};

type DesignNodeOverlayApi = {
  getAppState?: () => {
    zoom?: { value?: number };
    scrollX?: number;
    scrollY?: number;
    width?: number;
    height?: number;
  };
  getSceneElements?: () => readonly DesignNodeElement[];
  onChange?: (listener: () => void) => (() => void) | undefined;
  onScrollChange?: (listener: () => void) => (() => void) | undefined;
};

export function DesignNodeOverlayLayer({
  editingDesignId = null,
  accessToken,
  excalidrawApi,
  onNormalizeNode,
}: {
  editingDesignId?: string | null;
  accessToken: string;
  excalidrawApi: DesignNodeOverlayApi;
  onNormalizeNode?: (elementId: string, aspectRatio?: number) => void;
}) {
  const normalizeRef = useRef(onNormalizeNode);
  normalizeRef.current = onNormalizeNode;
  const [nodes, setNodes] = useState<DesignNodeView[]>([]);
  const [authoritative, setAuthoritative] = useState<Record<string, {
    assetId: string | null; revision: number; previewRevision: number; name?: string; scene?: LoomicSceneV1;
  }>>({});
  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({});
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!excalidrawApi) return;
    const refresh = () => {
      frameRef.current = null;
      const state = excalidrawApi.getAppState?.() ?? {};
      const zoom = Number(state.zoom?.value ?? 1);
      const scrollX = Number(state.scrollX ?? 0);
      const scrollY = Number(state.scrollY ?? 0);
      const viewportWidth = Number(state.width ?? window.innerWidth);
      const viewportHeight = Number(state.height ?? window.innerHeight);
      const next = (excalidrawApi.getSceneElements?.() ?? []).flatMap(
        (element): DesignNodeView[] => {
          if (element?.isDeleted) return [];
          const metadata = readDesignNodeMetadata(element);
          if (!metadata) return [];
          normalizeRef.current?.(String(element.id));
          const x = (Number(element.x ?? 0) + scrollX) * zoom;
          const y = (Number(element.y ?? 0) + scrollY) * zoom;
          const width = Number(element.width ?? 0) * zoom;
          const height = Number(element.height ?? 0) * zoom;
          if (
            x + width < -64 ||
            y + height < -64 ||
            x > viewportWidth + 64 ||
            y > viewportHeight + 64
          )
            return [];
          return [
            {
              elementId: String(element.id),
              designId: metadata.designId,
              assetId: metadata.previewAssetObjectId,
              revision: metadata.revision,
              previewRevision: metadata.previewRevision,
              x,
              y,
              width,
              height,
              angle: Number(element.angle ?? 0),
            },
          ];
        },
      );
      setNodes(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const schedule = () => {
      // Coalesce notifications without repeatedly postponing the pending frame.
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(refresh);
    };
    schedule();
    const unsubscribe = excalidrawApi.onChange?.(schedule);
    const unsubscribeScroll = excalidrawApi.onScrollChange?.(schedule);
    // Pointer movement can update Excalidraw before its batched onChange fires.
    // Read live geometry on the next paint as well, including release/resize.
    window.addEventListener('pointermove', schedule, { passive: true });
    window.addEventListener('pointerup', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const catchUp = window.setInterval(schedule, 250);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      window.removeEventListener('pointermove', schedule);
      window.removeEventListener('pointerup', schedule);
      window.removeEventListener('resize', schedule);
      window.clearInterval(catchUp);
      unsubscribe?.();
      unsubscribeScroll?.();
    };
  }, [excalidrawApi]);

  const designKey = [...new Set(nodes.map(node => node.designId))].sort().join(',');
  useEffect(() => {
    let active = true, running = false, again = false, attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = designKey ? designKey.split(',') : [];
    setAuthoritative({});
    const refresh = async () => {
      if (!active || !ids.length) return;
      if (running) { again = true; return; }
      running = true;
      let stale = false, cursor = 0;
      const worker = async () => {
        while (active && cursor < ids.length) {
          const id = ids[cursor++]!;
          try {
            const doc = await designClient.getDesign(accessToken, id);
            if (!active) return;
            stale ||= doc.preview_revision < doc.revision || !doc.preview_asset_object_id;
            setAuthoritative(current => ({ ...current, [id]: {
              assetId: doc.preview_asset_object_id, revision: doc.revision, previewRevision: doc.preview_revision,
              name: doc.name,
              scene: doc.scene,
            } }));
          } catch { /* Preserve the existing bitmap; retry on focus/finish. */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      running = false;
      if (active && (again || (stale && ++attempts < 30))) {
        again = false;
        timer = setTimeout(() => void refresh(), 1500);
      }
    };
    const requestRefresh = () => {
      if (timer) clearTimeout(timer);
      attempts = 0;
      void refresh();
    };
    const visible = () => { if (!document.hidden) requestRefresh(); };
    requestRefresh();
    window.addEventListener(DESIGN_PREVIEW_REFRESH_EVENT, requestRefresh);
    window.addEventListener('focus', requestRefresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener(DESIGN_PREVIEW_REFRESH_EVENT, requestRefresh);
      window.removeEventListener('focus', requestRefresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [accessToken, designKey]);

  // Render from authoritative design metadata even when Excalidraw has not
  // emitted a change (or its snapshot still refers to the template preview).
  const displayNodes = nodes.map(node => {
    const latest = authoritative[node.designId];
    if (!latest || latest.previewRevision < node.previewRevision) return node;
    if (!latest.assetId) return { ...node, revision: Math.max(node.revision, latest.revision) };
    return { ...node, ...latest, revision: Math.max(node.revision, latest.revision) };
  });
  const assetKey = [
    ...new Set(displayNodes.flatMap((node) => (node.assetId ? [node.assetId] : []))),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    const assetIds = assetKey ? assetKey.split(",") : [];
    const controllers = new Map<string, AbortController>();
    const objectUrls: string[] = [];
    let active = true;
    let cursor = 0;
    setPreviews(() => {
      const next: Record<string, PreviewEntry> = {};
      for (const assetId of assetIds)
        next[assetId] = { status: "loading" };
      return next;
    });

    const load = async (assetId: string) => {
      const controller = new AbortController();
      controllers.set(assetId, controller);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const blob = await fetchAssetBlob(accessToken, assetId, {
            preview: true,
            signal: controller.signal,
          });
          if (!active) return;
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          setPreviews((current) => ({
            ...current,
            [assetId]: { status: "ready", url },
          }));
          return;
        } catch {
          if (controller.signal.aborted) return;
          if (attempt < 2)
            await new Promise((resolve) =>
              setTimeout(resolve, 250 * 2 ** attempt),
            );
        }
      }
      if (active)
        setPreviews((current) => ({
          ...current,
          [assetId]: { status: "error" },
        }));
    };

    const worker = async () => {
      while (cursor < assetIds.length && active) {
        const assetId = assetIds[cursor++];
        if (assetId) await load(assetId);
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(4, assetIds.length) }, () => worker()),
    );
    return () => {
      active = false;
      for (const controller of controllers.values()) controller.abort();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [accessToken, assetKey]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {displayNodes.map((node) => {
        const preview = node.assetId ? previews[node.assetId] : undefined;
        const stale = node.previewRevision < node.revision;
        // Use screen-space bounds so both resizing the node and zooming out
        // shrink the entire hint together, without wrapping its text.
        const placeholderScale = Math.max(0, Math.min(1, node.width / 200, node.height / 200));
        return (
          <div
            key={node.elementId}
            data-testid="design-node-preview"
            data-design-id={node.designId}
            data-canvas-element-id={node.elementId}
            className="absolute flex select-none flex-col items-center justify-center text-foreground"
            style={{
              left: node.x,
              top: node.y,
              width: Math.max(1, node.width),
              height: Math.max(1, node.height),
              transform: `rotate(${node.angle}rad)`,
              // Keep layout available to the inline editor, but never paint
              // the cached bitmap underneath its transparent live surface.
              visibility: node.designId === editingDesignId ? "hidden" : "visible",
            }}
          >
            <span title={`画板 ID：${node.designId}`} className="absolute bottom-full left-0 mb-1 flex items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground">
              <Layers3 className="size-3" /><DesignNameButton
                name={authoritative[node.designId]?.name ?? "未命名设计"}
                label={designBoardLabel(node.designId, authoritative[node.designId]?.name)}
                onRename={async (name) => {
                  const latest = await designClient.getDesign(accessToken, node.designId);
                  const result = await designClient.renameDesign(accessToken, {
                    design_id: node.designId, expected_revision: latest.revision,
                    idempotency_key: crypto.randomUUID(), name,
                  });
                  setAuthoritative(current => ({ ...current, [node.designId]: {
                    assetId: latest.preview_asset_object_id, previewRevision: latest.preview_revision,
                    revision: result.revision, name, scene: latest.scene,
                  } }));
                  await designClient.queueDesignPreview(accessToken, { design_id: node.designId,
                    expected_revision: result.revision, idempotency_key: crypto.randomUUID() }).catch(() => undefined);
                  window.dispatchEvent(new Event(DESIGN_PREVIEW_REFRESH_EVENT));
                }} />
            </span>
            <BoardAnimationLayer accessToken={accessToken} scene={authoritative[node.designId]?.scene} editing={node.designId === editingDesignId}>
            {preview?.status === "ready" && preview.url ? (
              <img
                src={preview.url}
                alt=""
                className="h-full w-full object-contain"
                onLoad={(event) => {
                  const img = event.currentTarget;
                  if (!stale && img.naturalWidth && img.naturalHeight)
                    normalizeRef.current?.(node.elementId, img.naturalWidth / img.naturalHeight);
                }}
              />
            ) : (
              <div
                data-testid="design-node-placeholder"
                className="flex h-20 w-40 shrink-0 flex-col items-center justify-center whitespace-nowrap"
                style={{ transform: `scale(${placeholderScale})`, transformOrigin: "center" }}
              >
                {preview?.status === "error" ? (
                  <ImageIcon className="size-7 shrink-0 text-destructive/60" />
                ) : (
                  <Layers3 className="size-7 shrink-0 text-muted-foreground/60" />
                )}
                <span className="mt-2 text-xs font-medium">设计画板</span>
                <span className="mt-0.5 text-[10px] text-muted-foreground">
                  {preview?.status === "error"
                    ? "预览加载失败"
                    : stale
                      ? "预览待更新"
                      : "双击打开编辑"}
                </span>
              </div>
            )}
            {stale && preview?.status === "ready" && (
              <span className="absolute bottom-0 left-0 bg-background/90 px-1 text-[10px] text-muted-foreground">
                预览待更新
              </span>
            )}
            </BoardAnimationLayer>
          </div>
        );
      })}
    </div>
  );
}

function BoardAnimationLayer({ accessToken, scene, editing, children }: {
  accessToken: string; scene: LoomicSceneV1 | undefined; editing: boolean; children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  return <div className="relative flex h-full w-full items-center justify-center">
    <div className="absolute inset-0 flex items-center justify-center" style={{ visibility: ready && !editing ? "hidden" : "inherit" }}>{children}</div>
    {!editing && scene && <DesignAnimationPreview scene={scene} resolveAsset={object => fetchAssetBlob(accessToken, object.assetObjectId)} pauseSignal={0} autoPlay={false} onReady={setReady} />}
  </div>;
}
