import { readDesignNodeMetadata } from './design-node-helpers';
import { mergeCompletedImageReplacement, mergePendingNodeImageSubmission } from '@loomic/shared';

export type CanvasElementLike = {
  id: string;
  version?: number;
  [key: string]: unknown;
};

function mergeCompletedImagePlaceholder<T extends CanvasElementLike>(
  local: T,
  remote: T,
): T | null {
  if (!remote.isDeleted) return null;
  const localData = local.customData;
  const remoteData = remote.customData;
  if (
    !localData ||
    typeof localData !== "object" ||
    Array.isArray(localData) ||
    !remoteData ||
    typeof remoteData !== "object" ||
    Array.isArray(remoteData)
  ) {
    return null;
  }
  const localJobId = (localData as Record<string, unknown>).jobId;
  const remoteJobId = (remoteData as Record<string, unknown>).jobId;
  if (
    (localData as Record<string, unknown>).type !== "image-replacement" ||
    (remoteData as Record<string, unknown>).type !== "image-replacement" ||
    typeof localJobId !== "string" ||
    localJobId !== remoteJobId ||
    (remoteData as Record<string, unknown>).completedJobId !== remoteJobId
  ) {
    return null;
  }
  // The worker only writes this tombstone after its complete layer package is
  // durable. It must beat a stale local placeholder even when the browser has
  // a higher geometry version, otherwise a later autosave revives it.
  const localVersion = Number(local.version ?? 0);
  const remoteVersion = Number(remote.version ?? 0);
  if (local.isDeleted) {
    return {
      ...remote,
      isDeleted: true,
      version: Math.max(localVersion, remoteVersion),
      versionNonce:
        remoteVersion >= localVersion
          ? remote.versionNonce
          : local.versionNonce,
    };
  }
  return {
    ...remote,
    isDeleted: true,
    version: Math.max(localVersion, remoteVersion) + 1,
    versionNonce: (Number(remote.versionNonce ?? local.versionNonce ?? 0) + 1) % 2147483647,
  };
}

/**
 * Merge a server canvas refresh into the browser scene without discarding
 * local edits that have not reached the server yet.
 *
 * Excalidraw increments `version` for edits and deletions. Local order is kept
 * stable, while elements created by a worker or agent are appended.
 */
export function mergeCanvasElements<T extends CanvasElementLike>(
  localElements: readonly T[],
  remoteElements: readonly T[],
): T[] {
  const remoteById = new Map(
    remoteElements.map((element) => [element.id, element]),
  );
  const merged = localElements.map((local) => {
    const remote = remoteById.get(local.id);
    const completedSemanticPlaceholder = remote
      ? mergeCompletedImagePlaceholder(local, remote)
      : null;
    if (completedSemanticPlaceholder) {
      remoteById.delete(local.id);
      return completedSemanticPlaceholder;
    }
    if (!remote) return local;

    remoteById.delete(local.id);
    const completed = mergeCompletedImageReplacement(local, remote);
    if (completed) return completed as T;
    const pending = mergePendingNodeImageSubmission(local, remote);
    if (pending) return pending as T;
    const localVersion = Number(local.version ?? 0);
    const remoteVersion = Number(remote.version ?? 0);
    // On equal versions prefer the browser copy: it may contain an unsaved
    // state that has not yet been reflected in the fetched snapshot.
    const base = remoteVersion > localVersion ? remote : local;
    const localDesign = readDesignNodeMetadata(local);
    const remoteDesign = readDesignNodeMetadata(remote);
    if (!base.isDeleted && localDesign && remoteDesign && localDesign.designId === remoteDesign.designId) {
      // Document/preview revisions are independent of Excalidraw geometry
      // versions. Keep unsaved position/size while accepting a newer preview.
      const preview = remoteDesign.previewRevision > localDesign.previewRevision
        || (remoteDesign.previewRevision === localDesign.previewRevision && !localDesign.previewAssetObjectId)
        ? remoteDesign : localDesign;
      const revision = Math.max(localDesign.revision, remoteDesign.revision);
      const baseDesign = base === local ? localDesign : remoteDesign;
      if (baseDesign.revision === revision && baseDesign.previewRevision === preview.previewRevision
        && baseDesign.previewAssetObjectId === preview.previewAssetObjectId) return base;
      return { ...base,
        // Excalidraw's scene-change notifications are version-based too.
        version: Math.max(localVersion, remoteVersion) + 1,
        versionNonce: (Number(base.versionNonce ?? 0) + 1) % 2147483647,
        customData: {
        ...(base.customData as Record<string, unknown>),
        revision,
        previewRevision: preview.previewRevision,
        previewAssetObjectId: preview.previewAssetObjectId,
      } };
    }
    return base;
  });

  for (const remote of remoteElements) {
    if (remoteById.has(remote.id)) merged.push(remote);
  }

  return merged;
}
