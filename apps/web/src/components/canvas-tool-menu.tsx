"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Circle,
  Hand,
  ImageUp,
  LayoutTemplate,
  Minus,
  MousePointer2,
  Pencil,
  Sparkles,
  Square,
  Type,
  Video,
} from "lucide-react";

import {
  createImageGeneratorElement,
  isImageGeneratorElement,
  getImageGeneratorData,
  type ImageGeneratorData,
} from "../lib/canvas-image-generator";
import {
  createVideoGeneratorElement,
  isVideoGeneratorElement,
  getVideoGeneratorData,
  type VideoGeneratorData,
} from "../lib/canvas-video-generator";
import {
  createExcalidrawImageElement,
  fetchAsDataURL,
  fetchAssetAsDataURL,
  fetchAssetBlob,
  isVideoUrl,
} from "../lib/canvas-elements";
import { ImageGeneratorPanel } from "./canvas/image-generator-panel";
import { VideoGeneratorPanel } from "./canvas/video-generator-panel";
import { VideoPlayerPanel } from "./canvas/video-player-panel";
import { ImageSelectionToolbar } from "./canvas/image-selection-toolbar";
import { calculate2KResolution } from "./canvas/image-action-dialog";
import { ImageCropResolutionPanel } from "./canvas/image-crop-resolution-panel";
import { ImageRegionMattingOverlay } from "./canvas/image-region-matting-overlay";
import {
  ImageEraserOverlay,
  type ImageEraseMode,
} from "./canvas/image-eraser-overlay";
import { GeneratingOverlay } from "./canvas/generating-overlay";
import {
  renderEraseMask,
  type NormalizedEraseStroke,
} from "../lib/image-eraser";
import type {
  CanvasImageChatCommand,
  SelectedCanvasImage,
} from "./canvas/image-toolbar-types";
import { useToast } from "./toast";
import {
  createImageGenerationJob,
  fetchImageModels,
  fetchJob,
  getAssetUrl,
  recognizeCanvasImageText,
} from "../lib/server-api";
import {
  getDesignCopyPlacement,
  getDesignNodePlacement,
  getOrCreateDesignCopyAttempt,
  readDesignNodeMetadata,
  type DesignOpenTarget,
} from "../lib/canvas-design";
import { DesignApiError, createDesignApiClient } from "../lib/design-api";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import {
  readGenerationJobElementId,
  waitForGenerationJob,
} from "../hooks/use-job-fallback-polling";
import {
  createImageReplacementElement,
  isImageReplacementElement,
  updateImageReplacementElement,
} from "../lib/canvas-image-replacement";
import {
  getImageCropResolution,
  getImageNaturalSize,
  readImageNaturalSize,
  renderImageCrop,
  resizeImageCrop,
  setImageNaturalSize,
  type NormalizedImageRegion,
} from "../lib/canvas-image-crop";
import {
  DesignCreatePanel,
  type BlankDesignInput,
} from "./canvas/design-create-panel";
import {
  DesignSelectionToolbar,
  type SelectedCanvasDesign,
} from "./canvas/design-selection-toolbar";

const designApi = createDesignApiClient();

const GENERATION_MONITOR_MAX_TRANSIENT_RETRIES = 3;
const GENERATION_MONITOR_BASE_RETRY_DELAY_MS = 500;

type CropSaveGuard = {
  begin: () => number | null;
  cancel: () => void;
  complete: (generation: number) => void;
  isCurrent: (generation: number) => boolean;
};

export function createCropSaveGuard(): CropSaveGuard {
  let generation = 0;
  let pending = false;

  return {
    begin() {
      if (pending) return null;
      pending = true;
      generation += 1;
      return generation;
    },
    cancel() {
      generation += 1;
      pending = false;
    },
    complete(operationGeneration) {
      if (generation === operationGeneration) pending = false;
    },
    isCurrent(operationGeneration) {
      return pending && generation === operationGeneration;
    },
  };
}

type GenerationJobMonitorDependencies = {
  waitForJob?: typeof waitForGenerationJob;
  fetchJobById?: typeof fetchJob;
  sleep?: (milliseconds: number) => Promise<void>;
  onAttemptStarted?: () => void;
  onAttemptFinished?: () => void;
  maxTransientRetries?: number;
  finalizationPollAttempts?: number;
};

export async function monitorCanvasGenerationJob(
  accessToken: string,
  jobId: string,
  dependencies: GenerationJobMonitorDependencies = {},
) {
  const waitForJob = dependencies.waitForJob ?? waitForGenerationJob;
  const fetchJobById = dependencies.fetchJobById ?? fetchJob;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxTransientRetries =
    dependencies.maxTransientRetries ??
    GENERATION_MONITOR_MAX_TRANSIENT_RETRIES;
  const finalizationPollAttempts = dependencies.finalizationPollAttempts ?? 30;
  let transientFailures = 0;

  while (true) {
    dependencies.onAttemptStarted?.();
    let attemptError: unknown;
    try {
      let job = await waitForJob(accessToken, jobId);
      if (job.status === "succeeded") {
        for (
          let attempt = 0;
          attempt < finalizationPollAttempts;
          attempt += 1
        ) {
          if (readGenerationJobElementId(job)) break;
          await sleep(1_000);
          job = (await fetchJobById(accessToken, jobId)).job;
        }
      }
      return job;
    } catch (error) {
      attemptError = error;
    } finally {
      dependencies.onAttemptFinished?.();
    }

    if (transientFailures >= maxTransientRetries) throw attemptError;
    const retryDelay = Math.min(
      4_000,
      GENERATION_MONITOR_BASE_RETRY_DELAY_MS * 2 ** transientFailures,
    );
    transientFailures += 1;
    await sleep(retryDelay);
  }
}

type CropSession = {
  elementId: string;
  originalElement: any;
  width: number;
  height: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth?: number;
  };
};

type RegionMattingSession = {
  imageId: string;
  bounds: { x: number; y: number; width: number; height: number };
  angle: number;
};

type EraserSession = RegionMattingSession;

type ToolType =
  | "hand"
  | "selection"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image";

const TOOL_GROUPS: (ToolType | null)[] = [
  "hand",
  "selection",
  null,
  "rectangle",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  null,
  "text",
  "image",
];

const TOOL_ICONS: Record<
  ToolType,
  React.ComponentType<{ className?: string }>
> = {
  hand: Hand,
  selection: MousePointer2,
  rectangle: Square,
  ellipse: Circle,
  arrow: ArrowUpRight,
  line: Minus,
  freedraw: Pencil,
  text: Type,
  image: ImageUp,
};

const TOOL_LABELS: Record<ToolType, string> = {
  hand: "拖拽画布 (H)",
  selection: "选择 (V)",
  rectangle: "矩形 (R)",
  ellipse: "椭圆 (O)",
  arrow: "箭头 (A)",
  line: "直线 (L)",
  freedraw: "画笔 (P)",
  text: "文字 (T)",
  image: "图片 (9)",
};

type CanvasToolMenuProps = {
  accessToken: string;
  canvasId: string;
  canvasRevision: number;
  excalidrawApi: any;
  leftPanelOpen?: boolean;
  onImageChatCommand?: (command: CanvasImageChatCommand) => void;
  onCanvasRefreshRequest?: () => Promise<void>;
  onCanvasRevisionChange: (revision: number) => void;
  onOpenDesign?: (target: DesignOpenTarget) => void;
};

