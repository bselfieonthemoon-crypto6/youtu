import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CanvasLayersPanel,
  toggleCanvasLayerLock,
  toggleCanvasLayerVisibility,
} from "../src/components/canvas-layers-panel";

function createApi(initialElement: Record<string, unknown>) {
  let elements = [initialElement];
  let appState = { selectedElementIds: { [String(initialElement.id)]: true } };
  let changeListener: (() => void) | undefined;
  const updateScene = vi.fn((scene: { elements?: Record<string, unknown>[]; appState?: typeof appState }) => {
    if (scene.elements) elements = scene.elements;
    if (scene.appState) appState = { ...appState, ...scene.appState };
    changeListener?.();
  });
  return {
    getSceneElements: () => elements,
    getFiles: () => ({}),
    getAppState: () => appState,
    updateScene,
    onChange: (listener: () => void) => {
      changeListener = listener;
      return () => { changeListener = undefined; };
    },
  };
}

describe("CanvasLayersPanel", () => {
  it("locks and unlocks a layer as an immediate canvas update", () => {
    const api = createApi({ id: "layer-1", type: "rectangle", locked: false, version: 3 });

    toggleCanvasLayerLock(api, "layer-1");
    expect(api.getSceneElements()[0]).toMatchObject({ locked: true, version: 4 });
    expect(api.updateScene).toHaveBeenLastCalledWith(expect.objectContaining({ captureUpdate: "IMMEDIATELY" }));

    toggleCanvasLayerLock(api, "layer-1");
    expect(api.getSceneElements()[0]).toMatchObject({ locked: false, version: 5 });
  });

  it("hides without deleting and restores the original opacity and lock state", () => {
    const api = createApi({ id: "layer-1", type: "image", opacity: 72, locked: false, version: 1 });

    toggleCanvasLayerVisibility(api, "layer-1");
    expect(api.getSceneElements()[0]).toMatchObject({
      opacity: 0,
      locked: true,
      customData: {
        loomicLayerHidden: true,
        loomicLayerRestoreOpacity: 72,
        loomicLayerRestoreLocked: false,
      },
    });
    expect("isDeleted" in api.getSceneElements()[0]!).toBe(false);
    expect(api.getAppState().selectedElementIds).toEqual({});

    toggleCanvasLayerVisibility(api, "layer-1");
    expect(api.getSceneElements()[0]).toMatchObject({
      opacity: 72,
      locked: false,
      customData: { loomicLayerHidden: false },
    });
  });

  it("wires the Chinese layer controls without selecting the row", async () => {
    const api = createApi({ id: "layer-1", type: "rectangle", locked: false, version: 1 });
    render(<CanvasLayersPanel excalidrawApi={api} open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "锁定图层" }));
    expect(api.getSceneElements()[0]).toMatchObject({ locked: true });
    expect(api.getAppState().selectedElementIds).toEqual({ "layer-1": true });

    fireEvent.click(screen.getByRole("button", { name: "隐藏图层" }));
    expect(api.getSceneElements()[0]).toMatchObject({ opacity: 0, locked: true });
    expect(api.getAppState().selectedElementIds).toEqual({});
    expect(await screen.findByRole("button", { name: "显示图层" })).toBeTruthy();
  });
});
