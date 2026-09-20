import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { verifyEncodedImageBytes } from "../../agent/nonstandard-export-deliverable.js";
import {
  reverifiedDesignExportReceipt,
  verifiedDesignExportArtifact,
} from "./design-export-receipt.js";

/** A rendered content raster at its OWN ratio (a legal native source, e.g. 3:1). */
const content = (width: number, height: number, alpha = 1) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 12, g: 120, b: 220, alpha } },
  })
    .png()
    .toBuffer();

describe("verifiedDesignExportArtifact", () => {
  it("delivers the exact 320x70 frame and reads the size back out of the encoded bytes", async () => {
    const artifact = await verifiedDesignExportArtifact({
      target: { width: 320, height: 70 },
      content: await content(1280, 416),
      format: "png",
      transparent: true,
    });

    // The receipt is the ONLY statement of the delivered size in this module:
    // it was parsed from the PNG's own IHDR and cross-checked by a second decode.
    expect(artifact.receipt.actualExportSize).toEqual({ width: 320, height: 70 });
    expect(artifact.receipt).toMatchObject({
      targetSize: { width: 320, height: 70 },
      format: "png",
      matches: true,
      mismatches: [],
      pixelVerification: {
        source: "encoded_bytes",
        actualSize: { width: 320, height: 70 },
        headerSize: { width: 320, height: 70 },
        decodedSize: { width: 320, height: 70 },
      },
    });
    // The same bytes the caller stores report the same size to an independent
    // reader, which is what makes the receipt a claim about the artifact rather
    // than a claim about this function.
    await expect(verifyEncodedImageBytes(artifact.buffer)).resolves.toMatchObject({
      format: "png",
      width: 320,
      height: 70,
    });
    expect(artifact.receipt.pixelVerification?.actualSize).toEqual(
      { width: 320, height: 70 },
    );
  });

  it("never reports the frame the caller asked for when the encoded bytes disagree", async () => {
    // The exact bug this wiring exists to kill: the export path used to publish
    // its own budget (canvas x multiplier) as the delivered size. Here the
    // receipt is asked about an artifact whose real frame is NOT the target, and
    // it follows the bytes.
    const artifact = await verifiedDesignExportArtifact({
      target: { width: 320, height: 70 },
      content: await content(1280, 416),
      format: "png",
      transparent: true,
    });
    const wrongTarget = await reverifiedDesignExportReceipt({
      target: { width: 640, height: 140 },
      bytes: artifact.buffer,
      format: "png",
      transparent: true,
    });
    expect(wrongTarget.actualExportSize).toEqual({ width: 320, height: 70 });
    expect(wrongTarget.matches).toBe(false);
    expect(wrongTarget.mismatches).toContain("size");

    // A caller that DOES assert a size gets that assertion compared against the
    // bytes rather than repeated: the old budget echo would have said 640x140.
    const claimed = await verifiedDesignExportArtifact({
      target: { width: 320, height: 70 },
      content: await content(1280, 416),
      format: "png",
      transparent: true,
      claim: { width: 640, height: 140 },
    });
    expect(claimed.receipt.claimedSize).toEqual({ width: 640, height: 140 });
    expect(claimed.receipt.actualExportSize).toEqual({ width: 320, height: 70 });
    expect(claimed.receipt.mismatches).toContain("size");
    expect(claimed.receipt.matches).toBe(false);
  });

  it("judges the format the request named against the format the bytes actually are", async () => {
    const jpeg = await verifiedDesignExportArtifact({
      target: { width: 320, height: 70 },
      content: await content(1280, 416),
      format: "jpeg",
      transparent: false,
    });
    expect(jpeg.receipt.format).toBe("jpeg");
    expect(jpeg.receipt.hasAlpha).toBe(false);
    expect(jpeg.receipt.matches).toBe(true);
    expect(jpeg.receipt.mismatches).toEqual([]);
  });

  it("judges a transparent request against the real transparency of the delivered pixels", async () => {
    // transparent: true and a transparent letterbox: the bytes really do carry a
    // non-opaque sample, so the promise is kept and the card says "present".
    const kept = await verifiedDesignExportArtifact({
      target: { width: 320, height: 70 },
      content: await content(1280, 416),
      format: "png",
      transparent: true,
    });
    expect(kept.receipt.alphaVerdict).toBe("present");
    expect(kept.receipt.hasAlpha).toBe(true);
    expect(kept.receipt.mismatches).not.toContain("alpha");

    // The judgment is about the pixels, not the request: an artifact that carries
    // an alpha channel whose every sample is opaque (alpha 1.0 content on an
    // opaque canvas) cannot satisfy `transparent: true`.
    const opaquePixels = await sharp({
      create: { width: 320, height: 70, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const failed = await reverifiedDesignExportReceipt({
      target: { width: 320, height: 70 },
      bytes: opaquePixels,
      format: "png",
      transparent: true,
    });
    expect(failed.alphaVerdict).toBe("opaque");
    expect(failed.hasAlpha).toBe(false);
    expect(failed.mismatches).toContain("alpha");
    expect(failed.matches).toBe(false);
    // The same bytes satisfy a request that never promised transparency.
    const notPromised = await reverifiedDesignExportReceipt({
      target: { width: 320, height: 70 },
      bytes: opaquePixels,
      format: "png",
      transparent: false,
    });
    expect(notPromised.matches).toBe(true);
    expect(notPromised.mismatches).toEqual([]);
  });

  it("reports an honest unverified receipt when the stored bytes cannot be read", async () => {
    await expect(
      verifiedDesignExportArtifact({
        target: { width: 320, height: 70 },
        content: Buffer.alloc(0),
        format: "png",
        transparent: true,
      }),
    ).rejects.toThrow(/nonstandard_export_no_source/);
  });

  it("keeps the no-request-size path producing exactly the frame it always produced", async () => {
    // No target was named: the caller passes the frame it would have produced
    // anyway (canvas x multiplier). Behaviour is unchanged — only the evidence is.
    const artifact = await verifiedDesignExportArtifact({
      target: { width: 640, height: 360 },
      content: await content(640, 360),
      format: "png",
      transparent: false,
    });
    expect(artifact.receipt.actualExportSize).toEqual({ width: 640, height: 360 });
    expect(artifact.receipt.matches).toBe(true);
    await expect(verifyEncodedImageBytes(artifact.buffer)).resolves.toMatchObject({
      width: 640,
      height: 360,
    });
  });
});

describe("reverifiedDesignExportReceipt", () => {
  it("re-verifies a replayed artifact from its stored bytes instead of inheriting a claim", async () => {
    const artifact = await verifiedDesignExportArtifact({
      target: { width: 320, height: 70 },
      content: await content(1280, 416),
      format: "png",
      transparent: true,
    });
    const replayed = await reverifiedDesignExportReceipt({
      target: { width: 320, height: 70 },
      bytes: artifact.buffer,
      format: "png",
      transparent: true,
    });
    expect(replayed.actualExportSize).toEqual({ width: 320, height: 70 });
    expect(replayed.matches).toBe(true);

    // The replay path must not be a way to publish an unverified size: bytes that
    // are not a readable deliverable produce no receipt at all.
    await expect(
      reverifiedDesignExportReceipt({
        target: { width: 320, height: 70 },
        bytes: Buffer.from("not an image"),
        format: "png",
        transparent: true,
      }),
    ).rejects.toThrow(/nonstandard_export_unknown_format/);
  });

  it("detects a stored artifact whose real frame differs from the requested one", async () => {
    const wrong = await verifiedDesignExportArtifact({
      target: { width: 640, height: 140 },
      content: await content(1280, 416),
      format: "png",
      transparent: true,
    });
    const replayed = await reverifiedDesignExportReceipt({
      target: { width: 320, height: 70 },
      bytes: wrong.buffer,
      format: "png",
      transparent: true,
    });
    expect(replayed.actualExportSize).toEqual({ width: 640, height: 140 });
    expect(replayed.matches).toBe(false);
    expect(replayed.mismatches).toContain("size");
  });
});
