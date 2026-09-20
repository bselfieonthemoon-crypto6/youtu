import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  composeTargetSizeRaster,
  contentBox,
  describeExportDimensionReceipt,
  evaluateExportDimensionReceipt,
  parseExportDimensionReceipt,
  parseImageHeader,
  sizeFromRatio,
  verifyEncodedImageBytes,
} from "./nonstandard-export-deliverable.js";

/** An opaque source encoded as PNG, at the ratio a provider would return. */
const solidPng = (width: number, height: number, background: { r: number; g: number; b: number } = { r: 0, g: 0, b: 255 }) =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

/** A source with a real transparent region, as a transparent-subject generation would be. */
const transparentPng = (width: number, height: number) => sharp({ create: {
  width, height, channels: 4, background: { r: 12, g: 120, b: 220, alpha: 0.35 },
} }).png().toBuffer();

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

describe("composeTargetSizeRaster", () => {
  it("composes an exact 1200x630 banner from a legal-ratio source without stretching it", async () => {
    // The source is 1920x800 (2.4:1), not the banner's 1.9048:1. A uniform scale
    // to fit inside 1200x630 gives 1200x500; the remaining 130px is letterboxed.
    const composed = await composeTargetSizeRaster({ sources: [await solidPng(1920, 800)],
      target: { width: 1200, height: 630 }, format: "png" });
    expect({ width: composed.width, height: composed.height, format: composed.format })
      .toEqual({ width: 1200, height: 630, format: "png" });
    expect(composed.content).toEqual({ width: 1200, height: 500, scale: 0.625 });
    expect(composed.content.width / composed.content.height).toBeCloseTo(1920 / 800, 6);
    expect(composed.margin).toEqual({ left: 0, right: 0, top: 65, bottom: 65 });
    const verified = await verifyEncodedImageBytes(composed.buffer);
    expect(verified).toMatchObject({ format: "png", width: 1200, height: 630 });
  });

  it("composes the exact 320x70 target from a 3:1 native source with a transparent letterbox", async () => {
    // The nearest legal native ratio for 320:70 (4.571:1) is 3:1, e.g. 1280x416.
    const composed = await composeTargetSizeRaster({ sources: [await transparentPng(1280, 416)],
      target: { width: 320, height: 70 }, format: "png", padding: "transparent" });
    const verified = await verifyEncodedImageBytes(composed.buffer);
    expect({ width: verified.width, height: verified.height, format: verified.format })
      .toEqual({ width: 320, height: 70, format: "png" });
    expect(verified.hasAlphaChannel).toBe(true);
    // The 3:1 source (3.077:1) is narrower than the 4.571:1 target, so it is
    // letterboxed at 215x70; the leftover 105px splits as 52/53 and no axis is
    // squeezed to reach 4.571:1.
    expect(composed.content).toEqual({ width: 215, height: 70, scale: 215 / 1280 });
    expect(composed.content.width / composed.content.height).toBeCloseTo(1280 / 416, 1);    expect(composed.margin.left).toBe(52);
    expect(composed.margin.right).toBe(53);
    expect(composed.margin.left + composed.margin.right).toBe(105);
    expect(composed.margin.top).toBe(0);
    expect(composed.margin.bottom).toBe(0);
  });

  it("letterboxes a 4:3 source inside the extreme 320x70 frame instead of stretching it", async () => {
    const composed = await composeTargetSizeRaster({ sources: [await solidPng(800, 600)],
      target: { width: 320, height: 70 }, format: "png", padding: "#101010" });
    const verified = await verifyEncodedImageBytes(composed.buffer);
    expect({ width: verified.width, height: verified.height, format: verified.format })
      .toEqual({ width: 320, height: 70, format: "png" });
    // A 4:3 source cannot fill a 4.571:1 frame without cropping or stretching: it
    // is letterboxed at 93x70 with equal left/right margins.
    expect(composed.content).toEqual({ width: 93, height: 70, scale: 93 / 800 });
    expect(composed.margin.left).toBe(113);
    expect(composed.margin.right).toBe(114);
    expect(composed.margin.top).toBe(0);
    expect(composed.margin.bottom).toBe(0);
    expect(composed.content.width / composed.content.height).toBeCloseTo(800 / 600, 2);
  });

  it("keeps real transparency when padding and reports an opaque alpha channel as opaque", async () => {
    const transparent = await composeTargetSizeRaster({ sources: [await transparentPng(80, 70)],
      target: { width: 320, height: 70 }, format: "png", padding: "transparent", scale: "fit" });
    const transparentVerified = await verifyEncodedImageBytes(transparent.buffer);
    expect(transparentVerified.alpha).toMatchObject({ channel: true, verdict: "present", realTransparency: true });
    // The transparent padding is real: the composed edges decode to alpha 0.
    expect(transparentVerified.alpha.minAlpha).toBe(0);

    // An opaque source letterboxed on a transparent canvas: the empty margins ARE
    // transparent, so the artifact is reported as transparent, not as "opaque".
    const padded = await composeTargetSizeRaster({ sources: [await solidPng(80, 70)],
      target: { width: 320, height: 70 }, format: "png", padding: "transparent", scale: "fit" });
    const paddedVerified = await verifyEncodedImageBytes(padded.buffer);
    expect(paddedVerified.alpha).toMatchObject({ channel: true, verdict: "present", realTransparency: true });
    expect(paddedVerified.alpha.minAlpha).toBe(0);

    // An opaque artifact with no transparent pixel at all: the encoder keeps an
    // alpha channel, so the card reports "an alpha channel that is entirely
    // opaque" instead of the delivery promise "contains transparency".
    const opaque = await composeTargetSizeRaster({ sources: [await solidPng(320, 70)],
      target: { width: 320, height: 70 }, format: "png", padding: "#ffffff" });
    const opaqueVerified = await verifyEncodedImageBytes(opaque.buffer);
    expect(opaqueVerified.hasAlphaChannel).toBe(true);
    expect(opaqueVerified.alpha).toEqual({ channel: true, verdict: "opaque", minAlpha: 255, realTransparency: false });
  });

  it("never scales beyond the source for scale=fit and never upscales past the target for scale=contain", async () => {
    const fit = await composeTargetSizeRaster({ sources: [await solidPng(40, 20)],
      target: { width: 400, height: 200 }, format: "png", scale: "fit" });
    expect(fit.content).toMatchObject({ width: 40, height: 20, scale: 1 });

    // A source larger than the target is contained, not cropped: at 8:1 against a
    // 4.571:1 target the 4000x500 source shrinks to 320x40 with top/bottom padding.
    const contain = await composeTargetSizeRaster({ sources: [await solidPng(4000, 500)],
      target: { width: 320, height: 70 }, format: "png" });
    expect(contain.content).toEqual({ width: 320, height: 40, scale: 0.08 });
    expect(contain.content.width).toBeLessThanOrEqual(320);
    expect(contain.content.height).toBeLessThanOrEqual(70);
    expect(contain.margin.top).toBe(15);
    expect(contain.margin.bottom).toBe(15);
    expect((await verifyEncodedImageBytes(contain.buffer))).toMatchObject({ width: 320, height: 70 });
  });

  it("rejects a request it cannot honour instead of emitting a stretched or cropped artifact", async () => {
    await expect(composeTargetSizeRaster({ sources: [], target: { width: 320, height: 70 } }))
      .rejects.toThrow(/nonstandard_export_no_source/);
    await expect(composeTargetSizeRaster({ sources: [await solidPng(10, 10)], target: { width: 320.5, height: 70 } }))
      .rejects.toThrow(/nonstandard_export_invalid_target_width/);
    await expect(composeTargetSizeRaster({ sources: [await solidPng(10, 10)],
      target: { width: 320, height: 70 }, format: "webp" as never }))
      .rejects.toThrow(/nonstandard_export_unsupported_format/);
  });

  it("computes the content box as a uniform scale of the source", () => {
    expect(contentBox({ width: 1280, height: 416 }, { width: 320, height: 70 }, "contain"))
      .toEqual({ width: 215, height: 70, scale: 215 / 1280 });
    expect(contentBox({ width: 40, height: 20 }, { width: 400, height: 200 }, "fit"))
      .toEqual({ width: 40, height: 20, scale: 1 });
    expect(contentBox({ width: 40, height: 20 }, { width: 400, height: 200 }, "none"))
      .toEqual({ width: 40, height: 20, scale: 1 });
  });
});

