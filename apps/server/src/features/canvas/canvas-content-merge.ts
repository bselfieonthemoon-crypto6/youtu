import type { CanvasContent } from "@loomic/shared";
import { pruneFilesWithoutLiveElements } from "./canvas-asset-references.js";

type CanvasRecord = Record<string, unknown>;

function versionOf(element: CanvasRecord): number {
  return typeof element.version === "number" ? element.version : 0;
}

function mergeDefined(
  base: CanvasRecord,
  overlay: CanvasRecord,
): CanvasRecord {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Merge a possibly stale full-canvas snapshot with the latest persisted state.
 * Excalidraw tombstones make deletions explicit, while elements that arrived
 * from another writer after the client snapshot are retained.
 */
export function mergeCanvasContent(
  latest: CanvasContent,
  incoming: CanvasContent,
): CanvasContent {
  const latestElements = (latest.elements ?? []) as CanvasRecord[];
  const incomingElements = (incoming.elements ?? []) as CanvasRecord[];
  const byId = new Map<string, CanvasRecord>();

  for (const element of latestElements) {
    if (typeof element.id === "string") byId.set(element.id, element);
  }
  for (const element of incomingElements) {
    if (typeof element.id !== "string") continue;
    const current = byId.get(element.id);
    if (!current || versionOf(element) >= versionOf(current)) {
      byId.set(element.id, element);
    }
  }

  const latestFiles = ((latest as { files?: Record<string, CanvasRecord> })
    .files ?? {}) as Record<string, CanvasRecord>;
  const incomingFiles = ((incoming as { files?: Record<string, CanvasRecord> })
    .files ?? {}) as Record<string, CanvasRecord>;
  const files: Record<string, CanvasRecord> = { ...latestFiles };
  for (const [fileId, file] of Object.entries(incomingFiles)) {
    files[fileId] = mergeDefined(files[fileId] ?? {}, file);
  }

  return pruneFilesWithoutLiveElements({
    ...latest,
    ...incoming,
    elements: Array.from(byId.values()),
    files,
  } as CanvasContent);
}
