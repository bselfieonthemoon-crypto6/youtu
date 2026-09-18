import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasBottomBar } from "../src/components/canvas-bottom-bar";
vi.mock("../src/components/toast", () => ({ useToast: () => ({ success: vi.fn() }) }));
vi.mock("../src/components/canvas-minimap", () => ({ CanvasMinimap: () => null }));
afterEach(cleanup);
it("tidies in one undoable update and disables while editing a board", () => {
  const elements = [
    { id: "a", type: "image", x: 0, y: 0, width: 100, height: 100, version: 1 },
    { id: "b", type: "image", x: 20, y: 20, width: 100, height: 100, version: 2 },
  ];
  const api = { getAppState: () => ({ zoom: { value: 1 }, selectedElementIds: {} }),
    onChange: () => () => {}, getSceneElementsIncludingDeleted: () => elements, updateScene: vi.fn() };
  const props = { excalidrawApi: api, layersOpen: false, filesOpen: false, leftPanelOpen: false, onToggleLayers: vi.fn(), onToggleFiles: vi.fn() };
  const view = render(<CanvasBottomBar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "整理画布" }));
  expect(api.updateScene).toHaveBeenCalledOnce();
  const update = api.updateScene.mock.calls[0]![0];
  expect(update.captureUpdate).toBe("IMMEDIATELY");
  expect(update.elements[1].version).toBe(3);
  expect(update.elements[1].width).toBe(100);
  view.rerender(<CanvasBottomBar {...props} editingDesign />);
  expect((screen.getByRole("button", { name: "整理画布" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "整理画布" }));
  expect(api.updateScene).toHaveBeenCalledOnce();
});
