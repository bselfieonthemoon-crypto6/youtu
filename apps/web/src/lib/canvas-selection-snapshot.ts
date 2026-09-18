export type CanvasSelectionSnapshot = { elementIds: string[] };
export type CanvasSelectionReader = {
  getAppState(): { selectedElementIds?: Record<string, unknown> | undefined };
  getSceneElements(): readonly { id: string; isDeleted?: boolean | undefined }[];
};

/** Read the actual current app state and scene together at send time. Never
 * infer selection from text, position, a cached sidebar prop, or another canvas. */
export function captureCanvasSelection(api: CanvasSelectionReader | null | undefined): CanvasSelectionSnapshot {
  if (!api) return { elementIds: [] };
  try {
    const selected = api.getAppState().selectedElementIds ?? {};
    const liveIds = new Set(api.getSceneElements().filter(element => !element.isDeleted).map(element => element.id));
    const elementIds = Object.keys(selected).filter(id => selected[id] === true && id.length > 0 && id.length <= 200 && liveIds.has(id));
    // A partial selection would misrepresent plural user intent. Never truncate.
    return { elementIds: elementIds.length <= 100 ? elementIds : [] };
  } catch {
    return { elementIds: [] };
  }
}
