export function buildInitialCanvasAppState(
  persisted: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...persisted,
    // Excalidraw renders its native dashed alignment guides while dragging and
    // snaps edges/centres when this mode is enabled. Keep it on by default for
    // visual canvas work, even for canvases saved before the option existed.
    objectsSnapModeEnabled: true,
  };
}