export function CanvasToolMenu({
  accessToken,
  canvasId,
  canvasRevision,
  excalidrawApi,
  leftPanelOpen,
  onImageChatCommand,
  onCanvasRefreshRequest,
  onCanvasRevisionChange,
  onOpenDesign,
}: CanvasToolMenuProps) {
  const [activeTool, setActiveTool] = useState<string>("selection");
  const { success: showSuccess, error: showError } = useToast();
  const { preference: imageModelPreference } = useImageModelPreference();
  const [selectedImage, setSelectedImage] =
    useState<SelectedCanvasImage | null>(null);
  const [selectedImageBounds, setSelectedImageBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth?: number;
  } | null>(null);
  const selectedImageKeyRef = useRef("");
  const [cropSession, setCropSession] = useState<CropSession | null>(null);
  const cropSessionRef = useRef<CropSession | null>(null);
  const cropSaveGuardRef = useRef(createCropSaveGuard());
  cropSessionRef.current = cropSession;
  const [regionMattingSession, setRegionMattingSession] =
    useState<RegionMattingSession | null>(null);
  const regionMattingSessionRef = useRef<RegionMattingSession | null>(null);
  regionMattingSessionRef.current = regionMattingSession;
  const [eraserSession, setEraserSession] = useState<EraserSession | null>(
    null,
  );
  const eraserSessionRef = useRef<EraserSession | null>(null);
  eraserSessionRef.current = eraserSession;
  const [designPanelOpen, setDesignPanelOpen] = useState(false);
  const designElementIdsRef = useRef(new Map<string, string>());
  const [selectedDesign, setSelectedDesign] =
    useState<SelectedCanvasDesign | null>(null);
  const selectedDesignKeyRef = useRef("");
  const copyAttemptsRef = useRef(
    new Map<string, { requestId: string; elementId: string }>(),
  );
  const [copyingDesign, setCopyingDesign] = useState(false);

  // Image generator state
  const [activeGeneratorId, setActiveGeneratorId] = useState<string | null>(
    null,
  );
  const [generatorData, setGeneratorData] = useState<ImageGeneratorData | null>(
    null,
  );
  const [generatorBounds, setGeneratorBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  // Video generator state
  const [activeVideoGenId, setActiveVideoGenId] = useState<string | null>(null);
  const [videoGenData, setVideoGenData] = useState<VideoGeneratorData | null>(
    null,
  );
  const [videoGenBounds, setVideoGenBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  // Video player state (for completed video elements)
  const [activeVideoPlayerId, setActiveVideoPlayerId] = useState<string | null>(
    null,
  );
  const [videoPlayerData, setVideoPlayerData] = useState<{
    videoUrl: string;
    mimeType: string;
    durationSeconds?: number;
    title?: string;
  } | null>(null);
  const [videoPlayerBounds, setVideoPlayerBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const [canvasScrollZoom, setCanvasScrollZoom] = useState({
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });

  // Track generating elements for shimmer overlay
  const [generatingElements, setGeneratingElements] = useState<
    Array<{
      id: string;
      screenX: number;
      screenY: number;
      screenW: number;
      screenH: number;
      model?: string;
      jobId?: string;
      label?: string;
      status?: "generating" | "error";
    }>
  >([]);

  // Keep activeGeneratorId / activeVideoGenId accessible inside onChange without causing re-subscription
  const activeGeneratorIdRef = useRef(activeGeneratorId);
  activeGeneratorIdRef.current = activeGeneratorId;
  const activeVideoGenIdRef = useRef(activeVideoGenId);
  activeVideoGenIdRef.current = activeVideoGenId;
  const activeVideoPlayerIdRef = useRef(activeVideoPlayerId);
  activeVideoPlayerIdRef.current = activeVideoPlayerId;

  // Track previous generating element IDs to avoid re-renders when nothing changed
  const prevGeneratingKeyRef = useRef("");
  const monitoredGenerationJobsRef = useRef(new Set<string>());
  const activeGenerationMonitorLoopsRef = useRef(new Set<string>());

  // Helper: close all generator / player panels
  const closeAllPanels = useCallback(() => {
    setActiveGeneratorId(null);
    setGeneratorData(null);
    setGeneratorBounds(null);
    setActiveVideoGenId(null);
    setVideoGenData(null);
    setVideoGenBounds(null);
    setActiveVideoPlayerId(null);
    setVideoPlayerData(null);
    setVideoPlayerBounds(null);
  }, []);

  const clearSelectedImage = useCallback(() => {
    selectedImageKeyRef.current = "";
    setSelectedImage(null);
    setSelectedImageBounds(null);
  }, []);

  const clearSelectedDesign = useCallback(() => {
    selectedDesignKeyRef.current = "";
    setSelectedDesign(null);
  }, []);

  // Subscribe to Excalidraw changes.
  // This fires on every frame during drag / drawing, so we must be very
  // careful to avoid unnecessary state updates that trigger re-renders.
  useEffect(() => {
    if (!excalidrawApi) return;

    const unsubscribe = excalidrawApi.onChange(
      (elements: any[], appState: any) => {
        // --- Tool sync (cheap string comparison, skip if unchanged) ---
        const tool = appState?.activeTool?.type;
        if (tool)
          setActiveTool((prev: string) => (prev === tool ? prev : tool));

        const scrollX = appState?.scrollX ?? 0;
        const scrollY = appState?.scrollY ?? 0;
        const zoom = appState?.zoom?.value ?? 1;
        // Only update scroll/zoom state if values actually changed
        setCanvasScrollZoom((prev) => {
          if (
            prev.scrollX === scrollX &&
            prev.scrollY === scrollY &&
            prev.zoom === zoom
          )
            return prev;
          return { scrollX, scrollY, zoom };
        });

        // Region matting lives in a document.body portal, so it does not
        // inherit Excalidraw's camera transform. Recompute its screen bounds
        // from the source element on every canvas change to keep it attached
        // during pan, zoom, move, resize and rotation.
        const currentRegionMatting = regionMattingSessionRef.current;
        if (currentRegionMatting) {
          const regionElement = elements.find(
            (element: any) =>
              element.id === currentRegionMatting.imageId && !element.isDeleted,
          );
          if (!regionElement) {
            setRegionMattingSession(null);
          } else {
            const nextRegionBounds = {
              x: ((regionElement.x ?? 0) + scrollX) * zoom,
              y: ((regionElement.y ?? 0) + scrollY) * zoom,
              width: (regionElement.width ?? 0) * zoom,
              height: (regionElement.height ?? 0) * zoom,
            };
            const nextAngle = regionElement.angle ?? 0;
            setRegionMattingSession((previous) => {
              if (
                !previous ||
                previous.imageId !== currentRegionMatting.imageId
              )
                return previous;
              if (
                previous.bounds.x === nextRegionBounds.x &&
                previous.bounds.y === nextRegionBounds.y &&
                previous.bounds.width === nextRegionBounds.width &&
                previous.bounds.height === nextRegionBounds.height &&
                previous.angle === nextAngle
              )
                return previous;
              return {
                ...previous,
                bounds: nextRegionBounds,
                angle: nextAngle,
              };
            });
          }
        }

        const currentEraser = eraserSessionRef.current;
        if (currentEraser) {
          const eraserElement = elements.find(
            (element: any) =>
              element.id === currentEraser.imageId && !element.isDeleted,
          );
          if (!eraserElement) {
            setEraserSession(null);
          } else {
            const nextBounds = {
              x: ((eraserElement.x ?? 0) + scrollX) * zoom,
              y: ((eraserElement.y ?? 0) + scrollY) * zoom,
              width: (eraserElement.width ?? 0) * zoom,
              height: (eraserElement.height ?? 0) * zoom,
            };
            const nextAngle = eraserElement.angle ?? 0;
            setEraserSession((previous) => {
              if (!previous || previous.imageId !== currentEraser.imageId)
                return previous;
              if (
                previous.bounds.x === nextBounds.x &&
                previous.bounds.y === nextBounds.y &&
                previous.bounds.width === nextBounds.width &&
                previous.bounds.height === nextBounds.height &&
                previous.angle === nextAngle
              )
                return previous;
              return { ...previous, bounds: nextBounds, angle: nextAngle };
            });
          }
        }

        // --- Selection-based panel management ---
        const selectedIds = appState?.selectedElementIds ?? {};
        const selectedElements = elements.filter(
          (el: any) => selectedIds[el.id] && !el.isDeleted,
        );

        const currentCrop = cropSessionRef.current;
        if (
          currentCrop &&
          appState?.croppingElementId === currentCrop.elementId
        ) {
          const cropElement = elements.find(
            (element: any) =>
              element.id === currentCrop.elementId && !element.isDeleted,
          );
          if (cropElement) {
            const resolution = getImageCropResolution(cropElement);
            const nextBounds = {
              x: ((cropElement.x ?? 0) + scrollX) * zoom,
              y: ((cropElement.y ?? 0) + scrollY) * zoom,
              width: (cropElement.width ?? 0) * zoom,
              height: (cropElement.height ?? 0) * zoom,
              viewportWidth: appState.width,
            };
            setCropSession((previous) => {
              if (!previous || previous.elementId !== currentCrop.elementId)
                return previous;
              if (
                previous.width === resolution.width &&
                previous.height === resolution.height &&
                previous.bounds.x === nextBounds.x &&
                previous.bounds.y === nextBounds.y &&
                previous.bounds.width === nextBounds.width &&
                previous.bounds.height === nextBounds.height &&
                previous.bounds.viewportWidth === nextBounds.viewportWidth
              )
                return previous;
              return { ...previous, ...resolution, bounds: nextBounds };
            });
          }
        } else if (
          currentCrop &&
          appState?.croppingElementId !== currentCrop.elementId
        ) {
          cropSaveGuardRef.current.cancel();
          cropSessionRef.current = null;
          setCropSession(null);
        }

        const currentId = activeGeneratorIdRef.current;
        const currentVideoId = activeVideoGenIdRef.current;

        if (selectedElements.length === 1 && !appState?.croppingElementId) {
          const sel = selectedElements[0];
          const designMetadata = readDesignNodeMetadata(sel);

          if (designMetadata) {
            clearSelectedImage();
            if (currentId || currentVideoId || activeVideoPlayerIdRef.current) {
              closeAllPanels();
            }
            const designKey = `${sel.id}:${sel.x}:${sel.y}:${sel.width}:${sel.height}:${scrollX}:${scrollY}:${zoom}`;
            if (designKey !== selectedDesignKeyRef.current) {
              selectedDesignKeyRef.current = designKey;
              setSelectedDesign({
                designId: designMetadata.designId,
                canvasElementId: sel.id,
                x: sel.x ?? 0,
                y: sel.y ?? 0,
                width: sel.width ?? 0,
                height: sel.height ?? 0,
                screenBounds: {
                  x: ((sel.x ?? 0) + scrollX) * zoom,
                  y: ((sel.y ?? 0) + scrollY) * zoom,
                  width: (sel.width ?? 0) * zoom,
                  height: (sel.height ?? 0) * zoom,
                  viewportWidth: appState.width,
                },
              });
            }
          } else if (isImageGeneratorElement(sel)) {
            clearSelectedDesign();
            clearSelectedImage();
            // Only update if the selected generator changed
            if (currentId !== sel.id) {
              const data = getImageGeneratorData(sel);
              setActiveGeneratorId(sel.id as string);
              setGeneratorData(data);
              if (currentVideoId) {
                setActiveVideoGenId(null);
                setVideoGenData(null);
                setVideoGenBounds(null);
              }
              if (activeVideoPlayerIdRef.current) {
                setActiveVideoPlayerId(null);
                setVideoPlayerData(null);
                setVideoPlayerBounds(null);
              }
            }
            // Always update bounds (element may have been moved/resized)
            setGeneratorBounds({
              x: sel.x as number,
              y: sel.y as number,
              width: sel.width as number,
              height: sel.height as number,
            });
          } else if (isVideoGeneratorElement(sel)) {
            clearSelectedDesign();
            clearSelectedImage();
            if (currentVideoId !== sel.id) {
              const data = getVideoGeneratorData(sel);
              setActiveVideoGenId(sel.id as string);
              setVideoGenData(data);
              if (currentId) {
                setActiveGeneratorId(null);
                setGeneratorData(null);
                setGeneratorBounds(null);
              }
              if (activeVideoPlayerIdRef.current) {
                setActiveVideoPlayerId(null);
                setVideoPlayerData(null);
                setVideoPlayerBounds(null);
              }
            }
            setVideoGenBounds({
              x: sel.x as number,
              y: sel.y as number,
              width: sel.width as number,
              height: sel.height as number,
            });
          } else if (
            sel.type === "embeddable" &&
            (isVideoUrl(sel.link as string) || sel.customData?.isVideo === true)
          ) {
            clearSelectedDesign();
            clearSelectedImage();
            if (activeVideoPlayerIdRef.current !== sel.id) {
              const videoLink = sel.link as string;
              setActiveVideoPlayerId(sel.id as string);
              setVideoPlayerData({
                videoUrl: videoLink,
                mimeType: (sel.customData?.mimeType as string) ?? "video/mp4",
                ...(sel.customData?.durationSeconds != null
                  ? {
                      durationSeconds: sel.customData.durationSeconds as number,
                    }
                  : {}),
                ...(sel.customData?.title != null
                  ? { title: sel.customData.title as string }
                  : {}),
              });
              if (currentId) {
                setActiveGeneratorId(null);
                setGeneratorData(null);
                setGeneratorBounds(null);
              }
              if (currentVideoId) {
                setActiveVideoGenId(null);
                setVideoGenData(null);
                setVideoGenBounds(null);
              }
            }
            setVideoPlayerBounds({
              x: sel.x as number,
              y: sel.y as number,
              width: sel.width as number,
              height: sel.height as number,
            });
          } else if (sel.type === "image" && typeof sel.fileId === "string") {
            clearSelectedDesign();
            if (currentId || currentVideoId || activeVideoPlayerIdRef.current)
              closeAllPanels();
            const files = excalidrawApi.getFiles?.() ?? {};
            const file = files[sel.fileId] ?? {};
            const custom = sel.customData ?? {};
            const imageKey = `${sel.id}:${sel.x}:${sel.y}:${sel.width}:${sel.height}:${sel.angle ?? 0}:${file.created ?? ""}:${file.assetId ?? ""}:${custom.assetId ?? ""}:${typeof file.dataURL === "string" ? file.dataURL.length : 0}`;
            if (imageKey !== selectedImageKeyRef.current) {
              selectedImageKeyRef.current = imageKey;
              setSelectedImage({
                id: sel.id,
                fileId: sel.fileId,
                x: sel.x ?? 0,
                y: sel.y ?? 0,
                width: sel.width ?? 0,
                height: sel.height ?? 0,
                angle: sel.angle ?? 0,
                ...(typeof file.dataURL === "string"
                  ? { dataUrl: file.dataURL }
                  : {}),
                ...(typeof custom.storageUrl === "string"
                  ? { storageUrl: custom.storageUrl }
                  : {}),
                // fileId identifies the pixels currently rendered by
                // Excalidraw. Its asset binding must win over inherited
                // element metadata left behind by local crop/edit actions.
                ...(typeof file.assetId === "string"
                  ? { assetId: file.assetId }
                  : typeof custom.assetId === "string"
                    ? { assetId: custom.assetId }
                    : {}),
                mimeType: custom.mimeType ?? file.mimeType ?? "image/png",
                ...(typeof file.created === "number"
                  ? { created: file.created }
                  : {}),
                ...(typeof custom.title === "string"
                  ? { title: custom.title }
                  : {}),
                ...(typeof custom.prompt === "string"
                  ? { prompt: custom.prompt }
                  : {}),
                ...(typeof custom.model === "string"
                  ? { model: custom.model }
                  : {}),
                ...(typeof custom.sourceJobId === "string"
                  ? { sourceJobId: custom.sourceJobId }
                  : {}),
                ...(typeof custom.originalWidth === "number"
                  ? { originalWidth: custom.originalWidth }
                  : {}),
                ...(typeof custom.originalHeight === "number"
                  ? { originalHeight: custom.originalHeight }
                  : {}),
              });
            }
            setSelectedImageBounds({
              x: ((sel.x ?? 0) + scrollX) * zoom,
              y: ((sel.y ?? 0) + scrollY) * zoom,
              width: (sel.width ?? 0) * zoom,
              height: (sel.height ?? 0) * zoom,
              viewportWidth: appState.width,
            });
          } else {
            clearSelectedDesign();
            clearSelectedImage();
            // Neither generator nor video player -- close all if any was open
            if (currentId || currentVideoId || activeVideoPlayerIdRef.current) {
              closeAllPanels();
            }
          }
        } else {
          clearSelectedDesign();
          clearSelectedImage();
          // Zero or multiple selected -- close all panels if any was open
          if (currentId || currentVideoId || activeVideoPlayerIdRef.current) {
            closeAllPanels();
          }
        }

        // --- Generating elements shimmer overlay ---
        // Build a stable key so we skip setState when the generating set is unchanged.
        const generatingRaw = elements.filter(
          (el: any) =>
            !el.isDeleted &&
            ((isImageGeneratorElement(el) &&
              ["generating", "error"].includes(el.customData?.status)) ||
              (isVideoGeneratorElement(el) &&
                el.customData?.status === "generating") ||
              (isImageReplacementElement(el) &&
                ["generating", "error"].includes(el.customData.status))),
        );

        // The overlay is rendered in viewport coordinates. Zooming or panning
        // does not mutate the element itself, so the camera transform must be
        // part of the key or the DOM overlay stays at its previous size/position.
        const genKey = `${scrollX}:${scrollY}:${zoom}|${generatingRaw
          .map(
            (el: any) =>
              `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}:${el.customData?.status}`,
          )
          .join("|")}`;

        if (genKey !== prevGeneratingKeyRef.current) {
          prevGeneratingKeyRef.current = genKey;
          const generating = generatingRaw.map((el: any) => ({
            id: el.id as string,
            screenX: ((el.x as number) + scrollX) * zoom,
            screenY: ((el.y as number) + scrollY) * zoom,
            screenW: (el.width as number) * zoom,
            screenH: (el.height as number) * zoom,
            ...(el.customData?.model
              ? { model: el.customData.model as string }
              : {}),
            ...(typeof el.customData?.jobId === "string"
              ? { jobId: el.customData.jobId as string }
              : {}),
            ...(isImageGeneratorElement(el)
              ? {
                  label: "正在生成图片…",
                  status:
                    el.customData.status === "error"
                      ? ("error" as const)
                      : ("generating" as const),
                }
              : {}),
            ...(isImageReplacementElement(el)
              ? {
                  label:
                    el.customData.operation === "regenerate"
                      ? "正在重新生成…"
                      : el.customData.operation === "upscale"
                        ? "正在高清增强…"
                        : el.customData.operation === "remove-background"
                          ? "正在去除背景…"
                          : el.customData.operation === "region-matting"
                            ? "正在识别框选主体…"
                            : el.customData.operation === "split-layers"
                              ? "正在拆分图层…"
                              : el.customData.operation === "erase-transparent"
                                ? "正在应用透明擦除…"
                                : el.customData.operation === "smart-erase"
                                  ? "正在智能修复…"
                                  : "正在应用文字…",
                  status: el.customData.status,
                }
              : {}),
          }));
          setGeneratingElements(generating);
        }
      },
    );

    return unsubscribe;
  }, [excalidrawApi, closeAllPanels, clearSelectedDesign, clearSelectedImage]);

  // Every durable placeholder carries its job id. Monitor it until terminal
  // state so a missed websocket event can never leave a completed image stuck
  // behind the shimmer indefinitely.
  useEffect(() => {
    for (const element of generatingElements) {
      const jobId = element.jobId;
      if (!jobId || activeGenerationMonitorLoopsRef.current.has(jobId))
        continue;
      activeGenerationMonitorLoopsRef.current.add(jobId);
      void monitorCanvasGenerationJob(accessToken, jobId, {
        onAttemptStarted: () => {
          monitoredGenerationJobsRef.current.add(jobId);
        },
        onAttemptFinished: () => {
          monitoredGenerationJobsRef.current.delete(jobId);
        },
      })
        .then(async (job) => {
          try {
            await onCanvasRefreshRequest?.();
          } catch (error) {
            console.warn(
              `[canvas-generation] Failed to refresh canvas for terminal job ${job.id}:`,
              error,
            );
          }
        })
        .catch((error) => {
          console.warn(
            `[canvas-generation] Failed to monitor job ${jobId}:`,
            error,
          );
        })
        .finally(() => {
          monitoredGenerationJobsRef.current.delete(jobId);
          activeGenerationMonitorLoopsRef.current.delete(jobId);
        });
    }
  }, [accessToken, generatingElements, onCanvasRefreshRequest]);

  const handleDownloadImage = useCallback(async () => {
    if (!selectedImage) return;
    try {
      const blob = selectedImage.dataUrl
        ? await (await fetch(selectedImage.dataUrl)).blob()
        : selectedImage.assetId
          ? await fetchAssetBlob(accessToken, selectedImage.assetId)
          : await (async () => {
              const source = selectedImage.storageUrl;
              if (!source) throw new Error("图片数据尚未加载");
              const response = await fetch(source);
              if (!response.ok)
                throw new Error(`图片下载失败 (${response.status})`);
              return response.blob();
            })();
      const extension = selectedImage.mimeType.includes("jpeg")
        ? "jpg"
        : (selectedImage.mimeType.split("/")[1]?.split("+")[0] ?? "png");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedImage.title ?? "loomic-image"}.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showSuccess("图片已下载");
    } catch (error) {
      showError(error instanceof Error ? error.message : "图片下载失败");
    }
  }, [accessToken, selectedImage, showError, showSuccess]);

  const handleCropImage = useCallback(async () => {
    if (!selectedImage || !excalidrawApi) return;
    const selectedId = selectedImage.id;
    const initialElement = (
      excalidrawApi.getSceneElementsIncludingDeleted?.() ??
      excalidrawApi.getSceneElements()
    ).find(
      (candidate: any) =>
        candidate.id === selectedImage.id && !candidate.isDeleted,
    );
    if (!initialElement || !selectedImageBounds) return;

    let naturalSize = getImageCropResolution(initialElement);
    const source = selectedImage.dataUrl ?? selectedImage.storageUrl;
    if (!initialElement.crop && source) {
      try {
        naturalSize = await readImageNaturalSize(source);
      } catch {
        // Older saved canvases may not have an available source URL. In that
        // case retain the stored dimensions (or the display-size fallback).
      }
    }

    const sceneElements =
      excalidrawApi.getSceneElementsIncludingDeleted?.() ??
      excalidrawApi.getSceneElements();
    const element = sceneElements.find(
      (candidate: any) => candidate.id === selectedId && !candidate.isDeleted,
    );
    const appState = excalidrawApi.getAppState?.();
    if (
      !element ||
      (appState?.selectedElementIds && !appState.selectedElementIds[selectedId])
    )
      return;

    const cropElement = setImageNaturalSize(element, naturalSize);
    const resolution = getImageCropResolution(element);
    const session: CropSession = {
      elementId: selectedId,
      originalElement: structuredClone(element),
      ...(element.crop ? resolution : naturalSize),
      bounds: selectedImageBounds,
    };
    cropSaveGuardRef.current.cancel();
    cropSessionRef.current = session;
    setCropSession(session);
    excalidrawApi.updateScene({
      elements: sceneElements.map((candidate: any) =>
        candidate.id === selectedId
          ? {
              ...cropElement,
              version: Number(candidate.version ?? 1) + 1,
              versionNonce: Math.floor(Math.random() * 2_000_000_000),
              updated: Date.now(),
            }
          : candidate,
      ),
      appState: {
        selectedElementIds: { [selectedId]: true },
        croppingElementId: selectedId,
      },
      captureUpdate: "IMMEDIATELY",
    });
  }, [excalidrawApi, selectedImage, selectedImageBounds]);

  const handleSaveCrop = useCallback(
    async (width: number, height: number) => {
      const session = cropSessionRef.current;
      if (!session || !excalidrawApi) return;
      const operationGeneration = cropSaveGuardRef.current.begin();
      if (operationGeneration === null) return;
      const sceneElements =
        excalidrawApi.getSceneElementsIncludingDeleted?.() ??
        excalidrawApi.getSceneElements();
      const currentElement = sceneElements.find(
        (element: any) =>
          element.id === session.elementId && !element.isDeleted,
      );
      if (!currentElement) {
        cropSaveGuardRef.current.complete(operationGeneration);
        return;
      }

      const isCurrentOperation = () =>
        cropSaveGuardRef.current.isCurrent(operationGeneration) &&
        cropSessionRef.current?.elementId === session.elementId;

      const croppedResult = resizeImageCrop(currentElement, { width, height });
      const files = excalidrawApi.getFiles?.() ?? {};
      const sourceFile =
        typeof currentElement.fileId === "string"
          ? files[currentElement.fileId]
          : undefined;
      const storageUrl = currentElement.customData?.storageUrl;
      let source =
        typeof sourceFile?.dataURL === "string"
          ? sourceFile.dataURL
          : undefined;
      try {
        const assetId = currentElement.customData?.assetId;
        if (!source && typeof assetId === "string") {
          source = await fetchAssetAsDataURL(accessToken, assetId);
        } else if (!source && typeof storageUrl === "string") {
          source = await fetchAsDataURL(storageUrl);
        }
        if (!isCurrentOperation()) return;
        if (!source) throw new Error("原图数据尚未加载完成，请稍后重试");
        const rendered = await renderImageCrop(
          source,
          currentElement,
          { width, height },
          sourceFile?.mimeType ??
            currentElement.customData?.mimeType ??
            "image/png",
        );
        if (!isCurrentOperation()) return;
        const now = Date.now();
        const naturalSize = getImageNaturalSize(currentElement);
        const restoredOriginal = {
          ...setImageNaturalSize(session.originalElement, naturalSize),
          version: Number(currentElement.version ?? 1) + 1,
          versionNonce: Math.floor(Math.random() * 2_000_000_000),
          updated: now,
        };
        const croppedId = crypto.randomUUID();
        const croppedFileId = crypto.randomUUID();
        excalidrawApi.addFiles([
          {
            id: croppedFileId,
            dataURL: rendered.dataURL,
            mimeType: rendered.mimeType,
            created: now,
          },
        ]);
        const croppedElement = {
          ...createExcalidrawImageElement({
            fileId: croppedFileId,
            x: restoredOriginal.x + restoredOriginal.width + 40,
            y:
              restoredOriginal.y +
              (restoredOriginal.height - croppedResult.height) / 2,
            width: croppedResult.width,
            height: croppedResult.height,
            title: `${currentElement.customData?.title ?? "图片"}（裁剪）`,
            mimeType: rendered.mimeType,
            originalWidth: rendered.width,
            originalHeight: rendered.height,
          }),
          id: croppedId,
        };
        const elements = [
          ...sceneElements.map((element: any) =>
            element.id === session.elementId ? restoredOriginal : element,
          ),
          croppedElement,
        ];
        cropSessionRef.current = null;
        setCropSession(null);
        excalidrawApi.updateScene({
          elements,
          appState: {
            croppingElementId: null,
            selectedElementIds: { [croppedId]: true },
          },
          captureUpdate: "IMMEDIATELY",
        });
        showSuccess("已在原图右侧生成可下载的裁剪图片");
      } catch (error) {
        if (!isCurrentOperation()) return;
        showError(
          error instanceof Error ? error.message : "裁剪图片生成失败，请重试",
        );
      } finally {
        cropSaveGuardRef.current.complete(operationGeneration);
      }
    },
    [accessToken, excalidrawApi, showError, showSuccess],
  );

  const handleCancelCrop = useCallback(() => {
    const session = cropSessionRef.current;
    if (!session || !excalidrawApi) return;
    cropSaveGuardRef.current.cancel();
    const elements = (
      excalidrawApi.getSceneElementsIncludingDeleted?.() ??
      excalidrawApi.getSceneElements()
    ).map((element: any) =>
      element.id === session.elementId
        ? {
            ...session.originalElement,
            version: Number(element.version ?? 1) + 1,
            versionNonce: Math.floor(Math.random() * 2_000_000_000),
            updated: Date.now(),
          }
        : element,
    );
    cropSessionRef.current = null;
    setCropSession(null);
    excalidrawApi.updateScene({
      elements,
      appState: {
        croppingElementId: null,
        selectedElementIds: { [session.elementId]: true },
      },
      captureUpdate: "IMMEDIATELY",
    });
  }, [excalidrawApi]);

  const handleImageChatCommand = useCallback(
    (prompt?: string) => {
      if (!selectedImage || !onImageChatCommand) return;
      const url = selectedImage.storageUrl ?? selectedImage.dataUrl;
      if (!url) {
        showError("图片尚未加载完成，请稍后再试");
        return;
      }
      onImageChatCommand({
        id: crypto.randomUUID(),
        mode: prompt ? "run-agent" : "attach",
        image: {
          assetId: selectedImage.assetId ?? selectedImage.id,
          url,
          ...(selectedImage.dataUrl
            ? { previewUrl: selectedImage.dataUrl }
            : {}),
          mimeType: selectedImage.mimeType,
          name: selectedImage.title ?? "画布图片",
        },
        ...(prompt ? { prompt } : {}),
      });
    },
    [onImageChatCommand, selectedImage, showError],
  );

  const handleRecognizeImageText = useCallback(async () => {
    if (!selectedImage) return [];
    const url = selectedImage.dataUrl ?? selectedImage.storageUrl;
    if (!url) throw new Error("当前图片数据不可用，请重新选择图片后再试。");
    const result = await recognizeCanvasImageText(accessToken, canvasId, {
      assetId: selectedImage.assetId ?? selectedImage.id,
      url,
      mimeType: selectedImage.mimeType,
    });
    return result.texts;
  }, [accessToken, canvasId, selectedImage]);

  const handleDirectImageAction = useCallback(
    async (
      operation:
        | "regenerate"
        | "upscale"
        | "remove-background"
        | "region-matting"
        | "split-layers"
        | "erase-transparent"
        | "smart-erase",
      prompt: string,
      options?: {
        inputImage?: string;
        placement?: { x: number; y: number; width: number; height: number };
        selectionRegion?: NormalizedImageRegion;
        maskImage?: string;
      },
    ) => {
      if (!selectedImage) {
        showError("当前图片已取消选择，请重新选择图片后再试。");
        return;
      }
      // The Excalidraw file currently rendered on screen is authoritative. A
      // locally cropped/edited element can still carry the source assetId in its
      // metadata, so preferring that id would submit an older image version.
      const inputImage =
        options?.inputImage ??
        selectedImage.dataUrl ??
        (selectedImage.assetId
          ? (await getAssetUrl(accessToken, selectedImage.assetId)).url
          : selectedImage.storageUrl);
      if (!inputImage) {
        showError("当前图片数据尚未加载完成，请稍后重试。");
        return;
      }
      const isLocalOperation =
        operation === "remove-background" ||
        operation === "region-matting" ||
        operation === "split-layers" ||
        operation === "erase-transparent" ||
        operation === "smart-erase";
      const availableModels = isLocalOperation
        ? []
        : (await fetchImageModels(accessToken)).models;
      const preferredModel = imageModelPreference.models[0];
      const exact2KModel =
        operation === "upscale"
          ? availableModels.find((item) => item.supportsExact2K === true)
          : undefined;
      const model = isLocalOperation
        ? "local:feynobg"
        : (exact2KModel?.id ??
          availableModels.find((item) => item.id === preferredModel)?.id ??
          availableModels[0]?.id);
      if (!model) {
        showError("尚未配置可用的图片模型，请先到管理后台同步并启用模型。");
        return;
      }
      const placement = options?.placement ?? {
        x: selectedImage.x + selectedImage.width + 40,
        y: selectedImage.y,
        width: selectedImage.width,
        height: selectedImage.height,
      };
      const placeholderId = createImageReplacementElement(
        excalidrawApi,
        placement,
        operation,
      );
      try {
        const upscaleResolution =
          operation === "upscale" ? calculate2KResolution(selectedImage) : null;
        const response = await createImageGenerationJob(accessToken, {
          canvas_id: canvasId,
          prompt,
          model,
          operation:
            operation === "remove-background"
              ? "remove_background"
              : operation === "region-matting"
                ? "region_matting"
                : operation === "split-layers"
                  ? "split_layers"
                  : operation === "erase-transparent"
                    ? "erase_transparent"
                    : operation === "smart-erase"
                      ? "smart_erase"
                      : "generate",
          quality: "hd",
          ...(upscaleResolution
            ? {
                output_width: upscaleResolution.targetWidth,
                output_height: upscaleResolution.targetHeight,
              }
            : {}),
          input_images: [inputImage],
          placement_x: placement.x,
          placement_y: placement.y,
          placement_width: placement.width,
          placement_height: placement.height,
          placeholder_element_id: placeholderId,
          ...(options?.selectionRegion
            ? { selection_region: options.selectionRegion }
            : {}),
          ...(options?.maskImage ? { mask_image: options.maskImage } : {}),
        });
        updateImageReplacementElement(excalidrawApi, placeholderId, {
          jobId: response.job.id,
        });
        void (async () => {
          try {
            let job = await waitForGenerationJob(accessToken, response.job.id);
            if (job.status !== "succeeded") {
              throw new Error(
                job.error_message ||
                  (operation === "upscale"
                    ? "高清增强失败，请重试。"
                    : operation === "remove-background"
                      ? "去除背景失败，请重试。"
                      : operation === "region-matting"
                        ? "框选主体识别失败，请重试。"
                        : operation === "split-layers"
                          ? "图层拆分失败，请重试。"
                          : operation === "erase-transparent"
                            ? "透明擦除失败，请重试。"
                            : operation === "smart-erase"
                              ? "智能修复失败，请重试。"
                              : "图片重新生成失败，请重试。"),
              );
            }
            for (let attempt = 0; attempt < 30; attempt += 1) {
              if (typeof job.result?.canvas_element_id === "string") break;
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              job = (await fetchJob(accessToken, job.id)).job;
            }
            if (typeof job.result?.canvas_element_id !== "string") {
              throw new Error(
                "图片已生成，但画布同步尚未完成，后台会继续恢复，请稍后刷新。",
              );
            }
            updateImageReplacementElement(excalidrawApi, placeholderId, {
              isDeleted: true,
            });
            await onCanvasRefreshRequest?.();
            showSuccess(
              operation === "upscale"
                ? "高清增强完成，新图片已添加到原图右侧"
                : operation === "remove-background"
                  ? "背景已去除，透明 PNG 已添加到原图右侧"
                  : operation === "region-matting"
                    ? "框选主体已提取，其他内容已透明化"
                    : operation === "split-layers"
                      ? "图层拆分完成，背景和元素已分别添加到画布"
                      : operation === "erase-transparent"
                        ? "透明擦除完成，新图片已添加到原图右侧"
                        : operation === "smart-erase"
                          ? "智能修复完成，新图片已添加到原图右侧"
                          : "重新生成完成，新图片已添加到原图右侧",
            );
          } catch (error) {
            updateImageReplacementElement(excalidrawApi, placeholderId, {
              status: "error",
              errorMessage:
                error instanceof Error
                  ? error.message
                  : operation === "upscale"
                    ? "高清增强失败"
                    : operation === "remove-background"
                      ? "去除背景失败"
                      : operation === "region-matting"
                        ? "框选主体识别失败"
                        : operation === "split-layers"
                          ? "图层拆分失败"
                          : operation === "erase-transparent"
                            ? "透明擦除失败"
                            : operation === "smart-erase"
                              ? "智能修复失败"
                              : "图片重新生成失败",
            });
            showError(
              error instanceof Error
                ? error.message
                : operation === "upscale"
                  ? "高清增强失败，请重试。"
                  : operation === "remove-background"
                    ? "去除背景失败，请重试。"
                    : operation === "region-matting"
                      ? "框选主体识别失败，请重试。"
                      : operation === "split-layers"
                        ? "图层拆分失败，请重试。"
                        : operation === "erase-transparent"
                          ? "透明擦除失败，请重试。"
                          : operation === "smart-erase"
                            ? "智能修复失败，请重试。"
                            : "图片重新生成失败，请重试。",
            );
          }
        })();
      } catch (error) {
        updateImageReplacementElement(excalidrawApi, placeholderId, {
          isDeleted: true,
        });
        showError(
          error instanceof Error
            ? error.message
            : operation === "upscale"
              ? "高清增强任务创建失败，请重试。"
              : operation === "remove-background"
                ? "去除背景任务创建失败，请重试。"
                : operation === "region-matting"
                  ? "框选抠图任务创建失败，请重试。"
                  : operation === "split-layers"
                    ? "图层拆分任务创建失败，请重试。"
                    : operation === "erase-transparent"
                      ? "透明擦除任务创建失败，请重试。"
                      : operation === "smart-erase"
                        ? "智能修复任务创建失败，请重试。"
                        : "重新生成任务创建失败，请重试。",
        );
      }
    },
    [
      accessToken,
      canvasId,
      excalidrawApi,
      imageModelPreference.models,
      onCanvasRefreshRequest,
      selectedImage,
      showError,
      showSuccess,
    ],
  );

  const handleRegenerateImage = useCallback(
    (prompt: string) => handleDirectImageAction("regenerate", prompt),
    [handleDirectImageAction],
  );

  const handleUpscaleImage = useCallback(
    (prompt: string) => handleDirectImageAction("upscale", prompt),
    [handleDirectImageAction],
  );

  const handleRemoveImageBackground = useCallback(
    () =>
      handleDirectImageAction(
        "remove-background",
        "提取主前景并输出透明背景 PNG",
      ),
    [handleDirectImageAction],
  );

  const handleStartRegionMatting = useCallback(() => {
    if (!excalidrawApi) return;
    const appState = excalidrawApi.getAppState?.() ?? {};
    const selectedIds = appState.selectedElementIds ?? {};
    const selected = (
      excalidrawApi.getSceneElementsIncludingDeleted?.() ??
      excalidrawApi.getSceneElements()
    ).filter(
      (element: any) =>
        selectedIds[element.id] &&
        !element.isDeleted &&
        element.type === "image",
    );
    if (selected.length !== 1) return;
    const image = selected[0];
    const zoom = appState.zoom?.value ?? 1;
    const scrollX = appState.scrollX ?? 0;
    const scrollY = appState.scrollY ?? 0;
    setRegionMattingSession({
      imageId: image.id,
      bounds: {
        x: (Number(image.x ?? 0) + scrollX) * zoom,
        y: (Number(image.y ?? 0) + scrollY) * zoom,
        width: Number(image.width ?? 0) * zoom,
        height: Number(image.height ?? 0) * zoom,
      },
      angle: image.angle ?? 0,
    });
  }, [excalidrawApi]);

  const handleConfirmRegionMatting = useCallback(
    async (region: NormalizedImageRegion) => {
      const session = regionMattingSession;
      setRegionMattingSession(null);
      if (!session || !excalidrawApi) return;
      const element = (
        excalidrawApi.getSceneElementsIncludingDeleted?.() ??
        excalidrawApi.getSceneElements()
      ).find(
        (candidate: any) =>
          candidate.id === session.imageId && !candidate.isDeleted,
      );
      if (!element) {
        showError("原图片已不存在，请重新选择后再试。");
        return;
      }

      try {
        const files = excalidrawApi.getFiles?.() ?? {};
        const file =
          typeof element.fileId === "string"
            ? files[element.fileId]
            : undefined;
        const elementAssetId =
          typeof file?.assetId === "string"
            ? file.assetId
            : typeof element.customData?.assetId === "string"
              ? element.customData.assetId
              : undefined;
        const elementStorageUrl =
          typeof element.customData?.storageUrl === "string"
            ? element.customData.storageUrl
            : undefined;
        const source =
          typeof file?.dataURL === "string"
            ? file.dataURL
            : elementAssetId
              ? await fetchAssetAsDataURL(accessToken, elementAssetId)
              : elementStorageUrl
                ? await fetchAsDataURL(elementStorageUrl)
                : undefined;
        if (!source) throw new Error("原图数据尚未加载完成，请稍后重试。");
        // Keep the whole visible image as model context. The normalized box is
        // sent separately as an explicit foreground hint; cropping first would
        // turn this back into ordinary global background removal.
        const visibleResolution = getImageCropResolution(element);
        const visibleImage = await renderImageCrop(
          source,
          element,
          visibleResolution,
          "image/webp",
        );
        await handleDirectImageAction(
          "region-matting",
          "识别用户框选的主体，仅保留该主体并将其他所有内容透明化",
          {
            inputImage: visibleImage.dataURL,
            selectionRegion: region,
            placement: {
              x: Number(element.x ?? 0) + Number(element.width ?? 0) + 40,
              y:
                Number(element.y ?? 0) + Number(element.height ?? 0) * region.y,
              width: Math.max(24, Number(element.width ?? 0) * region.width),
              height: Math.max(24, Number(element.height ?? 0) * region.height),
            },
          },
        );
      } catch (error) {
        showError(
          error instanceof Error ? error.message : "框选抠图失败，请重试。",
        );
      }
    },
    [
      accessToken,
      excalidrawApi,
      handleDirectImageAction,
      regionMattingSession,
      showError,
    ],
  );

  const handleSplitImageLayers = useCallback(
    () => handleDirectImageAction("split-layers", "拆分前景元素并修复背景"),
    [handleDirectImageAction],
  );

  const handleStartErase = useCallback(() => {
    if (!selectedImage || !selectedImageBounds) return;
    setEraserSession({
      imageId: selectedImage.id,
      bounds: {
        x: selectedImageBounds.x,
        y: selectedImageBounds.y,
        width: selectedImageBounds.width,
        height: selectedImageBounds.height,
      },
      angle: selectedImage.angle ?? 0,
    });
  }, [selectedImage, selectedImageBounds]);

  const handleConfirmErase = useCallback(
    async (mode: ImageEraseMode, strokes: NormalizedEraseStroke[]) => {
      const session = eraserSession;
      setEraserSession(null);
      if (!session || !excalidrawApi || !strokes.length) return;
      const element = (
        excalidrawApi.getSceneElementsIncludingDeleted?.() ??
        excalidrawApi.getSceneElements()
      ).find(
        (candidate: any) =>
          candidate.id === session.imageId && !candidate.isDeleted,
      );
      if (!element) {
        showError("原图片已不存在，请重新选择后再试。");
        return;
      }
      try {
        // Resolve from the image element locked into this eraser session. The
        // generic selectedImage state can change while the overlay is open and
        // previously caused a neighbouring image to be submitted instead.
        // Export the selected element through Excalidraw so the submitted pixels
        // are exactly the ones rendered on the canvas. This is intentionally not
        // rebuilt from getFiles()[fileId]: Excalidraw can retain a decoded bitmap
        // while a later canvas refresh updates that file entry, leaving the user
        // looking at one image while an operation submits another.
        const { exportToBlob } = await import("@excalidraw/excalidraw");
        const visibleBlob = await exportToBlob({
          elements: [element],
          files: excalidrawApi.getFiles?.() ?? {},
          appState: { exportBackground: false },
          exportPadding: 0,
          mimeType: "image/png",
        });
        const visibleImage = await new Promise<{
          dataURL: string;
          width: number;
          height: number;
        }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("无法读取画布中的原图。"));
          reader.onload = async () => {
            try {
              const bitmap = await createImageBitmap(visibleBlob);
              const dimensions = { width: bitmap.width, height: bitmap.height };
              bitmap.close();
              resolve({ dataURL: reader.result as string, ...dimensions });
            } catch (error) {
              reject(error);
            }
          };
          reader.readAsDataURL(visibleBlob);
        });
        const resolution = {
          width: visibleImage.width,
          height: visibleImage.height,
        };
        const maskImage = renderEraseMask(
          strokes,
          resolution.width,
          resolution.height,
        );
        await handleDirectImageAction(
          mode === "smart" ? "smart-erase" : "erase-transparent",
          mode === "smart" ? "修复用户涂抹删除的区域" : "将用户涂抹区域透明化",
          {
            inputImage: visibleImage.dataURL,
            maskImage,
            placement: {
              x: Number(element.x ?? 0) + Number(element.width ?? 0) + 40,
              y: Number(element.y ?? 0),
              width: Number(element.width ?? 0),
              height: Number(element.height ?? 0),
            },
          },
        );
      } catch (error) {
        showError(
          error instanceof Error ? error.message : "橡皮处理失败，请重试。",
        );
      }
    },
    [
      accessToken,
      eraserSession,
      excalidrawApi,
      handleDirectImageAction,
      showError,
    ],
  );

  const handleApplyTextReplacement = useCallback(
    async (replacements: Array<{ original: string; replacement: string }>) => {
      if (!selectedImage) throw new Error("当前图片已取消选择。");
      const inputImage = selectedImage.dataUrl ?? selectedImage.storageUrl;
      if (!inputImage)
        throw new Error("当前图片数据不可用，请重新选择图片后再试。");
      const instructions = replacements
        .map(({ original, replacement }, index) =>
          original
            ? `${index + 1}. 将“${original}”替换为“${replacement}”`
            : `${index + 1}. 添加文字“${replacement}”`,
        )
        .join("\n");
      const prompt = `编辑参考图片中的文字：\n${instructions}\n严格保持原图的主体、Logo 图形、字体视觉风格、字号、颜色、位置、排版、背景、构图和其他所有内容不变；确保新文字拼写准确、清晰可读。只修改上述文字。`;
      const availableModels = (await fetchImageModels(accessToken)).models;
      const preferredModel = imageModelPreference.models[0];
      const model =
        availableModels.find((item) => item.id === preferredModel)?.id ??
        availableModels[0]?.id;
      if (!model)
        throw new Error(
          "尚未配置可用的图片模型，请先到管理后台同步并启用模型。",
        );
      const placement = {
        x: selectedImage.x + selectedImage.width + 40,
        y: selectedImage.y,
        width: selectedImage.width,
        height: selectedImage.height,
      };
      const placeholderId = createImageReplacementElement(
        excalidrawApi,
        placement,
      );
      let response;
      try {
        response = await createImageGenerationJob(accessToken, {
          canvas_id: canvasId,
          prompt,
          model,
          quality: "hd",
          input_images: [inputImage],
          placement_x: placement.x,
          placement_y: placement.y,
          placement_width: placement.width,
          placement_height: placement.height,
          placeholder_element_id: placeholderId,
        });
        updateImageReplacementElement(excalidrawApi, placeholderId, {
          jobId: response.job.id,
        });
      } catch (error) {
        updateImageReplacementElement(excalidrawApi, placeholderId, {
          isDeleted: true,
        });
        showError(
          error instanceof Error
            ? error.message
            : "文字替换任务创建失败，请重试。",
        );
        throw error;
      }

      // The editor panel can close now: the actual canvas node owns the visible
      // generation state and the durable job keeps running independently.
      void (async () => {
        try {
          let job = await waitForGenerationJob(accessToken, response.job.id);
          if (job.status !== "succeeded") {
            throw new Error(job.error_message || "文字替换生成失败，请重试。");
          }
          for (let attempt = 0; attempt < 30; attempt += 1) {
            if (typeof job.result?.canvas_element_id === "string") break;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            job = (await fetchJob(accessToken, job.id)).job;
          }
          if (typeof job.result?.canvas_element_id !== "string") {
            throw new Error(
              "图片已生成，但画布同步尚未完成，后台会继续恢复，请稍后刷新。",
            );
          }
          updateImageReplacementElement(excalidrawApi, placeholderId, {
            isDeleted: true,
          });
          await onCanvasRefreshRequest?.();
          showSuccess("文字替换完成，新图片已放在原图右侧");
        } catch (error) {
          updateImageReplacementElement(excalidrawApi, placeholderId, {
            status: "error",
            errorMessage:
              error instanceof Error ? error.message : "文字替换生成失败",
          });
          showError(
            error instanceof Error
              ? error.message
              : "文字替换生成失败，请重试。",
          );
        }
      })();
    },
    [
      accessToken,
      canvasId,
      excalidrawApi,
      imageModelPreference.models,
      onCanvasRefreshRequest,
      selectedImage,
      showError,
      showSuccess,
    ],
  );

  const handleToolChange = useCallback(
    (tool: ToolType) => {
      excalidrawApi?.setActiveTool({ type: tool });
    },
    [excalidrawApi],
  );

  const handleCreateImageGenerator = useCallback(() => {
    if (!excalidrawApi) return;
    const elementId = createImageGeneratorElement(excalidrawApi);
    // Select the newly created element so onChange recognises it
    excalidrawApi.updateScene({
      appState: { selectedElementIds: { [elementId]: true } },
    });
    setActiveGeneratorId(elementId);
    // Read back the created element to populate initial state
    const elements = excalidrawApi.getSceneElements();
    const el = elements.find((e: any) => e.id === elementId);
    if (el) {
      setGeneratorData(getImageGeneratorData(el));
      setGeneratorBounds({
        x: el.x as number,
        y: el.y as number,
        width: el.width as number,
        height: el.height as number,
      });
    }
  }, [excalidrawApi]);

  const handleCloseGenerator = useCallback(() => {
    setActiveGeneratorId(null);
    setGeneratorData(null);
    setGeneratorBounds(null);
  }, []);

  const handleCreateVideoGenerator = useCallback(() => {
    if (!excalidrawApi) return;
    const videoId = createVideoGeneratorElement(excalidrawApi, {
      aspectRatio: "16:9",
    });
    excalidrawApi.updateScene({
      appState: { selectedElementIds: { [videoId]: true } },
    });
    setActiveVideoGenId(videoId);
    // Read back the created element to populate initial state
    const elements = excalidrawApi.getSceneElements();
    const el = elements.find((e: any) => e.id === videoId);
    if (el) {
      setVideoGenData(getVideoGeneratorData(el));
      setVideoGenBounds({
        x: el.x as number,
        y: el.y as number,
        width: el.width as number,
        height: el.height as number,
      });
    }
  }, [excalidrawApi]);

  const handleCloseVideoGenerator = useCallback(() => {
    setActiveVideoGenId(null);
    setVideoGenData(null);
    setVideoGenBounds(null);
  }, []);

  const handleCloseVideoPlayer = useCallback(() => {
    setActiveVideoPlayerId(null);
    setVideoPlayerData(null);
    setVideoPlayerBounds(null);
  }, []);

  const handleCreateDesign = useCallback(
    async (input: BlankDesignInput) => {
      if (!excalidrawApi) return;
      const elementId =
        designElementIdsRef.current.get(input.requestId) ?? crypto.randomUUID();
      designElementIdsRef.current.set(input.requestId, elementId);
      const placement = getDesignNodePlacement(
        excalidrawApi.getAppState(),
        input.width,
        input.height,
      );
      let result;
      try {
        result = await designApi.createDesign(accessToken, {
          request_id: input.requestId,
          canvas_id: canvasId,
          expected_canvas_revision: canvasRevision,
          canvas_element_id: elementId,
          width: input.width,
          height: input.height,
          background: input.background,
          ...(input.templateId ? { template_id: input.templateId } : {}),
          node: placement,
        });
      } catch (error) {
        if (
          error instanceof DesignApiError &&
          error.code === "CANVAS_REVISION_CONFLICT" &&
          error.conflict?.canvasId === canvasId
        ) {
          onCanvasRevisionChange(error.conflict.latestRevision);
          void onCanvasRefreshRequest?.();
        }
        throw error;
      }
      onCanvasRevisionChange(result.canvas_revision);
      await onCanvasRefreshRequest?.();
      excalidrawApi.updateScene({
        appState: {
          selectedElementIds: { [result.canvas_element_id]: true },
        },
      });
      designElementIdsRef.current.delete(input.requestId);
      setDesignPanelOpen(false);
    },
    [
      accessToken,
      canvasId,
      canvasRevision,
      excalidrawApi,
      onCanvasRefreshRequest,
      onCanvasRevisionChange,
    ],
  );

  const handleOpenSelectedDesign = useCallback(() => {
    if (!selectedDesign) return;
    onOpenDesign?.({
      designId: selectedDesign.designId,
      canvasElementId: selectedDesign.canvasElementId,
    });
  }, [onOpenDesign, selectedDesign]);

  const handleCopySelectedDesign = useCallback(async () => {
    if (!selectedDesign || copyingDesign) return;
    const attempt = getOrCreateDesignCopyAttempt(
      copyAttemptsRef.current,
      selectedDesign.canvasElementId,
    );
    setCopyingDesign(true);
    try {
      const result = await designApi.copyDesign(accessToken, {
        request_id: attempt.requestId,
        source_design_id: selectedDesign.designId,
        canvas_id: canvasId,
        expected_canvas_revision: canvasRevision,
        canvas_element_id: attempt.elementId,
        node: getDesignCopyPlacement(selectedDesign),
      });
      onCanvasRevisionChange(result.canvas_revision);
      await onCanvasRefreshRequest?.();
      excalidrawApi.updateScene({
        appState: { selectedElementIds: { [result.canvas_element_id]: true } },
      });
      copyAttemptsRef.current.delete(selectedDesign.canvasElementId);
      showSuccess("已复制设计");
    } catch (error) {
      if (
        error instanceof DesignApiError &&
        error.code === "CANVAS_REVISION_CONFLICT" &&
        error.conflict?.canvasId === canvasId
      ) {
        onCanvasRevisionChange(error.conflict.latestRevision);
        void onCanvasRefreshRequest?.();
      }
      showError(
        error instanceof Error ? error.message : "复制设计失败，请重试",
      );
    } finally {
      setCopyingDesign(false);
    }
  }, [
    accessToken,
    canvasId,
    canvasRevision,
    copyingDesign,
    excalidrawApi,
    onCanvasRefreshRequest,
    onCanvasRevisionChange,
    selectedDesign,
    showError,
    showSuccess,
  ]);

  return (
    <>
      <div
        className="absolute bottom-5 z-30 flex items-center gap-0.5 rounded-xl p-1 bg-card/75 backdrop-blur-lg border border-border shadow-card transition-[left,transform] duration-200"
        style={{
          left: leftPanelOpen ? "calc(140px + 50%)" : "50%",
          transform: "translateX(-50%)",
        }}
      >
        {/* Standard Excalidraw tools */}
        {TOOL_GROUPS.map((tool, i) => {
          if (tool === null) {
            return (
              <div key={`sep-${i}`} className="mx-0.5 h-6 w-px bg-border" />
            );
          }

          const Icon = TOOL_ICONS[tool];
          const isActive = activeTool === tool;

          return (
            <button
              key={tool}
              type="button"
              title={TOOL_LABELS[tool]}
              aria-label={TOOL_LABELS[tool]}
              onMouseDown={(e) => {
                e.preventDefault();
                handleToolChange(tool);
              }}
              className={`flex items-center justify-center h-8 w-8 rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 outline-none ${
                isActive
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <Icon className="size-[16px]" />
            </button>
          );
        })}

        {/* Design board is a Loomic action, not an Excalidraw active tool. */}
        <button
          type="button"
          title="设计画板"
          aria-label="设计画板"
          aria-expanded={designPanelOpen}
          onClick={() => setDesignPanelOpen((open) => !open)}
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
            designPanelOpen
              ? "bg-foreground/[0.08] text-foreground"
              : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
          }`}
        >
          <LayoutTemplate className="size-[16px]" />
        </button>

        {/* Separator before AI tools */}
        <div className="mx-0.5 h-6 w-px bg-border" />

        {/* AI Image -- creates a placeholder on canvas */}
        <button
          type="button"
          title="AI 生成图片"
          aria-label="AI 生成图片"
          onClick={handleCreateImageGenerator}
          className={`flex items-center justify-center h-8 w-8 rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 outline-none ${
            activeGeneratorId
              ? "bg-foreground/[0.08] text-foreground"
              : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
          }`}
        >
          <Sparkles className="size-[16px]" />
        </button>

        {/* AI Video -- creates a placeholder on canvas */}
        <button
          type="button"
          title="AI 生成视频"
          aria-label="AI 生成视频"
          onClick={handleCreateVideoGenerator}
          className={`flex items-center justify-center h-8 w-8 rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 outline-none ${
            activeVideoGenId
              ? "bg-foreground/[0.08] text-foreground"
              : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
          }`}
        >
          <Video className="size-[16px]" />
        </button>
      </div>

      {designPanelOpen && (
        <div
          className="absolute bottom-16 z-40"
          style={{
            left: leftPanelOpen ? "calc(140px + 50%)" : "50%",
            transform: "translateX(-50%)",
          }}
        >
          <DesignCreatePanel
            accessToken={accessToken}
            onClose={() => setDesignPanelOpen(false)}
            onCreate={handleCreateDesign}
          />
        </div>
      )}

      {selectedDesign && (
        <DesignSelectionToolbar
          design={selectedDesign}
          copying={copyingDesign}
          onOpen={handleOpenSelectedDesign}
          onCopy={() => void handleCopySelectedDesign()}
        />
      )}

      {/* Image Generator Panel -- floats below the selected placeholder */}
      {selectedImage &&
        selectedImageBounds &&
        !regionMattingSession &&
        !eraserSession && (
          <ImageSelectionToolbar
            image={selectedImage}
            screenBounds={selectedImageBounds}
            onDownload={handleDownloadImage}
            onCrop={handleCropImage}
            onRegenerate={handleRegenerateImage}
            onUpscale={handleUpscaleImage}
            onRemoveBackground={handleRemoveImageBackground}
            onRegionMatting={handleStartRegionMatting}
            onSplitLayers={handleSplitImageLayers}
            onErase={handleStartErase}
            onChatCommand={handleImageChatCommand}
            onRecognizeText={handleRecognizeImageText}
            onApplyTextReplacement={handleApplyTextReplacement}
          />
        )}

      {regionMattingSession &&
        createPortal(
          <ImageRegionMattingOverlay
            bounds={regionMattingSession.bounds}
            angle={regionMattingSession.angle}
            onCancel={() => setRegionMattingSession(null)}
            onConfirm={(region) => void handleConfirmRegionMatting(region)}
          />,
          document.body,
        )}

      {eraserSession &&
        createPortal(
          <ImageEraserOverlay
            bounds={eraserSession.bounds}
            angle={eraserSession.angle}
            onCancel={() => setEraserSession(null)}
            onConfirm={(mode, strokes) =>
              void handleConfirmErase(mode, strokes)
            }
          />,
          document.body,
        )}

      {activeGeneratorId && generatorData && generatorBounds && (
        <ImageGeneratorPanel
          elementId={activeGeneratorId}
          canvasId={canvasId}
          elementBounds={generatorBounds}
          data={generatorData}
          excalidrawApi={excalidrawApi}
          accessToken={accessToken}
          canvasScrollZoom={canvasScrollZoom}
          onClose={handleCloseGenerator}
        />
      )}

      {/* Video Generator Panel -- floats below the selected placeholder */}
      {activeVideoGenId && videoGenData && videoGenBounds && (
        <VideoGeneratorPanel
          elementId={activeVideoGenId}
          elementBounds={videoGenBounds}
          data={videoGenData}
          excalidrawApi={excalidrawApi}
          accessToken={accessToken}
          canvasScrollZoom={canvasScrollZoom}
          onClose={handleCloseVideoGenerator}
        />
      )}

      {/* Video Player Panel -- floats when a completed video element is selected */}
      {activeVideoPlayerId && videoPlayerData && videoPlayerBounds && (
        <VideoPlayerPanel
          elementId={activeVideoPlayerId}
          elementBounds={videoPlayerBounds}
          videoUrl={videoPlayerData.videoUrl}
          mimeType={videoPlayerData.mimeType}
          {...(videoPlayerData.durationSeconds != null
            ? { durationSeconds: videoPlayerData.durationSeconds }
            : {})}
          {...(videoPlayerData.title != null
            ? { title: videoPlayerData.title }
            : {})}
          canvasScrollZoom={canvasScrollZoom}
          onClose={handleCloseVideoPlayer}
        />
      )}

      {cropSession &&
        createPortal(
          <ImageCropResolutionPanel
            bounds={cropSession.bounds}
            width={cropSession.width}
            height={cropSession.height}
            onCancel={handleCancelCrop}
            onSave={handleSaveCrop}
          />,
          document.body,
        )}

      {/* Shimmer overlays for generating elements */}
      {generatingElements.map((element) => (
        <GeneratingOverlay key={element.id} {...element} />
      ))}
    </>
  );
}
