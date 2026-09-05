"use client";

import "@excalidraw/excalidraw/index.css";

import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WebSocketHandle } from "../hooks/use-websocket";
import { buildInitialCanvasAppState } from "../lib/canvas-app-state";
import { localizeExcalidrawContextMenus } from "../lib/canvas-context-menu-i18n";
import {
  type DesignOpenTarget,
  findDesignPreviewOpenTarget,
  tombstonePastedDuplicateDesignNodes,
} from "../lib/canvas-design";
import {
  fetchAsDataURL,
  fetchAssetAsDataURL,
  isVideoUrl,
} from "../lib/canvas-elements";
import {
  createCanvasFileLoadQueue,
  visibleCanvasFileIds,
} from "../lib/canvas-file-loader";
import { normalizeCanvasElements } from "../lib/canvas-normalize";
import {
  canvasSaveDelay,
  deletionRevisionKey,
} from "../lib/canvas-save-policy";
import { getServerBaseUrl } from "../lib/env";
import { saveCanvas, uploadThumbnail } from "../lib/server-api";
import { CanvasToolMenu } from "./canvas-tool-menu";
import type { CanvasImageChatCommand } from "./canvas/image-toolbar-types";
import { VideoCanvasElement } from "./canvas/video-canvas-element";
import { DesignNodeOverlayLayer } from "./design/design-node-overlay-layer";
import { ErrorBoundary } from "./error-boundary";
import { useToast } from "./toast";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => mod.Excalidraw),
  { ssr: false },
);

// Safari <16.4 does not support requestIdleCallback — provide a fallback
// that defers via setTimeout(cb, 1) to approximate idle scheduling.
const ric: typeof requestIdleCallback =
  typeof window !== "undefined" && window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (cb: IdleRequestCallback) => setTimeout(cb, 1) as unknown as number;
const cic: typeof cancelIdleCallback =
  typeof window !== "undefined" && window.cancelIdleCallback
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout;

// Memoize CanvasToolMenu to prevent re-renders when parent state changes
// (e.g. selection changes in the editor don't need to re-render the toolbar)
const MemoizedCanvasToolMenu = memo(CanvasToolMenu);

export type CanvasSelectedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fileId?: string;
  dataUrl?: string;
  /** Supabase storage public URL -- prefer over dataUrl for message attachments */
  storageUrl?: string;
  assetId?: string;
  mimeType?: string;
  name?: string;
};

type CanvasEditorProps = {
  canvasId: string;
  projectId: string;
  accessToken: string;
  canvasRevision: number;
  initialContent: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  };
  onApiReady?: (api: any) => void;
  ws?: WebSocketHandle;
  leftPanelOpen?: boolean;
  onSelectionChange?: (elements: CanvasSelectedElement[]) => void;
  onImageChatCommand?: (command: CanvasImageChatCommand) => void;
  onCanvasRefreshRequest?: () => Promise<void>;
  onCanvasRevisionChange: (revision: number) => void;
  onOpenDesign?: (target: DesignOpenTarget) => void;
};

const THUMBNAIL_DEBOUNCE_MS = 10_000;
const THUMBNAIL_MAX_SIZE = 400;

