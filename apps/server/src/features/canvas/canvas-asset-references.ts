import type { CanvasContent } from "@loomic/shared";

type CanvasRecord = Record<string, unknown>;
type StorageClient = {
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  storage: { from: (bucket: string) => any };
};

export type CanvasAssetReference = { assetId: string; elementId: string };

export function collectLiveAssetReferences(
  content: CanvasContent,
): CanvasAssetReference[] {
  const refs: CanvasAssetReference[] = [];
  for (const element of (content.elements ?? []) as CanvasRecord[]) {
    if (element.isDeleted || typeof element.id !== "string") continue;
    const customData = asRecord(element.customData);
    const assetId = customData?.assetId;
    if (typeof assetId === "string" && isUuid(assetId)) {
      refs.push({ assetId, elementId: element.id });
    }
  }
  return refs;
}

export function pruneFilesWithoutLiveElements(content: CanvasContent): CanvasContent {
  const liveFileIds = new Set<string>();
  for (const element of (content.elements ?? []) as CanvasRecord[]) {
    if (!element.isDeleted && typeof element.fileId === "string") {
      liveFileIds.add(element.fileId);
    }
  }
  const files = ((content as { files?: Record<string, CanvasRecord> }).files ?? {});
  return {
    ...content,
    files: Object.fromEntries(
      Object.entries(files).filter(([fileId]) => liveFileIds.has(fileId)),
    ),
  } as CanvasContent;
}

export function collectCanvasOwnedStoragePaths(
  content: CanvasContent,
  workspaceId: string,
  canvasId: string,
): string[] {
  const prefix = `oss://workspace-assets/${workspaceId}/canvas-files/${canvasId}/`;
  const files = ((content as { files?: Record<string, CanvasRecord> }).files ?? {});
  return Object.values(files)
    .map((file) => readStorageRef(file))
    .filter((ref): ref is string => typeof ref === "string" && ref.startsWith(prefix))
    .map((ref) => ref.slice("oss://workspace-assets/".length));
}

export async function reconcileCanvasAssetReferences(
  client: StorageClient,
  canvasId: string,
  content: CanvasContent,
): Promise<string[]> {
  const { data, error } = await client.rpc("loomic_canvas_asset_refs_replace", {
    p_canvas_id: canvasId,
    p_refs: collectLiveAssetReferences(content).map((ref) => ({
      assetId: ref.assetId,
      elementId: ref.elementId,
    })),
  });
  if (error) throw new Error("Failed to synchronize canvas asset references.");
  return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : [];
}

export async function garbageCollectOrphanAssets(
  client: StorageClient,
  assetIds: string[],
): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    const { data, error } = await client.rpc("loomic_orphan_asset_claim", {
      p_asset_id: assetId,
    });
    if (error) continue;
    const claimed = Array.isArray(data) ? data[0] : null;
    if (!claimed?.bucket || !claimed?.object_path) continue;

    const { error: removeError } = await client.storage
      .from(claimed.bucket)
      .remove([claimed.object_path]);
    if (removeError) continue;

    await client.rpc("loomic_orphan_asset_finalize", { p_asset_id: assetId });
  }
}

function readStorageRef(file: CanvasRecord): string | undefined {
  if (typeof file.storageRef === "string") return file.storageRef;
  if (typeof file.dataURL === "string" && file.dataURL.startsWith("oss://")) {
    return file.dataURL;
  }
  return undefined;
}

function asRecord(value: unknown): CanvasRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CanvasRecord
    : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
