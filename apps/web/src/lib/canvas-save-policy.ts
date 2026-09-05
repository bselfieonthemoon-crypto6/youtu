export type SavePolicyElement = {
  id?: unknown;
  version?: unknown;
  isDeleted?: unknown;
};

export const CANVAS_SAVE_DEBOUNCE_MS = 1_500;

/**
 * Stable signature for Excalidraw deletion tombstones. A changed signature
 * means a deletion (or a newer deletion revision) must be persisted without
 * waiting for the normal edit debounce.
 */
export function deletionRevisionKey(
  elements: readonly SavePolicyElement[],
): string {
  return elements
    .filter((element) => element.isDeleted === true && typeof element.id === "string")
    .map((element) => `${element.id}:${Number(element.version ?? 0)}`)
    .sort()
    .join("|");
}

export function canvasSaveDelay(
  previousDeletionKey: string,
  elements: readonly SavePolicyElement[],
): { delayMs: number; deletionKey: string } {
  const deletionKey = deletionRevisionKey(elements);
  return {
    delayMs: deletionKey !== previousDeletionKey ? 0 : CANVAS_SAVE_DEBOUNCE_MS,
    deletionKey,
  };
}