export function CanvasEditor({
  canvasId,
  projectId,
  accessToken,
  canvasRevision,
  initialContent,
  onApiReady,
  ws,
  leftPanelOpen,
  onSelectionChange,
  onImageChatCommand,
  onCanvasRefreshRequest,
  onCanvasRevisionChange,
  onOpenDesign,
}: CanvasEditorProps) {
  const { resolvedTheme } = useTheme();
  const { error: showError } = useToast();
  const editorRootRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);
  const prevSelectedIdsRef = useRef<string>("");
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onOpenDesignRef = useRef(onOpenDesign);
  onOpenDesignRef.current = onOpenDesign;
  const onCanvasRevisionChangeRef = useRef(onCanvasRevisionChange);
  onCanvasRevisionChangeRef.current = onCanvasRevisionChange;
  const revisionStateRef = useRef({ canvasId, revision: canvasRevision });
  if (revisionStateRef.current.canvasId !== canvasId) {
    revisionStateRef.current = { canvasId, revision: canvasRevision };
  } else {
    revisionStateRef.current.revision = Math.max(
      revisionStateRef.current.revision,
      canvasRevision,
    );
  }
  const publishCanvasRevision = useCallback((revision: number) => {
    if (revision <= revisionStateRef.current.revision) return;
    revisionStateRef.current.revision = revision;
    onCanvasRevisionChangeRef.current(revision);
  }, []);
  // Tracks whether the one-time normalization pass has already run
  const normalizedRef = useRef(false);

  // Guard: prevent auto-save until Excalidraw has fully hydrated with initial data.
  // Without this, a page reload can fire onChange with empty elements before
  // initialData is applied, causing a FULL REPLACE that wipes existing content.
  const hydratedRef = useRef(false);
  const deletionRevisionKeyRef = useRef(
    deletionRevisionKey(initialContent.elements),
  );
  const previousSceneElementsRef = useRef<readonly Record<string, unknown>[]>(
    initialContent.elements,
  );

  // Track pending save payload so we can flush on tab close / unmount
  const pendingSaveRef = useRef<{
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  } | null>(null);

  // Ref to hold initialContent.files for storageUrl lookup in handleChange
  // without adding the full initialContent to the dependency array.
  const initialFilesRef = useRef(initialContent.files);
  initialFilesRef.current = initialContent.files;

  useEffect(() => {
    const root = editorRootRef.current;
    if (!root) return;

    const localizeMenus = () => localizeExcalidrawContextMenus(root);
    localizeMenus();
    const observer = new MutationObserver(localizeMenus);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Separate inline files (ready) from storage URLs (need async fetch)
  const { inlineFiles, pendingUrls } = useMemo(() => {
    const inline: Record<string, Record<string, unknown>> = {};
    const assetIdsByFile = new Map<string, string>();
    for (const element of initialContent.elements) {
      const fileId = element.fileId;
      const customData = element.customData as
        | Record<string, unknown>
        | undefined;
      if (
        typeof fileId === "string" &&
        typeof customData?.assetId === "string"
      ) {
        assetIdsByFile.set(fileId, customData.assetId);
      }
    }
    const pending: Array<{
      fileId: string;
      assetId?: string;
      storageUrl?: string;
      meta: Record<string, unknown>;
    }> = [];
    for (const [fileId, fileData] of Object.entries(initialContent.files)) {
      const assetId =
        typeof fileData.assetId === "string"
          ? fileData.assetId
          : assetIdsByFile.get(fileId);
      const storageUrl =
        typeof fileData.storageUrl === "string"
          ? fileData.storageUrl
          : undefined;
      if (assetId || storageUrl) {
        pending.push({
          fileId,
          ...(assetId ? { assetId } : {}),
          ...(storageUrl ? { storageUrl } : {}),
          meta: fileData,
        });
      } else {
        inline[fileId] = fileData;
      }
    }
    return { inlineFiles: inline, pendingUrls: pending };
  }, [initialContent.elements, initialContent.files]);

  // Load only files near the viewport. The queue bounds concurrency, retries
  // transient failures, and prefers stable authenticated asset URLs over
  // expiring signed URLs. Loaded previews stay in Excalidraw's file cache.
  useEffect(() => {
    if (!excalidrawApi || pendingUrls.length === 0) return;
    const pendingById = new Map(pendingUrls.map((file) => [file.fileId, file]));
    const queue = createCanvasFileLoadQueue({
      concurrency: 4,
      maxAttempts: 3,
      retryDelayMs: 500,
      async load(candidate, signal) {
        if (candidate.assetId) {
          return fetchAssetAsDataURL(
            accessTokenRef.current,
            candidate.assetId,
            {
              preview: true,
              signal,
            },
          );
        }
        if (candidate.storageUrl) return fetchAsDataURL(candidate.storageUrl);
        throw new Error("Canvas file has no readable source");
      },
      onLoaded(candidate, dataURL) {
        const detectedMimeType = /^data:([^;,]+)/.exec(dataURL)?.[1];
        excalidrawApi.addFiles([
          {
            id: candidate.meta.id ?? candidate.fileId,
            mimeType:
              detectedMimeType ?? candidate.meta.mimeType ?? "image/png",
            created: candidate.meta.created ?? Date.now(),
            dataURL,
          },
        ]);
      },
      onFailed(candidate, error) {
        console.warn(
          `[canvas-editor] Failed to resolve file ${candidate.fileId}:`,
          error,
        );
      },
    });

    let frame: number | null = null;
    const enqueueVisible = () => {
      frame = null;
      const loaded = excalidrawApi.getFiles() as Record<string, unknown>;
      const visibleIds = visibleCanvasFileIds(
        excalidrawApi.getSceneElements(),
        excalidrawApi.getAppState(),
      );
      queue.enqueue(
        visibleIds.flatMap((fileId) => {
          const candidate = pendingById.get(fileId);
          return candidate && !loaded[fileId] ? [candidate] : [];
        }),
      );
    };
    const scheduleVisible = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(enqueueVisible);
    };
    scheduleVisible();
    const unsubscribe = excalidrawApi.onScrollChange?.(scheduleVisible);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      unsubscribe?.();
      queue.dispose();
    };
  }, [excalidrawApi, pendingUrls]);

  const handleExcalidrawApi = useCallback(
    (api: any) => {
      setExcalidrawApi(api);
      onApiReady?.(api);
    },
    [onApiReady],
  );

  // Normalize agent-created elements on initial load.
  // Uses DOM text measurement to fix server-side approximation errors.
  useEffect(() => {
    if (!excalidrawApi || normalizedRef.current) return;
    normalizedRef.current = true;

    // Run normalization after Excalidraw has loaded fonts.
    // Store the handle so we can cancel on unmount to prevent memory leaks.
    const idleHandle = ric(() => {
      try {
        const sceneElements = excalidrawApi.getSceneElements();
        // Create mutable copies for normalization
        const mutableElements = sceneElements.map((el: any) => ({ ...el }));
        const { changed } = normalizeCanvasElements(mutableElements);

        if (changed) {
          console.log("[canvas-editor] normalized agent-created elements");
          excalidrawApi.updateScene({
            elements: mutableElements,
            captureUpdate: "NONE",
          });
          // Persist normalized elements to DB
          const files: Record<string, Record<string, unknown>> = {};
          const rawFiles = excalidrawApi.getFiles() as Record<string, any>;
          for (const [id, file] of Object.entries(rawFiles)) {
            files[id] = {
              id: file.id,
              dataURL: file.dataURL,
              mimeType: file.mimeType,
              created: file.created,
              storageRef: initialFilesRef.current[id]?.storageRef,
              assetId: initialFilesRef.current[id]?.assetId,
            };
          }
          const appState = excalidrawApi.getAppState();
          saveCanvas(accessTokenRef.current, canvasIdRef.current, {
            elements: mutableElements,
            appState: {
              viewBackgroundColor: appState.viewBackgroundColor,
              gridModeEnabled: appState.gridModeEnabled,
            },
            files,
          })
            .then(publishCanvasRevision)
            .catch((err: Error) =>
              console.warn("[canvas-editor] normalization save failed:", err),
            );
        }
      } catch (err) {
        console.warn("[canvas-editor] normalization failed:", err);
      }

      // Mark hydrated after normalization — auto-save is now safe.
      // Before this point, onChange may fire with incomplete element lists
      // during Excalidraw's internal initialization, which would cause a
      // FULL REPLACE with empty content and silently wipe existing data.
      previousSceneElementsRef.current = excalidrawApi.getSceneElements();
      hydratedRef.current = true;
    });
    return () => cic(idleHandle);
  }, [excalidrawApi, publishCanvasRevision]);

  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      // Skip auto-save until Excalidraw has fully hydrated with initial data.
      // During initialization, onChange may fire with empty/partial elements
      // which would wipe the persisted canvas via FULL REPLACE.
      if (!hydratedRef.current) return;

      const duplicateResult = tombstonePastedDuplicateDesignNodes(
        previousSceneElementsRef.current,
        elements,
      );
      if (duplicateResult.rejectedElementIds.length > 0) {
        const sanitizedElements = duplicateResult.elements;
        previousSceneElementsRef.current = sanitizedElements;
        excalidrawApi?.updateScene({
          elements: sanitizedElements,
          captureUpdate: "IMMEDIATELY",
        });
        showError("设计节点不能直接复制，请使用“复制设计”命令。");
        return;
      }
      previousSceneElementsRef.current = elements;

      // --- 1. Debounced save ---
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

      // Mark that a save is pending. The full payload is built lazily inside
      // the timeout to avoid constructing the files map on every drag frame.
      pendingSaveRef.current = { elements: [] as any, appState: {}, files: {} };

      const savePolicy = canvasSaveDelay(
        deletionRevisionKeyRef.current,
        elements,
      );
      deletionRevisionKeyRef.current = savePolicy.deletionKey;
      saveTimerRef.current = setTimeout(() => {
        // Build the full payload only when the debounce fires
        const files: Record<string, Record<string, unknown>> = {};
        if (excalidrawApi) {
          const rawFiles = excalidrawApi.getFiles() as Record<string, any>;
          for (const [id, file] of Object.entries(rawFiles)) {
            files[id] = {
              id: file.id,
              dataURL: file.dataURL,
              mimeType: file.mimeType,
              created: file.created,
              storageRef: initialFilesRef.current[id]?.storageRef,
              assetId: initialFilesRef.current[id]?.assetId,
            };
          }
        }
        const latestElements =
          excalidrawApi?.getSceneElementsIncludingDeleted?.() ?? elements;
        const content = {
          // Keep Excalidraw tombstones so the server can distinguish an
          // intentional deletion from an element added concurrently elsewhere.
          elements: latestElements as Record<string, unknown>[],
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
            gridModeEnabled: appState.gridModeEnabled,
          },
          files,
        };
        pendingSaveRef.current = content;

        saveCanvas(accessTokenRef.current, canvasId, content)
          .then((revision) => {
            publishCanvasRevision(revision);
            if (pendingSaveRef.current === content) {
              pendingSaveRef.current = null;
            }
          })
          .catch((err) => console.error("[canvas-editor] save failed:", err));
      }, savePolicy.delayMs);

      // --- 2. Debounced thumbnail (runs much less frequently than save) ---
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);
      thumbnailTimerRef.current = setTimeout(async () => {
        if (!excalidrawApi) return;
        try {
          const { exportToBlob } = await import("@excalidraw/excalidraw");
          const sceneElements = excalidrawApi.getSceneElements();
          const sceneFiles = excalidrawApi.getFiles();
          if (!sceneElements.length) return;

          const blob = await exportToBlob({
            elements: sceneElements,
            appState: { exportBackground: true },
            files: sceneFiles,
            mimeType: "image/webp",
            quality: 0.8,
            maxWidthOrHeight: THUMBNAIL_MAX_SIZE,
          });

          console.log(
            "[canvas-editor] uploading thumbnail, blob size:",
            blob.size,
          );
          await uploadThumbnail(accessTokenRef.current, projectId, blob);
          console.log("[canvas-editor] thumbnail uploaded OK");
        } catch (err) {
          console.warn(
            "[canvas-editor] thumbnail generation/upload failed:",
            err,
          );
        }
      }, THUMBNAIL_DEBOUNCE_MS);

      // --- 3. Selection change detection ---
      // Cheap string comparison avoids unnecessary downstream re-renders.
      const selectedIds = appState.selectedElementIds
        ? Object.keys(appState.selectedElementIds as Record<string, boolean>)
            .filter(
              (id) =>
                (appState.selectedElementIds as Record<string, boolean>)[id],
            )
            .sort()
            .join(",")
        : "";

      if (selectedIds !== prevSelectedIdsRef.current) {
        prevSelectedIdsRef.current = selectedIds;
        if (onSelectionChangeRef.current) {
          if (!selectedIds) {
            onSelectionChangeRef.current([]);
          } else {
            const idSet = new Set(selectedIds.split(","));
            const selFiles: Record<string, any> =
              excalidrawApi?.getFiles() ?? {};
            const selected: CanvasSelectedElement[] = elements
              .filter((el: any) => idSet.has(el.id) && !el.isDeleted)
              .map((el: any) => {
                const base: CanvasSelectedElement = {
                  id: el.id,
                  type: el.type,
                  x: el.x ?? 0,
                  y: el.y ?? 0,
                  width: el.width ?? 0,
                  height: el.height ?? 0,
                };
                if (el.type === "text" && el.text) {
                  base.text = el.text;
                }
                if (el.type === "image" && el.fileId) {
                  base.fileId = el.fileId;
                  const file = selFiles[el.fileId];
                  if (file?.dataURL) {
                    base.dataUrl = file.dataURL;
                  }
                  base.mimeType = file?.mimeType ?? "image/png";
                  // Prefer storage URL over base64 dataUrl for message attachments.
                  // Sources: 1) element customData (model-generated images)
                  //          2) initial canvas content files (server-resolved URLs)
                  const sUrl =
                    el.customData?.storageUrl ??
                    initialFilesRef.current[el.fileId]?.storageUrl;
                  if (typeof sUrl === "string" && sUrl) {
                    base.storageUrl = sUrl;
                  }
                  // The file entry owns the pixels currently rendered. Prefer
                  // its asset binding over possibly inherited element metadata.
                  const assetId =
                    initialFilesRef.current[el.fileId]?.assetId ??
                    el.customData?.assetId;
                  if (typeof assetId === "string" && assetId)
                    base.assetId = assetId;
                  base.name =
                    el.customData?.title ?? `Canvas image ${el.id.slice(0, 6)}`;
                }
                return base;
              });
            onSelectionChangeRef.current(selected);
          }
        }
      }
    },
    [canvasId, projectId, excalidrawApi, publishCanvasRevision, showError],
  );

  // Register screenshot RPC handler so the server can request canvas captures
  useEffect(() => {
    if (!ws || !excalidrawApi) return;

    const cleanup = ws.registerRPC("canvas.screenshot", async (params) => {
      const {
        mode,
        region,
        max_dimension = 1024,
      } = params as {
        mode: string;
        region?: { x: number; y: number; width: number; height: number };
        max_dimension?: number;
      };

      const allElements = excalidrawApi
        .getSceneElements()
        .filter((e: any) => !e.isDeleted);
      const appState = excalidrawApi.getAppState();
      const files = excalidrawApi.getFiles();

      let elements = allElements;

      if (mode === "region" && region) {
        elements = allElements.filter((el: any) => {
          const ex = (el.x as number) ?? 0;
          const ey = (el.y as number) ?? 0;
          const ew = (el.width as number) ?? 0;
          const eh = (el.height as number) ?? 0;
          return !(
            ex + ew < region.x ||
            ex > region.x + region.width ||
            ey + eh < region.y ||
            ey > region.y + region.height
          );
        });
      } else if (mode === "viewport") {
        const zoom = (appState.zoom?.value as number) ?? 1;
        const sx = -((appState.scrollX as number) ?? 0);
        const sy = -((appState.scrollY as number) ?? 0);
        const vw = ((appState.width as number) ?? 1920) / zoom;
        const vh = ((appState.height as number) ?? 1080) / zoom;
        elements = allElements.filter((el: any) => {
          const ex = (el.x as number) ?? 0;
          const ey = (el.y as number) ?? 0;
          const ew = (el.width as number) ?? 0;
          const eh = (el.height as number) ?? 0;
          return !(
            ex + ew < sx ||
            ex > sx + vw ||
            ey + eh < sy ||
            ey > sy + vh
          );
        });
      }

      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true },
        files,
        maxWidthOrHeight: max_dimension,
        mimeType: "image/png",
      });

      // Convert blob to base64 data URL directly (no upload needed --
      // the image is passed inline to the model for visual understanding)
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () =>
          reject(new Error("Failed to convert screenshot to data URL"));
        reader.readAsDataURL(blob);
      });

      const bmp = await createImageBitmap(blob);
      const width = bmp.width;
      const height = bmp.height;
      bmp.close();

      return { url: dataUrl, width, height };
    });

    return cleanup;
  }, [ws, excalidrawApi, canvasId]);

  useEffect(() => {
    if (!ws?.onDesignSync || !onCanvasRefreshRequest) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = ws.onDesignSync(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void onCanvasRefreshRequest();
      }, 100);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [onCanvasRefreshRequest, ws]);

  // Build a full save payload from current Excalidraw state.
  // Used by both beforeunload and unmount to flush pending changes.
  const buildSavePayload = useCallback(() => {
    if (!excalidrawApi) return null;
    // Never flush before hydration — Excalidraw may not have loaded elements yet
    if (!hydratedRef.current) return null;
    try {
      const sceneElements =
        excalidrawApi.getSceneElementsIncludingDeleted?.() ??
        excalidrawApi.getSceneElements();
      const rawFiles = excalidrawApi.getFiles() as Record<string, any>;
      const appState = excalidrawApi.getAppState();

      const files: Record<string, Record<string, unknown>> = {};
      for (const [id, file] of Object.entries(rawFiles)) {
        files[id] = {
          id: file.id,
          dataURL: file.dataURL,
          mimeType: file.mimeType,
          created: file.created,
          storageRef: initialFilesRef.current[id]?.storageRef,
          assetId: initialFilesRef.current[id]?.assetId,
        };
      }
      return {
        elements: sceneElements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridModeEnabled: appState.gridModeEnabled,
        },
        files,
      };
    } catch (err) {
      console.warn(
        "[canvas-editor] failed to build save payload on flush:",
        err,
      );
      return null;
    }
  }, [excalidrawApi]);

  // Keep buildSavePayload accessible without stale closures
  const buildSavePayloadRef = useRef(buildSavePayload);
  buildSavePayloadRef.current = buildSavePayload;

  // Flush pending save on page close (beforeunload) and component unmount
  useEffect(() => {
    const flushBeforeUnload = () => {
      if (!pendingSaveRef.current) return;

      // Build the real payload since pendingSaveRef may hold a placeholder
      const payload = buildSavePayloadRef.current();
      if (!payload) return;

      // Use fetch with keepalive to ensure the request survives page teardown.
      // keepalive requests are limited to 64 KiB total in-flight per page; for
      // canvases with very large embedded files this may exceed the limit, but
      // it's the best-effort approach -- sendBeacon has the same constraint.
      const url = `${getServerBaseUrl()}/api/canvases/${canvasIdRef.current}`;
      try {
        fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessTokenRef.current}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: payload }),
          keepalive: true,
        });
      } catch {
        // Best-effort -- nothing we can do if it fails during page teardown
      }
      pendingSaveRef.current = null;
    };

    window.addEventListener("beforeunload", flushBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);

      // Cancel pending debounce timers
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);

      // Flush pending save on component unmount (e.g. SPA navigation)
      if (pendingSaveRef.current) {
        const payload = buildSavePayloadRef.current();
        if (payload) {
          saveCanvas(accessTokenRef.current, canvasIdRef.current, payload)
            .then(publishCanvasRevision)
            .catch(console.error);
        }
        pendingSaveRef.current = null;
      }
    };
  }, [publishCanvasRevision]);

  // Render custom embeddable content for video elements on canvas.
  // Excalidraw calls this for every embeddable element; we intercept video URLs
  // and render an inline player, falling back to default for everything else.
  const renderEmbeddable = useCallback((element: any, _appState: any) => {
    const link = element?.link;
    if (typeof link === "string" && isVideoUrl(link)) {
      return (
        <VideoCanvasElement
          src={link}
          width={element.width ?? 640}
          height={element.height ?? 360}
        />
      );
    }
    // Return null to let Excalidraw handle non-video embeddables with default behavior
    return null;
  }, []);

  // Allow any URL as a valid embeddable so our video links are accepted
  const validateEmbeddable = useCallback(() => true, []);

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!excalidrawApi || !onOpenDesignRef.current) return;
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const previews = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          '[data-testid="design-node-preview"]',
        ),
      ).flatMap((element) => {
        const designId = element.dataset.designId;
        const canvasElementId = element.dataset.canvasElementId;
        if (!designId || !canvasElementId) return [];
        const rect = element.getBoundingClientRect();
        return [
          {
            designId,
            canvasElementId,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          },
        ];
      });
      const target = findDesignPreviewOpenTarget(previews, {
        x: event.clientX,
        y: event.clientY,
      });
      if (target) onOpenDesignRef.current(target);
    },
    [excalidrawApi],
  );

  return (
    <ErrorBoundary
      onError={(err) => console.error("[canvas-editor] render crashed:", err)}
    >
      <div
        ref={editorRootRef}
        data-testid="canvas-editor"
        className="h-full w-full relative"
        onDoubleClickCapture={handleDoubleClick}
      >
        <Excalidraw
          langCode="zh-CN"
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          initialData={{
            elements: initialContent.elements as any,
            appState: buildInitialCanvasAppState(
              initialContent.appState,
            ) as any,
            files: inlineFiles as any,
          }}
          onChange={handleChange}
          excalidrawAPI={handleExcalidrawApi}
          renderEmbeddable={renderEmbeddable}
          validateEmbeddable={validateEmbeddable}
        />
        {excalidrawApi && (
          <DesignNodeOverlayLayer
            accessToken={accessToken}
            excalidrawApi={excalidrawApi}
          />
        )}
        {excalidrawApi && (
          <MemoizedCanvasToolMenu
            accessToken={accessToken}
            canvasId={canvasId}
            canvasRevision={canvasRevision}
            excalidrawApi={excalidrawApi}
            leftPanelOpen={leftPanelOpen ?? false}
            {...(onImageChatCommand ? { onImageChatCommand } : {})}
            {...(onCanvasRefreshRequest ? { onCanvasRefreshRequest } : {})}
            onCanvasRevisionChange={publishCanvasRevision}
            {...(onOpenDesign ? { onOpenDesign } : {})}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
