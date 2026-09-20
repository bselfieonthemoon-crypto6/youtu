import {
  composeTargetSizeRaster,
  evaluateExportDimensionReceipt,
  type ExportDimensionReceipt,
  type PixelSize,
} from "../../agent/nonstandard-export-deliverable.js";

/**
 * The exact-size delivery chain, server side.
 *
 * The composition + byte-read-back primitive in
 * `agent/nonstandard-export-deliverable.ts` is only a capability until a real
 * export calls it. This module is the call site, and it is deliberately small:
 *
 *   1. the CALLER renders the frozen scene into a legal-ratio content raster of
 *      its own size (no target-size knowledge, no padding);
 *   2. {@link verifiedDesignExportArtifact} composes that raster onto the exact
 *      target frame — uniform scale, letterbox/pad, never stretch, never crop —
 *      and then READS THE ENCODED BYTES BACK;
 *   3. the returned receipt is the only place the export size may come from, so
 *      a caller can no longer echo its own budget as the delivered pixels.
 *
 * It is not a second pipeline: the renderer keeps one SVG scene pass and the
 * composition runs on its output, so no design object is drawn twice.
 */

export type VerifiedDesignExportInput = {
  /** The exact frame this export must deliver, in pixels. */
  target: PixelSize;
  /**
   * The scene rendered at its own (legal-ratio) size by the caller. ② is never
   * the answer to ④, and this function does not assume the two agree.
   */
  content: Buffer | Uint8Array;
  /** The export request's own format, judged against the delivered bytes. */
  format: "png" | "jpeg";
  /** The export request's own transparency promise, judged against the delivered bytes. */
  transparent: boolean;
  /**
   * A size someone else asserts for the artifact — the multiplier budget the
   * export path used to report unchecked. It is compared and reported, never
   * trusted, and its disagreement is what makes the old bug visible.
   */
  claim?: PixelSize | null;
  /**
   * The colour the letterbox padding is filled with when the composition has to
   * pad at all. `"transparent"` for a transparency promise; otherwise the
   * scene's own canvas colour, so an opaque design is not framed in a colour it
   * never chose. Defaults to white when the design has no solid background.
   */
  padding?: string;
  /** For jpeg only: the colour the composed alpha is flattened onto. */
  background?: string;
};

export type VerifiedDesignExportArtifact = {
  /** The exact encoded deliverable; its own header is the only source of the size below. */
  buffer: Buffer;
  /** The delivery-card receipt, evaluated from `buffer`. */
  receipt: ExportDimensionReceipt;
};

/**
 * Compose one rendered scene raster into the exact target frame and verify the
 * bytes that will be stored.
 */
export async function verifiedDesignExportArtifact(
  input: VerifiedDesignExportInput,
): Promise<VerifiedDesignExportArtifact> {
  const composed = await composeTargetSizeRaster({
    sources: [input.content],
    target: input.target,
    format: input.format,
    // The transparency promise is carried in the padding too: a letterboxed
    // export that promised transparency must not pad with an opaque colour, and
    // an opaque export pads with the design's own background rather than white.
    padding: input.padding ?? (input.transparent ? "transparent" : "#ffffff"),
    scale: "contain",
    ...(input.background ? { background: input.background } : {}),
  });
  const receipt = await evaluateExportDimensionReceipt({
    target: input.target,
    claim: input.claim ?? null,
    bytes: composed.buffer,
    expectation: { format: input.format, transparent: input.transparent },
  });
  return { buffer: composed.buffer, receipt };
}

/**
 * The receipt for an artifact that was NOT re-encoded on this pass (the durable
 * replay path, where the stored asset is reused). It is built from the bytes
 * that are actually being handed back, so a replayed delivery is verified the
 * same way a fresh one is instead of inheriting the first run's claim.
 */
export async function reverifiedDesignExportReceipt(input: {
  target: PixelSize;
  bytes: Buffer | Uint8Array;
  format: "png" | "jpeg";
  transparent: boolean;
  /** The exact frame the request named, when it named one; mirrors the fresh path. */
  claim?: PixelSize | null;
}): Promise<ExportDimensionReceipt> {
  return evaluateExportDimensionReceipt({
    target: input.target,
    claim: input.claim ?? null,
    bytes: input.bytes,
    expectation: { format: input.format, transparent: input.transparent },
  });
}
