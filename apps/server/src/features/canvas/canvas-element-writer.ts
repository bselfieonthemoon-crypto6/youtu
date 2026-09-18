// apps/server/src/features/canvas/canvas-element-writer.ts

import type { CanvasContent, Json } from "@loomic/shared";
import { mergeCanvasContent } from "./canvas-content-merge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanvasElement = Record<string, unknown>;

type ImageInsertOpts = {
  canvasId: string;
  sourceJobId: string;
  assetId: string;
  objectPath: string;       // Storage path for oss:// marker (already uploaded by worker)
  width: number;
  height: number;
  mimeType: string;
  title?: string;
  prompt?: string;
  model?: string;
  quality?: string;
  createdAt?: string;
  replaceElementId?: string;
  rejectDeletedSourceJob?: boolean;
  knownElementId?: string;
};

type VideoInsertOpts = {
  canvasId: string;
  sourceJobId: string;
  assetId: string;
  signedUrl: string;        // Public URL for embeddable link
  width: number;
  height: number;
  mimeType: string;
  durationSeconds?: number;
  title?: string;
  prompt?: string;
  rejectDeletedSourceJob?: boolean;
  knownElementId?: string;
};

type Placement = { x: number; y: number; width: number; height: number };

type InsertResult = { elementId: string; inserted: boolean };

type ImageGenerationPlaceholderOpts = {
  canvasId: string;
  elementId: string;
  sourceJobId: string;
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  quality: string;
};

// ---------------------------------------------------------------------------
// Placement calculation (ported from apps/web/src/lib/canvas-elements.ts)
// ---------------------------------------------------------------------------

function scaleToFit(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) return { width, height };
  const ratio = Math.min(maxSize / width, maxSize / height);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

function calculateAutoPlacement(
  elements: CanvasElement[],
  assetWidth: number,
  assetHeight: number,
  maxSize: number,
): Placement {
  const scaled = scaleToFit(assetWidth, assetHeight, maxSize);
  const visible = elements.filter((el) => !el.isDeleted);

  if (visible.length === 0) {
    // The persisted empty scene has a top-left viewport origin, not a camera
    // centered at (0,0). Leave room for the fixed canvas header on first load.
    return {
      x: 80,
      y: 80,
      width: scaled.width,
      height: scaled.height,
    };
  }

  // Place right of the rightmost element with 40px gap
  const GAP = 40;
  let maxRight = -Infinity;
  let rightEdgeY = 0;
  for (const el of visible) {
    const elRight = (Number(el.x) || 0) + (Number(el.width) || 0);
    if (elRight > maxRight) {
      maxRight = elRight;
      rightEdgeY = (Number(el.y) || 0) + (Number(el.height) || 0) / 2;
    }
  }
  return {
    x: maxRight + GAP,
    y: rightEdgeY - scaled.height / 2,
    width: scaled.width,
    height: scaled.height,
  };
}

// ---------------------------------------------------------------------------
// Element builders
// ---------------------------------------------------------------------------

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

function buildImageElement(
  fileId: string,
  placement: Placement,
  opts: ImageInsertOpts,
): CanvasElement {
  return {
    type: "image",
    id: generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    fileId,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      ...(opts.title ? { title: opts.title } : {}),
      source: "generated" as const,
      sourceJobId: opts.sourceJobId,
      assetId: opts.assetId,
      mimeType: opts.mimeType,
      originalWidth: opts.width,
      originalHeight: opts.height,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  };
}

