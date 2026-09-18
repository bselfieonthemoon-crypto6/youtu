import {
  type LoomicDesignNodeMetadata,
  loomicDesignNodeMetadataSchema,
} from "@loomic/shared";

import { getViewportCenter } from "./canvas-elements";
import {
  type DesignNodeElementLike,
  collectDesignNodes,
  inspectPastedDesignNodes,
} from "./design-node-helpers";

export const DESIGN_SIZE_PRESETS = [
  { label: "方形", width: 1080, height: 1080 },
  { label: "横版", width: 1600, height: 900 },
  { label: "竖版", width: 1080, height: 1440 },
  { label: "演示文稿", width: 1920, height: 1080 },
] as const;

export type DesignOpenTarget = {
  designId: string;
  canvasElementId: string;
  initialObjectId?: string;
};

export type DesignCopyAttempt = { requestId: string; elementId: string };

export type DesignPreviewHitTarget = DesignOpenTarget & {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function getOrCreateDesignCopyAttempt(
  attempts: Map<string, DesignCopyAttempt>,
  sourceElementId: string,
  createId: () => string = () => crypto.randomUUID(),
): DesignCopyAttempt {
  const existing = attempts.get(sourceElementId);
  if (existing) return existing;
  const attempt = { requestId: createId(), elementId: createId() };
  attempts.set(sourceElementId, attempt);
  return attempt;
}

export function getDesignCopyPlacement(design: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    x: design.x + design.width + 40,
    y: design.y,
    width: design.width,
    height: design.height,
  };
}

export function getDesignNodePlacement(
  appState: {
    scrollX: number;
    scrollY: number;
    width: number;
    height: number;
    zoom: { value: number };
  },
  designWidth: number,
  designHeight: number,
) {
  const center = getViewportCenter(appState);
  const scale = 320 / Math.max(designWidth, designHeight);
  const width = designWidth * scale;
  const height = designHeight * scale;
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

export function readDesignNodeMetadata(
  element: unknown,
): LoomicDesignNodeMetadata | null {
  if (!element || typeof element !== "object") return null;
  const customData = (element as { customData?: unknown }).customData;
  const parsed = loomicDesignNodeMetadataSchema.safeParse(customData);
  return parsed.success ? parsed.data : null;
}

export function findDesignOpenTarget(
  elements: readonly unknown[],
  selectedElementIds: Record<string, boolean> | undefined,
): DesignOpenTarget | null {
  if (!selectedElementIds) return null;
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const candidate = element as { id?: unknown; isDeleted?: unknown };
    if (
      typeof candidate.id !== "string" ||
      candidate.isDeleted === true ||
      selectedElementIds[candidate.id] !== true
    ) {
      continue;
    }
    const metadata = readDesignNodeMetadata(candidate);
    if (metadata) {
      return { designId: metadata.designId, canvasElementId: candidate.id };
    }
  }
  return null;
}

export function findDesignOpenTargetAtPoint(
  elements: readonly unknown[],
  appState: {
    scrollX?: number;
    scrollY?: number;
    zoom?: { value?: number };
  },
  viewportPoint: { x: number; y: number },
): DesignOpenTarget | null {
  const zoom = Number(appState.zoom?.value ?? 1);
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  const scenePoint = {
    x: viewportPoint.x / zoom - Number(appState.scrollX ?? 0),
    y: viewportPoint.y / zoom - Number(appState.scrollY ?? 0),
  };
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (!element || typeof element !== "object") continue;
    const candidate = element as {
      id?: unknown;
      isDeleted?: unknown;
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
      angle?: unknown;
    };
    if (typeof candidate.id !== "string" || candidate.isDeleted === true)
      continue;
    const metadata = readDesignNodeMetadata(candidate);
    if (!metadata) continue;
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const width = Number(candidate.width);
    const height = Number(candidate.height);
    const angle = Number(candidate.angle ?? 0);
    if (![x, y, width, height, angle].every(Number.isFinite)) continue;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const dx = scenePoint.x - centerX;
    const dy = scenePoint.y - centerY;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    if (Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2) {
      return { designId: metadata.designId, canvasElementId: candidate.id };
    }
  }
  return null;
}

export function findDesignPreviewOpenTarget(
  targets: readonly DesignPreviewHitTarget[],
  clientPoint: { x: number; y: number },
): DesignOpenTarget | null {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];
    if (
      target &&
      clientPoint.x >= target.left &&
      clientPoint.x <= target.right &&
      clientPoint.y >= target.top &&
      clientPoint.y <= target.bottom
    ) {
      return {
        designId: target.designId,
        canvasElementId: target.canvasElementId,
      };
    }
  }
  return null;
}

export function findPastedDuplicateDesignElementIds(
  previousElements: readonly DesignNodeElementLike[],
  nextElements: readonly DesignNodeElementLike[],
): string[] {
  const inspection = inspectPastedDesignNodes(previousElements, nextElements);
  const previousDesignIds = new Set(
    collectDesignNodes(previousElements).map((node) => node.metadata.designId),
  );
  return [
    ...new Set([
      ...inspection.duplicateElementIds,
      ...inspection.pasted.flatMap((node) =>
        previousDesignIds.has(node.metadata.designId) ? [node.elementId] : [],
      ),
    ]),
  ];
}

export function tombstonePastedDuplicateDesignNodes<
  T extends DesignNodeElementLike & Record<string, unknown>,
>(
  previousElements: readonly DesignNodeElementLike[],
  nextElements: readonly T[],
  timestamp = Date.now(),
  createNonce: () => number = () => Math.floor(Math.random() * 2_000_000_000),
): { elements: T[]; rejectedElementIds: string[] } {
  const rejectedElementIds = findPastedDuplicateDesignElementIds(
    previousElements,
    nextElements,
  );
  const rejected = new Set(rejectedElementIds);
  return {
    rejectedElementIds,
    elements: nextElements.map((element) =>
      typeof element.id === "string" && rejected.has(element.id)
        ? ({
            ...element,
            isDeleted: true,
            version: Number(element.version ?? 1) + 1,
            versionNonce: createNonce(),
            updated: timestamp,
          } as T)
        : element,
    ),
  };
}
