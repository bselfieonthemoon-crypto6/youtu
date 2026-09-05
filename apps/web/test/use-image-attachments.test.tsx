// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useImageAttachments } from "../src/hooks/use-image-attachments";

describe("useImageAttachments canvas references", () => {
  it("uses the hydrated canvas image for preview while retaining the durable URL", () => {
    const { result } = renderHook(() => useImageAttachments("token", "project-1"));

    act(() => result.current.addCanvasRef({
      assetId: "asset-1",
      url: "https://storage.example/signed-image.png",
      previewUrl: "data:image/png;base64,already-loaded",
      mimeType: "image/png",
      name: "Logo",
    }));

    expect(result.current.attachments[0]).toMatchObject({
      preview: "data:image/png;base64,already-loaded",
      url: "https://storage.example/signed-image.png",
      uploading: false,
    });
    expect(result.current.readyAttachments[0]?.url).toBe("https://storage.example/signed-image.png");
  });
});