function buildVideoElement(
  placement: Placement,
  opts: VideoInsertOpts,
): CanvasElement {
  return {
    type: "embeddable",
    id: generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: opts.signedUrl,
    locked: false,
    customData: {
      source: "generated" as const,
      sourceJobId: opts.sourceJobId,
      assetId: opts.assetId,
      isVideo: true,
      mimeType: opts.mimeType,
      ...(opts.durationSeconds != null ? { durationSeconds: opts.durationSeconds } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — Read-Modify-Write canvas content
// ---------------------------------------------------------------------------

const CANVAS_FILES_BUCKET = "workspace-assets";
const IMAGE_MAX_SIZE = 600;
const VIDEO_MAX_SIZE = 800;
const MAX_CANVAS_WRITE_ATTEMPTS = 3;

type CanvasClient = {
  from: (table: string) => any;
  rpc?: any;
  storage: { from: (bucket: string) => any };
};

export async function bindCanvasAssetReference(
  client: CanvasClient,
  canvasId: string,
  assetId: string,
  elementId: string,
): Promise<void> {
  if (!client.rpc) return;
  const rpcResult = await client.rpc("loomic_canvas_asset_ref_upsert", {
    p_canvas_id: canvasId,
    p_asset_id: assetId,
    p_element_id: elementId,
  });
  if (!rpcResult.error && rpcResult.data === true) return;

  // Worker finalization uses the service-role client. Older database versions
  // rejected the membership-aware RPC for service-role calls, so repair the
  // reference directly while preserving the same workspace relationship.
  const canvasResult = await client.from("canvases").select("project_id").eq("id", canvasId).single();
  const projectId = canvasResult.data?.project_id;
  if (canvasResult.error || typeof projectId !== "string") {
    throw new Error("Failed to resolve canvas workspace for asset reference.");
  }
  const projectResult = await client.from("projects").select("workspace_id").eq("id", projectId).single();
  const workspaceId = projectResult.data?.workspace_id;
  if (projectResult.error || typeof workspaceId !== "string") {
    throw new Error("Failed to resolve project workspace for asset reference.");
  }
  const directResult = await client.from("asset_references").upsert({
    asset_id: assetId,
    canvas_id: canvasId,
    workspace_id: workspaceId,
    element_id: elementId,
  }, { onConflict: "canvas_id,element_id" });
  if (directResult.error) throw new Error("Failed to bind canvas asset reference.");
}

export function createCanvasElementId(): string {
  return generateId();
}

function getPlaceholderDimensions(aspectRatio: string): {
  width: number;
  height: number;
} {
  const [rawWidth, rawHeight] = aspectRatio.split(":").map(Number);
  const ratio =
    Number.isFinite(rawWidth) &&
    Number.isFinite(rawHeight) &&
    rawWidth! > 0 &&
    rawHeight! > 0
      ? rawWidth! / rawHeight!
      : 1;
  const maxSize = 512;
  return ratio >= 1
    ? { width: maxSize, height: Math.round(maxSize / ratio) }
    : { width: Math.round(maxSize * ratio), height: maxSize };
}

function buildImageGenerationPlaceholder(
  placement: Placement,
  opts: ImageGenerationPlaceholderOpts,
): CanvasElement {
  return {
    type: "rectangle",
    id: opts.elementId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    strokeColor: "#D1D5DB",
    backgroundColor: "#F3F4F6",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: { type: 3 },
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: {
      type: "image-generator",
      status: "generating",
      prompt: opts.prompt,
      title: opts.title,
      model: opts.model,
      aspectRatio: opts.aspectRatio,
      quality: opts.quality,
      jobId: opts.sourceJobId,
      sourceJobId: opts.sourceJobId,
    },
  };
}

async function writeCanvasWithRetry(
  client: CanvasClient,
  canvasId: string,
  buildIncoming: (latest: CanvasContent) => CanvasContent | null,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CANVAS_WRITE_ATTEMPTS; attempt += 1) {
    const { data: latestRow, error: readError } = await client
      .from("canvases")
      .select("content, updated_at")
      .eq("id", canvasId)
      .single();

    if (readError || !latestRow) {
      throw new Error(`Canvas not found: ${canvasId}`);
    }

    const latest = (latestRow.content as CanvasContent) ?? {
      elements: [],
      appState: {},
      files: {},
    };
    const incoming = buildIncoming(latest);
    // A terminal worker can race a successful replacement, user deletion, or
    // another terminal observer. Do not bump the canvas revision for a no-op.
    if (!incoming) return;
    const merged = mergeCanvasContent(latest, incoming);
    const { data: updated, error: writeError } = await client
      .from("canvases")
      .update({ content: merged as unknown as Json })
      .eq("id", canvasId)
      .eq("updated_at", latestRow.updated_at)
      .select("id")
      .maybeSingle();

    if (writeError) {
      throw new Error(`Failed to write canvas: ${writeError.message}`);
    }
    if (updated) return;
  }

  throw new Error("Failed to write canvas: concurrent update conflict");
}

/**
 * Persist the visible generation state before a worker is allowed to start.
 * The finalizer replaces this exact element id atomically when the image is
 * ready, so refreshes and reconnects do not lose progress feedback.
 */
export async function insertImageGenerationPlaceholder(
  client: CanvasClient,
  opts: ImageGenerationPlaceholderOpts,
  explicitPlacement?: Placement,
): Promise<{ elementId: string; placement: Placement }> {
  let resolvedPlacement: Placement | undefined;
  await writeCanvasWithRetry(client, opts.canvasId, (content) => {
    const elements = (content.elements as CanvasElement[]) ?? [];
    const existing = elements.find((element) => element.id === opts.elementId);
    if (existing) {
      if (existing.isDeleted) throw Object.assign(
        new Error("Image generation placeholder was deleted; it will not be recreated."),
        { code: "image_generation_placeholder_deleted" },
      );
      const customData = existing.customData && typeof existing.customData === "object" && !Array.isArray(existing.customData)
        ? existing.customData as Record<string, unknown> : {};
      if (customData.type !== "image-generator"
        || (customData.jobId !== opts.sourceJobId && customData.sourceJobId !== opts.sourceJobId)) {
        throw Object.assign(
          new Error("Canvas element id conflicts with the image generation placeholder."),
          { code: "image_generation_placeholder_conflict" },
        );
      }
      resolvedPlacement = {
        x: Number(existing.x) || 0,
        y: Number(existing.y) || 0,
        width: Number(existing.width) || 512,
        height: Number(existing.height) || 512,
      };
      return content;
    }

    const nominal = getPlaceholderDimensions(opts.aspectRatio);
    resolvedPlacement =
      explicitPlacement ??
      calculateAutoPlacement(
        elements,
        nominal.width,
        nominal.height,
        IMAGE_MAX_SIZE,
      );
    return {
      ...content,
      elements: [
        ...elements,
        buildImageGenerationPlaceholder(resolvedPlacement, opts),
      ],
    } as CanvasContent;
  });

  if (!resolvedPlacement) {
    throw new Error("Failed to resolve image generation placeholder placement.");
  }
  return { elementId: opts.elementId, placement: resolvedPlacement };
}

export async function markImageGenerationPlaceholderFailed(
  client: CanvasClient,
  canvasId: string,
  elementId: string,
  sourceJobId: string,
  errorMessage: string,
): Promise<boolean> {
  let changed = false;
  await writeCanvasWithRetry(client, canvasId, (content) => {
    changed = false;
    const elements = (content.elements as CanvasElement[]) ?? [];
    const target = elements.find((element) => element.id === elementId);
    const targetData = target?.customData && typeof target.customData === "object" && !Array.isArray(target.customData)
      ? target.customData as Record<string, unknown> : null;
    // Only settle the still-live placeholder created for this exact job. A
    // generated image, tombstone, unrelated reused ID, or user-edited state is
    // authoritative and must never be overwritten by a late worker outcome.
    if (!target || target.isDeleted || targetData?.type !== "image-generator"
      || targetData.status !== "generating"
      || (targetData.jobId !== sourceJobId && targetData.sourceJobId !== sourceJobId)) return null;
    changed = true;
    return {
      ...content,
      elements: elements.map((element) => {
        if (element.id !== elementId) return element;
        const customData =
          element.customData &&
          typeof element.customData === "object" &&
          !Array.isArray(element.customData)
            ? element.customData as Record<string, unknown>
            : {};
        return {
          ...element,
          customData: {
            ...customData,
            status: "error",
            errorMessage,
          },
          version: (Number(element.version) || 1) + 1,
          versionNonce: Math.floor(Math.random() * 2_000_000_000),
          updated: Date.now(),
        };
      }),
    } as CanvasContent;
  });
  return changed;
}

/**
 * Insert an image element into a canvas. Reads current content, appends element
 * with auto-placement (or explicit placement), writes it back.
 *
 * The image file is already in Supabase Storage (uploaded by worker executor).
 * Store only a private Storage marker. The canvas read API issues a fresh
 * short-lived signed URL and the browser hydrates it for Excalidraw.
 */
export async function removeCompletedImagePlaceholder(
  client: CanvasClient, canvasId: string, elementId: string, sourceJobId: string,
): Promise<boolean> {
  let changed = false;
  await writeCanvasWithRetry(client, canvasId, (content) => {
    changed = false;
    const elements = (content.elements as CanvasElement[]) ?? [];
    const target = elements.find(element => element.id === elementId);
    const data = target?.customData as Record<string, unknown> | undefined;
    if (!target || (target.isDeleted && data?.completedJobId === sourceJobId) || target.type === "image"
      || !["image-replacement", "image-generator"].includes(String(data?.type))
      || (data?.jobId !== sourceJobId && data?.sourceJobId !== sourceJobId)) return null;
    changed = true;
    return { ...content, elements: elements.map(element => element.id === elementId ? {
      ...element, isDeleted: true, customData: { ...data, completedJobId: sourceJobId }, version: (Number(element.version) || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000), updated: Date.now(),
    } : element) } as CanvasContent;
  });
  return changed;
}

export async function insertImageElement(
  client: CanvasClient,
  opts: ImageInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  const dataURL = `oss://${CANVAS_FILES_BUCKET}/${opts.objectPath}`;

  // Allocate a stable file id once. On a CAS conflict the element is rebuilt
  // against the latest layout, but no duplicate file entry can be created.
  const fileId = generateId();
  let insertedElementId = "";
  let inserted = true;
  await writeCanvasWithRetry(client, opts.canvasId, (content) => {
    const elements = (content.elements as CanvasElement[]) ?? [];
    const replacement = elements.find(element => element.id === opts.replaceElementId);
    const replacementData = replacement?.customData as Record<string, unknown> | undefined;
    const replaceInPlace = (replacementData?.type === "image-replacement" || replacementData?.type === "image-generator") &&
      replacementData.jobId === opts.sourceJobId;
    if (replacement?.type === "image" && replacementData?.sourceJobId === opts.sourceJobId) {
      insertedElementId = replacement.id as string;
      inserted = false;
      return content;
    }
    const nextElements = opts.replaceElementId
      ? elements.map((element) => !replaceInPlace && element.id === opts.replaceElementId && !element.isDeleted
          ? {
              ...element,
              isDeleted: true,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2_000_000_000),
              updated: Date.now(),
            }
          : element)
      : elements;
    // A generating node also carries sourceJobId. Only finished image pixels
    // prove replay completion; the pending node must still be replaced.
    const imageElements = nextElements.filter(element => element.type === "image");
    const existing = findElementBySourceJobId(imageElements, opts.sourceJobId, false);
    if (existing) {
      insertedElementId = existing.id as string;
      inserted = false;
      return nextElements === elements ? content : { ...content, elements: nextElements } as CanvasContent;
    }
    if (opts.rejectDeletedSourceJob && (
      findElementBySourceJobId(imageElements, opts.sourceJobId, true)
      || findDeletedElementById(imageElements, opts.knownElementId)
    )) {
      throw deletedSourceJobError();
    }
    inserted = true;
    const files = ((content as { files?: Record<string, Record<string, unknown>> })
      .files ?? {});
    const reservedPlacement = replaceInPlace ? {
      x: Number(replacement!.x), y: Number(replacement!.y),
      width: Number(replacement!.width), height: Number(replacement!.height),
    } : explicitPlacement ?? calculateAutoPlacement(
      nextElements, opts.width, opts.height, IMAGE_MAX_SIZE,
    );
    // A pending node reserves layout space, not permission to stretch the
    // delivered pixels. Keep its live position and fit the actual image into
    // that box (including a user-resized/moved node during generation).
    const fit = Math.min(reservedPlacement.width / opts.width, reservedPlacement.height / opts.height);
    const placement = { ...reservedPlacement,
      width: opts.width * fit, height: opts.height * fit };
    const element = buildImageElement(fileId, placement, opts);
    if (replaceInPlace && replacementData?.type === "image-generator") {
      element.customData = { ...(element.customData as Record<string, unknown>), sourceNodeType: "image-generator" };
    }
    const sourceRequestId = (replacementData?.nodeImageRequest as Record<string, unknown> | undefined)?.requestId;
    if (replaceInPlace && typeof sourceRequestId === "string") {
      element.customData = { ...(element.customData as Record<string, unknown>), sourceRequestId };
    }
    if (replaceInPlace) Object.assign(element, {
      id: replacement!.id,
      angle: replacement!.angle ?? 0,
      frameId: replacement!.frameId ?? null,
      groupIds: replacement!.groupIds ?? [],
      locked: replacement!.locked ?? false,
      isDeleted: replacement!.isDeleted === true,
      version: Number(replacement!.version ?? 1) + 1,
    });
    insertedElementId = element.id as string;
    return {
      ...content,
      elements: replaceInPlace ? nextElements.map(item => item.id === element.id ? element : item) : [...nextElements, element],
      files: {
        ...files,
        [fileId]: {
          id: fileId,
          dataURL,
          mimeType: opts.mimeType,
          created: Date.now(),
          assetId: opts.assetId,
        },
      },
    } as CanvasContent;
  });

  console.log(`[canvas-element-writer] image inserted canvasId=${opts.canvasId} elementId=${insertedElementId}`);
  // Always (re)bind the reference. A previous canvas write may have succeeded
  // while the reference RPC failed, and idempotent retries must heal that gap.
  await bindCanvasAssetReference(client, opts.canvasId, opts.assetId, insertedElementId);
  return { elementId: insertedElementId, inserted };
}

/**
 * Insert a video element into a canvas. Videos use Excalidraw's `embeddable`
 * type with a link URL — no files map entry needed.
 */
export async function insertVideoElement(
  client: CanvasClient,
  opts: VideoInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  let insertedElementId = "";
  let inserted = true;
  await writeCanvasWithRetry(client, opts.canvasId, (content) => {
    const elements = (content.elements as CanvasElement[]) ?? [];
    const videoElements = elements.filter(element => element.type === "embeddable");
    const existing = findElementBySourceJobId(videoElements, opts.sourceJobId, false);
    if (existing) {
      insertedElementId = existing.id as string;
      inserted = false;
      return content;
    }
    if (opts.rejectDeletedSourceJob && (
      findElementBySourceJobId(videoElements, opts.sourceJobId, true)
      || findDeletedElementById(videoElements, opts.knownElementId)
    )) {
      throw deletedSourceJobError();
    }
    inserted = true;
    const placement = explicitPlacement ?? calculateAutoPlacement(
      elements, opts.width, opts.height, VIDEO_MAX_SIZE,
    );
    const element = buildVideoElement(placement, opts);
    insertedElementId = element.id as string;
    return {
      ...content,
      elements: [...elements, element],
    } as CanvasContent;
  });

  console.log(`[canvas-element-writer] video inserted canvasId=${opts.canvasId} elementId=${insertedElementId}`);
  // See the image path above: retries also repair a missing reference row.
  await bindCanvasAssetReference(client, opts.canvasId, opts.assetId, insertedElementId);
  return { elementId: insertedElementId, inserted };
}

function findElementBySourceJobId(
  elements: CanvasElement[],
  sourceJobId: string,
  deleted: boolean,
): CanvasElement | undefined {
  return elements.find((element) => {
    if ((element.isDeleted === true) !== deleted) return false;
    const customData = element.customData;
    return (
      customData !== null &&
      typeof customData === "object" &&
      !Array.isArray(customData) &&
      (customData as Record<string, unknown>).sourceJobId === sourceJobId
    );
  });
}

function deletedSourceJobError(): Error & { code: "canvas_result_deleted" } {
  return Object.assign(
    new Error("The generated canvas result was deleted and cannot be restored."),
    { code: "canvas_result_deleted" as const },
  );
}

function findDeletedElementById(
  elements: CanvasElement[],
  elementId: string | undefined,
): CanvasElement | undefined {
  if (!elementId) return undefined;
  return elements.find(element => element.id === elementId && element.isDeleted === true);
}
