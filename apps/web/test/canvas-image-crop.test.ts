// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getImageCropResolution,
  mapNormalizedImageRegion,
  renderImageCrop,
  resizeImageCrop,
  setImageNaturalSize,
} from "../src/lib/canvas-image-crop";

const image = {
  x: 100,
  y: 50,
  width: 400,
  height: 400,
  version: 1,
  crop: null,
  customData: { originalWidth: 1000, originalHeight: 1000 },
};

describe("canvas image crop resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports source-pixel dimensions", () => {
    expect(getImageCropResolution(image)).toEqual({ width: 1000, height: 1000 });
    expect(getImageCropResolution({
      ...image,
      crop: { x: 100, y: 200, width: 600, height: 500, naturalWidth: 1000, naturalHeight: 1000 },
    })).toEqual({ width: 600, height: 500 });
  });

  it("uses decoded intrinsic dimensions instead of canvas display dimensions", () => {
    const displayedAtSixHundred = {
      ...image,
      width: 600,
      height: 600,
      customData: {},
    };

    expect(getImageCropResolution(
      setImageNaturalSize(displayedAtSixHundred, { width: 2048, height: 1024 }),
    )).toEqual({ width: 2048, height: 1024 });
  });

  it("resizes the crop around the image centre using source pixels", () => {
    expect(resizeImageCrop(image, { width: 500, height: 600 })).toMatchObject({
      x: 200,
      y: 130,
      width: 200,
      height: 240,
      version: 2,
      crop: {
        x: 250,
        y: 200,
        width: 500,
        height: 600,
        naturalWidth: 1000,
        naturalHeight: 1000,
      },
    });
  });

  it("clamps typed dimensions to the source image", () => {
    expect(getImageCropResolution(resizeImageCrop(image, { width: 5000, height: 5000 })))
      .toEqual({ width: 1000, height: 1000 });
  });

  it("maps a box selection to source pixels", () => {
    expect(mapNormalizedImageRegion(image, {
      x: 0.25,
      y: 0.1,
      width: 0.5,
      height: 0.6,
    })).toEqual({ x: 250, y: 100, width: 500, height: 600 });
  });

  it("maps a box selection inside an existing crop", () => {
    expect(mapNormalizedImageRegion({
      ...image,
      crop: { x: 100, y: 200, width: 600, height: 500, naturalWidth: 1000, naturalHeight: 1000 },
    }, {
      x: 0.5,
      y: 0.2,
      width: 0.5,
      height: 0.8,
    })).toEqual({ x: 400, y: 300, width: 300, height: 400 });
  });

  it("renders the crop into a new image file at the cropped pixel size", async () => {
    const drawImage = vi.fn();
    const outputCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => "data:image/png;base64,cropped",
    };
    vi.spyOn(document, "createElement").mockReturnValue(outputCanvas as unknown as HTMLCanvasElement);
    vi.stubGlobal("Image", class {
      crossOrigin = "";
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });

    const result = await renderImageCrop("data:image/png;base64,source", {
      ...image,
      crop: { x: 100, y: 200, width: 600, height: 500, naturalWidth: 1000, naturalHeight: 1000 },
    }, { width: 600, height: 500 });

    expect(result).toEqual({
      dataURL: "data:image/png;base64,cropped",
      mimeType: "image/png",
      width: 600,
      height: 500,
    });
    expect(outputCanvas).toMatchObject({ width: 600, height: 500 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 200, 600, 500, 0, 0, 600, 500);
  });
});
