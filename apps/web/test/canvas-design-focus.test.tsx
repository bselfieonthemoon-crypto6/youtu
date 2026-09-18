// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasEditor } from "../src/components/canvas-editor";

const { nativeDoubleClick, canvasApi } = vi.hoisted(() => ({
  nativeDoubleClick: vi.fn(),
  canvasApi: {
    getSceneElements: () => [],
    getSceneElementsIncludingDeleted: () => [],
    getAppState: () => ({}),
    getFiles: () => ({}),
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function NativeCanvas({
      excalidrawAPI,
    }: { excalidrawAPI: (api: typeof canvasApi) => void }) {
      useEffect(() => {
        excalidrawAPI(canvasApi);
      }, [excalidrawAPI]);
      return (
        <canvas
          aria-label="native canvas"
          tabIndex={0}
          onDoubleClick={nativeDoubleClick}
        />
      );
    },
}));
vi.mock("../src/components/design/design-node-overlay-layer", () => ({
  DesignNodeOverlayLayer: () => (
    <div
      data-testid="design-node-preview"
      data-design-id="design-1"
      data-canvas-element-id="board-1"
    />
  ),
}));
vi.mock("../src/components/canvas-tool-menu", () => ({
  CanvasToolMenu: () => null,
}));
vi.mock("../src/components/toast", () => ({
  useToast: () => ({ error: vi.fn() }),
}));
vi.mock("../src/lib/server-api", () => ({
  saveCanvas: vi.fn(),
  uploadThumbnail: vi.fn(),
}));

const props = {
  accessToken: "token",
  canvasId: "canvas-1",
  projectId: "project-1",
  canvasRevision: 1,
  initialContent: { elements: [], appState: {}, files: {} },
  onCanvasRevisionChange: () => {},
};

beforeEach(() => {
  nativeDoubleClick.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function placePreview() {
  const preview = screen.getByTestId("design-node-preview");
  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 30,
    left: 20,
    top: 30,
    right: 220,
    bottom: 130,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  });
}

describe("native design double-click focus routing", () => {
  it("opens the design once without starting Excalidraw's hidden text editor", () => {
    const open = vi.fn();
    render(
      <>
        <CanvasEditor {...props} onOpenDesign={open} />
        <textarea aria-label="chat composer" />
      </>,
    );
    placePreview();
    fireEvent.doubleClick(screen.getByLabelText("native canvas"), {
      clientX: 100,
      clientY: 80,
    });
    expect(open).toHaveBeenCalledExactlyOnceWith({
      designId: "design-1",
      canvasElementId: "board-1",
    });
    expect(nativeDoubleClick).not.toHaveBeenCalled();
  });

  it("preserves ordinary canvas double-click editing outside a design artboard", () => {
    const open = vi.fn();
    render(<CanvasEditor {...props} onOpenDesign={open} />);
    placePreview();
    fireEvent.doubleClick(screen.getByLabelText("native canvas"), {
      clientX: 400,
      clientY: 300,
    });
    expect(open).not.toHaveBeenCalled();
    expect(nativeDoubleClick).toHaveBeenCalledOnce();
  });
});