describe("verifyEncodedImageBytes", () => {
  it("reads the pixel size from the encoded artifacts, not from the composition plan next to them", async () => {
    // Compose for 320x70 (that is what the caller asked for), then hand the
    // verifier a DIFFERENT artifact: the reported size must follow the bytes.
    const composed = await composeTargetSizeRaster({ sources: [await solidPng(600, 300)],
      target: { width: 320, height: 70 }, format: "png" });
    const other = await composeTargetSizeRaster({ sources: [await solidPng(600, 300)],
      target: { width: 640, height: 480 }, format: "png" });
    expect({ composed: [composed.width, composed.height], other: [other.width, other.height] })
      .toEqual({ composed: [320, 70], other: [640, 480] });
    await expect(verifyEncodedImageBytes(other.buffer)).resolves.toMatchObject({ width: 640, height: 480 });
    // Same source pixels, different frames: the two encodings differ and the
    // header of each one reports its own frame.
    expect(other.buffer.equals(composed.buffer)).toBe(false);
    expect(await verifyEncodedImageBytes(other.buffer)).toMatchObject({ width: 640, height: 480 });
  });

  it("cross-checks the container header against an independent decode of the same bytes", async () => {
    const composed = await composeTargetSizeRaster({ sources: [await solidPng(64, 64)],
      target: { width: 320, height: 70 }, format: "png" });
    const verified = await verifyEncodedImageBytes(composed.buffer);
    expect(verified.header).toEqual({ width: 320, height: 70 });
    expect(verified.decoded).toMatchObject({ width: 320, height: 70, format: "png" });
    expect(verified.byteSize).toBe(composed.buffer.byteLength);

    // A PNG whose IHDR was rewritten to claim another size must not be published:
    // the header is recomputed structurally (valid CRC) but its claim disagrees
    // with the IDAT pixels, and the decoder refuses it outright.
    const tampered = Buffer.from(composed.buffer);
    tampered.writeUInt32BE(999, 16);
    tampered.writeUInt32BE(crc32(tampered.subarray(12, 29)), 29);
    await expect(verifyEncodedImageBytes(tampered)).rejects.toThrow();
    // The verifier's own header reader still reports the rewritten claim, which is
    // exactly why the claim alone is never the answer.
    expect(parseImageHeader(tampered)).toMatchObject({ width: 999, height: 70 });
    expect(await verifyEncodedImageBytes(composed.buffer)).toMatchObject({ width: 320, height: 70 });
  });

  it("reports jpeg as having no alpha channel at all", async () => {
    const composed = await composeTargetSizeRaster({ sources: [await transparentPng(80, 70)],
      target: { width: 320, height: 70 }, format: "jpeg", background: "#ffffff" });
    const verified = await verifyEncodedImageBytes(composed.buffer);
    expect(verified).toMatchObject({ format: "jpeg", width: 320, height: 70, hasAlphaChannel: false });
    expect(verified.alpha).toEqual({ channel: false, verdict: "absent", minAlpha: null, realTransparency: false });
  });

  it("refuses bytes that are not a verifiable deliverable", async () => {
    await expect(verifyEncodedImageBytes(Buffer.alloc(0))).rejects.toThrow(/nonstandard_export_empty_bytes/);
    await expect(verifyEncodedImageBytes(Buffer.from("not an image at all"))).rejects.toThrow(/nonstandard_export_unknown_format/);
    // A PNG signature with no IHDR chunk first is corrupt, not a 0x0 image.
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16)]);
    await expect(verifyEncodedImageBytes(broken)).rejects.toThrow(/nonstandard_export_header_invalid/);
  });
});

