export type CanvasElementLike = {
  id: string;
  version?: number;
  [key: string]: unknown;
};

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
    if (!remote) return local;

    remoteById.delete(local.id);
    const localVersion = Number(local.version ?? 0);
    const remoteVersion = Number(remote.version ?? 0);
    // On equal versions prefer the browser copy: it may contain an unsaved
    // state that has not yet been reflected in the fetched snapshot.
    return remoteVersion > localVersion ? remote : local;
  });

  for (const remote of remoteElements) {
    if (remoteById.has(remote.id)) merged.push(remote);
  }

  return merged;
}
