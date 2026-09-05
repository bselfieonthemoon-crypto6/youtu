"use client";

import { ImageIcon, Layers3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readDesignNodeMetadata } from "../../lib/canvas-design";
import { fetchAssetBlob } from "../../lib/canvas-elements";

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
  accessToken,
  excalidrawApi,
}: {
  accessToken: string;
  excalidrawApi: DesignNodeOverlayApi;
}) {
  const [nodes, setNodes] = useState<DesignNodeView[]>([]);
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
      setNodes(next);
    };
    const schedule = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(refresh);
    };
    schedule();
    const unsubscribe = excalidrawApi.onChange?.(schedule);
    const unsubscribeScroll = excalidrawApi.onScrollChange?.(schedule);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      unsubscribe?.();
      unsubscribeScroll?.();
    };
  }, [excalidrawApi]);

  const assetKey = [
    ...new Set(nodes.flatMap((node) => (node.assetId ? [node.assetId] : []))),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    const assetIds = assetKey ? assetKey.split(",") : [];
    const controllers = new Map<string, AbortController>();
    const objectUrls: string[] = [];
    let active = true;
    let cursor = 0;
    setPreviews((current) => {
      const next: Record<string, PreviewEntry> = {};
      for (const assetId of assetIds)
        next[assetId] = current[assetId] ?? { status: "loading" };
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
      aria-hidden="true"
    >
      {nodes.map((node) => {
        const preview = node.assetId ? previews[node.assetId] : undefined;
        const stale = node.previewRevision < node.revision;
        return (
          <div
            key={node.elementId}
            data-testid="design-node-preview"
            data-design-id={node.designId}
            data-canvas-element-id={node.elementId}
            className="absolute flex select-none flex-col items-center justify-center overflow-hidden rounded-xl bg-card text-foreground shadow-sm"
            style={{
              left: node.x + 2,
              top: node.y + 2,
              width: Math.max(1, node.width - 4),
              height: Math.max(1, node.height - 4),
              transform: `rotate(${node.angle}deg)`,
            }}
          >
            {preview?.status === "ready" && preview.url ? (
              <img
                src={preview.url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <>
                {preview?.status === "error" ? (
                  <ImageIcon className="size-7 text-destructive/60" />
                ) : (
                  <Layers3 className="size-7 text-muted-foreground/60" />
                )}
                <span className="mt-2 text-xs font-medium">设计画板</span>
                <span className="mt-0.5 text-[10px] text-muted-foreground">
                  {preview?.status === "error"
                    ? "预览加载失败"
                    : stale
                      ? "预览待更新"
                      : "双击打开编辑"}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
