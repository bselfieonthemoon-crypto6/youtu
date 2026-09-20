import { describe, expect, it } from "vitest";

import {
  CANVAS_FRAME_AUTHORITY,
  EXPORT_SIZE_AUTHORITY,
  JOB_RECEIPT_SIZE_NOTE,
  projectDesignExportDimensions,
  projectImageJobDimensions,
} from "./export-dimension-contract.js";

const GENERATION_RESULT = { asset_id: "70000000-0000-4000-8000-000000000001",
  width: 880, height: 1_184, canvas_element_id: "000fba30-7066-4b11-a1c0-a6af26b3ad6b" };
const EXPORT_RESULT = { asset_object_id: "70000000-0000-4000-8000-000000000002",
  design_id: "30000000-0000-4000-8000-000000000003", revision: 4, format: "png",
  width: 2_160, height: 2_160, byte_size: 512_000, expires_at: "2026-09-20T00:00:00.000Z" };

describe("image job dimension contract", () => {
  it("states the requested frame, the source pixels and the canvas join without conflating them", () => {
    const projection = projectImageJobDimensions({
      canvas_id: "40000000-0000-4000-8000-000000000004",
      design_id: "30000000-0000-4000-8000-000000000003",
      requestedAspectRatio: "3:4", resolution: "2k", result: GENERATION_RESULT,
    });
    expect(projection).toMatchObject({
      requestedFrame: { aspectRatio: "3:4", resolution: "2k" },
      sourcePixelWidth: 880, sourcePixelHeight: 1_184,
      canvasElementId: "000fba30-7066-4b11-a1c0-a6af26b3ad6b",
      canvasId: "40000000-0000-4000-8000-000000000004",
      designId: "30000000-0000-4000-8000-000000000003",
      exportSize: null,
      hasSourcePixels: true, canvasElementIdKnown: true,
    });
    // The 381x512 display frame is NOT on this projection at all: the canvas
    // observation owns ③, and the receipt can only name the element.
    expect(projection).not.toHaveProperty("width");
    expect(projection).not.toHaveProperty("height");
    // ④ is present-and-null rather than omitted, so "unknown" cannot be read as
    // "not applicable" and filled with ② or ③.
    expect("exportSize" in projection).toBe(true);
    expect(projection.exportSize).toBeNull();
  });

  it("names all four sizes on the receipt note and points each at its own source of truth", () => {
    for (const key of ["image_requested_frame", "image_source_pixels", "image_canvas_frame", "image_export_size"])
      expect(JOB_RECEIPT_SIZE_NOTE).toContain(key);
    expect(JOB_RECEIPT_SIZE_NOTE).toContain("not pixels");
    expect(JOB_RECEIPT_SIZE_NOTE).toContain("never the image's pixels");
    expect(JOB_RECEIPT_SIZE_NOTE).toContain("not produced by this job");
    expect(EXPORT_SIZE_AUTHORITY).toContain("design_export job's own result");
    expect(EXPORT_SIZE_AUTHORITY).toContain("may be substituted");
    expect(CANVAS_FRAME_AUTHORITY).toContain("never evidence of an image's real pixels");
  });

  it("reports unknown rather than substituting a number when the row carries no output", () => {
    const running = projectImageJobDimensions({ requestedAspectRatio: "1:1", resolution: "1k", result: null });
    expect(running).toMatchObject({ hasSourcePixels: false, canvasElementIdKnown: false, exportSize: null,
      requestedFrame: { aspectRatio: "1:1", resolution: "1k" } });
    expect(running).not.toHaveProperty("sourcePixelWidth");
    expect(running).not.toHaveProperty("canvasElementId");

    // A non-positive or non-numeric provider size is not a size: a 0x0 result
    // must not be published as the image's pixels just because keys exist.
    for (const bad of [{ width: 0, height: 0 }, { width: -1, height: 100 }, { width: "880", height: 1184 }]) {
      const projection = projectImageJobDimensions({ result: bad });
      expect(projection.hasSourcePixels).toBe(false);
      expect(projection).not.toHaveProperty("sourcePixelWidth");
    }
    // Half a size is not a size either.
    expect(projectImageJobDimensions({ result: { width: 880 } })).not.toHaveProperty("sourcePixelHeight");
  });

  it("reads the export size only from a validated design_export result, never from a generation result", () => {
    expect(projectDesignExportDimensions(EXPORT_RESULT)).toEqual({
      source: "design_export_result", width: 2_160, height: 2_160, format: "png",
      designId: "30000000-0000-4000-8000-000000000003", revision: 4,
    });
    // The negative assertions: a generation result has no export shape, and a
    // malformed export result is not a size source either.
    expect(projectDesignExportDimensions(GENERATION_RESULT)).toBeNull();
    expect(projectDesignExportDimensions({ ...EXPORT_RESULT, width: 0 })).toBeNull();
    expect(projectDesignExportDimensions({ ...EXPORT_RESULT, format: "webp" })).toBeNull();
    expect(projectDesignExportDimensions(null)).toBeNull();
    // The export's own numbers are the export's, not the image's: nothing here
    // can make 2160 the source pixels of the 880x1184 generation.
    const generation = projectImageJobDimensions({ requestedAspectRatio: "1:1", result: GENERATION_RESULT });
    expect(generation.sourcePixelWidth).toBe(880);
    expect(projectDesignExportDimensions(EXPORT_RESULT)!.width).not.toBe(generation.sourcePixelWidth);
  });
});
