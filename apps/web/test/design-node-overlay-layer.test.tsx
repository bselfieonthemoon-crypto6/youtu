import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAssetBlob } = vi.hoisted(() => ({ fetchAssetBlob: vi.fn() }));
vi.mock("../src/lib/canvas-elements", () => ({ fetchAssetBlob }));

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
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
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
    const { unmount } = render(
      <DesignNodeOverlayLayer accessToken="token" excalidrawApi={api} />,
    );

    expect(screen.getByText("设计画板")).toBeInTheDocument();
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
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:design-preview");
  });
});
