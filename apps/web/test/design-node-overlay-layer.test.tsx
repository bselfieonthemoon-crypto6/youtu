import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAssetBlob } = vi.hoisted(() => ({ fetchAssetBlob: vi.fn() }));
const { getDesign } = vi.hoisted(() => ({ getDesign: vi.fn() }));
vi.mock("../src/lib/canvas-elements", () => ({ fetchAssetBlob }));
vi.mock("../src/lib/design-api", () => ({ createDesignApiClient: () => ({ getDesign }) }));

import { DesignNodeOverlayLayer } from "../src/components/design/design-node-overlay-layer";

const metadata = {
  kind: "loomic-design",
  schemaVersion: 1,
  designId: "10000000-0000-4000-8000-000000000001",
  revision: 2,
  previewAssetObjectId: "20000000-0000-4000-8000-000000000001",
  previewRevision: 2,
};

describe("DesignNodeOverlayLayer", () => {
  it("hides only the edited board snapshot without removing its geometry anchor, then restores it", async () => {
    const otherId = "10000000-0000-4000-8000-000000000002";
    const api = { getAppState: () => ({ width: 1000, height: 800 }),
      getSceneElements: () => [metadata.designId, otherId].map((id, i) => ({
        id, x: i * 350, y: 20, width: 320, height: 240,
        customData: { ...metadata, designId: id },
      })) };
    const { rerender } = render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} editingDesignId={metadata.designId} />);
    const nodes = await screen.findAllByTestId("design-node-preview");
    expect(nodes[0]).toHaveStyle({ visibility: "hidden", width: "320px", height: "240px" });
    expect(nodes[1]).toHaveStyle({ visibility: "visible" });
    rerender(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} editingDesignId={null} />);
    expect(nodes[0]).toHaveStyle({ visibility: "visible" });
  });
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getDesign.mockRejectedValue(new Error('offline'));
    fetchAssetBlob.mockResolvedValue(
      new Blob(["preview"], { type: "image/webp" }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    URL.createObjectURL = vi.fn(() => "blob:design-preview");
    URL.revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a stable placeholder and replaces it with an authenticated Blob preview", async () => {
    const api = {
      getAppState: () => ({
        zoom: { value: 1 },
        scrollX: 0,
        scrollY: 0,
        width: 1000,
        height: 800,
      }),
      getSceneElements: () => [
        {
          id: "design-element",
          x: 10,
          y: 20,
          width: 320,
          height: 240,
          customData: metadata,
        },
      ],
      onChange: () => vi.fn(),
      onScrollChange: () => vi.fn(),
    };
    const normalize = vi.fn();
    const { unmount } = render(
      <DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} onNormalizeNode={normalize} />,
    );

    expect(screen.getByText("设计画板")).toBeInTheDocument();
    expect(screen.queryByTestId("design-node-outline")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector("img")).toHaveAttribute(
        "src",
        "blob:design-preview",
      ),
    );
    expect(fetchAssetBlob).toHaveBeenCalledWith(
      "token",
      metadata.previewAssetObjectId,
      expect.objectContaining({ preview: true }),
    );
    const image = document.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 400 });
    Object.defineProperty(image, "naturalHeight", { value: 800 });
    fireEvent.load(image);
    expect(normalize).toHaveBeenCalledWith("design-element", 0.5);
    expect(screen.getByText("画板 · 10000000").parentElement).toHaveAttribute("title", `画板 ID：${metadata.designId}`);
    expect(screen.getByTestId("design-node-preview")).not.toHaveClass("bg-card");
    expect(screen.queryByTestId("design-node-outline")).not.toBeInTheDocument();
    expect(screen.getByTestId("design-node-preview")).not.toHaveClass("border");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:design-preview");
  });

  it.each([0.2, 1, 2])("matches native bounds at zoom %s without drawing a second outline", (zoom) => {
    const api = {
      getAppState: () => ({ zoom: { value: zoom }, width: 1000, height: 800, selectedElementIds: {} }),
      getSceneElements: () => [{ id: "empty", x: 10, y: 20, width: 320, height: 240,
        customData: { ...metadata, previewAssetObjectId: null, previewRevision: 0 } }],
    };
    render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />);
    expect(screen.getByTestId("design-node-preview")).toHaveStyle({ width: `${320 * zoom}px`, height: `${240 * zoom}px` });
    expect(screen.queryByTestId("design-node-outline")).not.toBeInTheDocument();
    expect(fetchAssetBlob).not.toHaveBeenCalled();
  });

  it("catches up live geometry without onChange and uses Excalidraw radians", async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const element = { id: 'moving', x: 10, y: 20, width: 320, height: 240, angle: Math.PI / 2,
      customData: { ...metadata, previewAssetObjectId: null, previewRevision: 0 } };
    const state = { zoom: { value: 1 }, scrollX: 0, scrollY: 0 };
    const api = { getAppState: () => state, getSceneElements: () => [element] };
    try {
      render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByTestId('design-node-preview')).toHaveStyle({ transform: `rotate(${Math.PI / 2}rad)` });
      element.x = 110;
      fireEvent.pointerMove(window);
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByTestId('design-node-preview')).toHaveStyle({ left: '110px' });
      state.zoom.value = 0.5; state.scrollX = -10;
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(screen.getByTestId('design-node-preview')).toHaveStyle({ left: '50px', width: '160px' });
      expect(screen.getByTestId('design-node-placeholder')).toHaveStyle({ transform: 'scale(0.6)' });
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it.each([
    { width: 320, height: 240, zoom: 1, scale: 1 },
    { width: 320, height: 240, zoom: 0.2, scale: 0.24 },
    { width: 20, height: 240, zoom: 1, scale: 0.1 },
    { width: 320, height: 20, zoom: 1, scale: 0.1 },
    { width: 40, height: 40, zoom: 1, scale: 0.2 },
    { width: 320, height: 240, zoom: 2, scale: 1 },
  ])('fits the non-wrapping hint inside $width x $height at zoom $zoom', ({ width, height, zoom, scale }) => {
    const api = {
      getAppState: () => ({ zoom: { value: zoom }, width: 1000, height: 800 }),
      getSceneElements: () => [{ id: 'empty', x: 0, y: 0, width, height,
        customData: { ...metadata, revision: 0, previewAssetObjectId: null, previewRevision: 0 } }],
    };
    render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />);
    const hint = screen.getByTestId('design-node-placeholder');
    expect(hint).toHaveStyle({ transform: `scale(${scale})`, transformOrigin: 'center' });
    expect(hint).toHaveClass('whitespace-nowrap', 'shrink-0');
    expect(screen.getByText('双击打开编辑')).toBeInTheDocument();
    expect(160 * scale).toBeLessThanOrEqual(width * zoom);
    expect(80 * scale).toBeLessThanOrEqual(height * zoom);
  });

  it("labels an outdated bitmap and does not crop it or round its corners", async () => {
    const api = {
      getAppState: () => ({ zoom: { value: 1 }, width: 1000, height: 800 }),
      getSceneElements: () => [{ id: "stale", x: 0, y: 0, width: 658, height: 172,
        customData: { ...metadata, revision: 20, previewRevision: 10 } }],
    };
    render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />);
    await waitFor(() => expect(document.querySelector("img")).toBeInTheDocument());
    expect(screen.getByText("预览待更新")).toBeInTheDocument();
    expect(document.querySelector("img")).toHaveClass("object-contain");
    expect(screen.getByTestId("design-node-preview")).not.toHaveClass("rounded-xl");
  });
  it('loads the authoritative preview without any Excalidraw change event', async () => {
    const latest = '20000000-0000-4000-8000-000000000062';
    getDesign.mockResolvedValue({ revision: 62, preview_revision: 62, preview_asset_object_id: latest });
    const api = { getAppState: () => ({ width: 1000, height: 800 }),
      getSceneElements: () => [{ id: 'old-node', x: 0, y: 0, width: 320, height: 240, customData: metadata }] };
    render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />);
    await waitFor(() => expect(fetchAssetBlob).toHaveBeenCalledWith('token', latest, expect.objectContaining({ preview: true })));
    expect(api.getSceneElements()[0]!.customData.previewRevision).toBe(2);
  });
  it('refreshes after finishing and on focus with a stable canvas snapshot', async () => {
    getDesign.mockResolvedValue({ revision: 2, preview_revision: 2, preview_asset_object_id: metadata.previewAssetObjectId });
    const api = { getAppState: () => ({ width: 1000, height: 800 }),
      getSceneElements: () => [{ id: 'old-node', x: 0, y: 0, width: 320, height: 240, customData: metadata }] };
    render(<DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />);
    await waitFor(() => expect(getDesign).toHaveBeenCalledOnce());
    const latest = '20000000-0000-4000-8000-000000000003';
    getDesign.mockResolvedValue({ revision: 3, preview_revision: 3, preview_asset_object_id: latest });
    fireEvent(window, new Event('loomic:design-preview-refresh'));
    await waitFor(() => expect(fetchAssetBlob).toHaveBeenCalledWith('token', latest, expect.objectContaining({ preview: true })));
    const before = getDesign.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(getDesign.mock.calls.length).toBeGreaterThan(before));
  });
});