describe("evaluateExportDimensionReceipt", () => {
  const extremeTarget = { width: 320, height: 70 };

  it("reports target, actual, format, alpha and a match for a verified exact-size delivery", async () => {
    const composed = await composeTargetSizeRaster({ sources: [await transparentPng(1280, 416)],
      target: extremeTarget, format: "png", padding: "transparent" });
    const receipt = await evaluateExportDimensionReceipt({ target: extremeTarget, bytes: composed.buffer,
      claim: extremeTarget, approximation: { requestedRatio: "320:70", nativeRatio: "3:1" } });
    expect(receipt).toMatchObject({
      targetSize: { width: 320, height: 70 },
      claimedSize: { width: 320, height: 70 },
      actualExportSize: { width: 320, height: 70 },
      format: "png",
      hasAlpha: true,
      alphaVerdict: "present",
      matches: true,
      mismatches: [],
      approximation: { requestedRatio: "320:70", nativeRatio: "3:1" },
      pixelVerification: { source: "encoded_bytes", actualSize: { width: 320, height: 70 },
        headerSize: { width: 320, height: 70 }, decodedSize: { width: 320, height: 70 } },
    });
    expect(receipt.pixelVerification?.alpha.realTransparency).toBe(true);
    // The extreme target is 4.571:1 against a 3:1 native frame: the deviation is
    // stated instead of being hidden behind "matches: true".
    expect(receipt.approximation?.ratioDeviation).toBeCloseTo(-0.3438, 3);
    expect(describeExportDimensionReceipt(receipt)).toContain("实际导出尺寸 320×70");
    expect(describeExportDimensionReceipt(receipt)).toContain("近似比例 3:1");
  });

  it("DETECTS a claimed size that the exported bytes do not have", async () => {
    // The claim says the provider's 3:1 output was already 320×70 (the exact lie
    // this requirement exists to catch); the bytes say otherwise.
    const composed = await composeTargetSizeRaster({ sources: [await solidPng(1280, 416)],
      target: { width: 640, height: 140 }, format: "png" });
    const receipt = await evaluateExportDimensionReceipt({ target: extremeTarget,
      claim: extremeTarget, bytes: composed.buffer });
    expect(receipt.actualExportSize).toEqual({ width: 640, height: 140 });
    expect(receipt.matches).toBe(false);
    expect(receipt.mismatches).toContain("size");
    expect(receipt.pixelVerification?.actualSize).toEqual({ width: 640, height: 140 });
  });

  it("fails the receipt when nothing was verified, and never substitutes the target", async () => {
    const receipt = await evaluateExportDimensionReceipt({ target: extremeTarget, claim: extremeTarget, bytes: null });
    expect(receipt.actualExportSize).toBeNull();
    expect(receipt.format).toBeNull();
    expect(receipt.hasAlpha).toBeNull();
    expect(receipt.matches).toBe(false);
    expect(receipt.mismatches).toEqual(["unverified"]);
    expect(describeExportDimensionReceipt(receipt)).toContain("未验证");
  });

  it("reads the format and the alpha channel from the bytes, and reports them for the card", async () => {
    const composed = await composeTargetSizeRaster({ sources: [await transparentPng(80, 70)],
      target: extremeTarget, format: "jpeg", background: "#ffffff", scale: "fit" });
    const receipt = await evaluateExportDimensionReceipt({ target: extremeTarget, bytes: composed.buffer });
    // jpeg bytes can never be reported as a transparent png artifact: the format
    // and the alpha verdict come from the deliverable, not from the request.
    expect(receipt).toMatchObject({ format: "jpeg", matches: true, alphaVerdict: "absent", hasAlpha: false });
    expect(receipt.mismatches).toEqual([]);
    expect(receipt.pixelVerification?.format).toBe("jpeg");
    expect(describeExportDimensionReceipt(receipt)).toContain("格式 jpeg");
    expect(describeExportDimensionReceipt(receipt)).toContain("无 alpha 通道");
    // The alpha channel is reported for the card and NOT judged against an
    // unspecified request: a delivered png that happens to be fully opaque still
    // matches the 320x70 frame exactly.
    const opaque = await composeTargetSizeRaster({ sources: [await solidPng(320, 70)],
      target: extremeTarget, format: "png", padding: "#ffffff" });
    const opaqueReceipt = await evaluateExportDimensionReceipt({ target: extremeTarget, bytes: opaque.buffer });
    expect(opaqueReceipt).toMatchObject({ matches: true, alphaVerdict: "opaque", hasAlpha: false });
    expect(describeExportDimensionReceipt(opaqueReceipt)).toContain("有 alpha 通道但全部不透明");
  });

  it("round-trips a receipt across a JSON boundary and refuses a malformed one", async () => {
    const composed = await composeTargetSizeRaster({ sources: [await solidPng(320, 70)],
      target: extremeTarget, format: "png" });
    const receipt = await evaluateExportDimensionReceipt({ target: extremeTarget, bytes: composed.buffer });
    expect(parseExportDimensionReceipt(JSON.stringify(receipt))).toEqual(receipt);
    expect(parseExportDimensionReceipt({ targetSize: { width: 0, height: 0 } })).toBeNull();
    expect(parseExportDimensionReceipt("{not json")).toBeNull();
    expect(parseExportDimensionReceipt(null)).toBeNull();
  });

  it("expresses a ratio string as an integer frame for deviation math", () => {
    expect(sizeFromRatio("3:1")).toEqual({ width: 3000, height: 1000 });
    expect(sizeFromRatio("320：70")).toEqual({ width: 320_000, height: 70_000 });
    expect(() => sizeFromRatio("wide")).toThrow(/nonstandard_export_invalid_ratio/);
  });
});
