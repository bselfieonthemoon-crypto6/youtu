import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  composeLocalRepaint,
  localRepaintRequest,
  prepareLocalRepaint,
} from "./local-repaint.js";

describe("local repaint mask composition", () => {
  it("derives the provider background mode from actual source alpha pixels", async () => {
    const opaqueRgba = Buffer.from([20, 40, 60, 255, 80, 100, 120, 255]);
    const transparentRgba = Buffer.from([20, 40, 60, 255, 80, 100, 120, 254]);
    const mask = await sharp(Buffer.from([255, 0]), {
      raw: { width: 2, height: 1, channels: 1 },
    }).png().toBuffer();

    const [opaque, transparent] = await Promise.all([
      prepareLocalRepaint(
        await sharp(opaqueRgba, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer(),
        mask,
      ),
      prepareLocalRepaint(
        await sharp(transparentRgba, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer(),
        mask,
      ),
    ]);

    expect(opaque.background).toBe("opaque");
    expect(transparent.background).toBe("transparent");
  });

  it("builds a PNG edit request with source, mask, and repaint-preservation instructions", async () => {
    const source = await sharp({
      create: { width: 2, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } },
    }).png().toBuffer();
    const mask = await sharp(Buffer.from([0, 255]), {
      raw: { width: 2, height: 1, channels: 1 },
    }).png().toBuffer();
    const prepared = await prepareLocalRepaint(source, mask);

    const request = localRepaintRequest(prepared, "Replace the selected area with a moon.");

    expect(request).toMatchObject({
      background: "transparent",
      outputFormat: "png",
      inputImages: [`data:image/png;base64,${prepared.sourcePng.toString("base64")}`],
      maskImage: `data:image/png;base64,${prepared.providerMaskPng.toString("base64")}`,
    });
    expect(request.prompt).toContain("Replace the selected area with a moon.");
    expect(request.prompt).toMatch(/mask/i);
    expect(request.prompt).toMatch(/preserv/i);
    expect(request.prompt).toMatch(/transparent/i);
  });

  it("keeps every unpainted source pixel and the original dimensions", async () => {
    const sourceRaw = Buffer.from([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128, 100, 110, 120, 255,
    ]);
    const source = await sharp(sourceRaw, {
      raw: { width: 2, height: 2, channels: 4 },
    })
      .png()
      .toBuffer();
    // Browser canvas.toDataURL("image/png") produces RGBA even though the
    // visible repaint mask itself is black/white.
    const mask = await sharp(
      Buffer.from([
        0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255,
      ]),
      {
        raw: { width: 2, height: 2, channels: 4 },
      },
    )
      .png()
      .toBuffer();
    const generated = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { r: 200, g: 210, b: 220, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const prepared = await prepareLocalRepaint(source, mask);
    const providerMask = await sharp(prepared.providerMaskPng)
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect([...providerMask.filter((_, index) => index % 4 === 3)]).toEqual([
      255, 0, 255, 127,
    ]);

    const output = await composeLocalRepaint(prepared, generated);
    expect(await sharp(output).metadata()).toMatchObject({
      width: 2,
      height: 2,
    });
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
    expect([...pixels.subarray(0, 4)]).toEqual([...sourceRaw.subarray(0, 4)]);
    expect([...pixels.subarray(8, 12)]).toEqual([...sourceRaw.subarray(8, 12)]);
    expect([...pixels.subarray(4, 8)]).toEqual([200, 210, 220, 255]);
  });

  it("refuses a provider frame whose shape would have to be stretched", async () => {
    const source = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const mask = await sharp(Buffer.alloc(16, 255), {
      raw: { width: 4, height: 4, channels: 1 },
    })
      .png()
      .toBuffer();
    const prepared = await prepareLocalRepaint(source, mask);
    // 3:2 for a 1:1 source: neither fill nor contain can splice this without
    // distortion, so the compose must refuse instead of silently warping it.
    const wider = await sharp({
      create: { width: 6, height: 4, channels: 4, background: { r: 200, g: 210, b: 220, alpha: 1 } },
    })
      .png()
      .toBuffer();

    await expect(composeLocalRepaint(prepared, wider)).rejects.toMatchObject({
      code: "local_repaint_geometry_mismatch",
    });
    // Shape differences at the pipeline's own scale still compose: the native size
    // resolver snaps a ratio onto a 16px grid with up to 1% error (a real 900x1200
    // repaint came back as 880x1184, 0.90%), and that is an invisible resample.
    for (const [width, height] of [[200, 199], [101, 100]] as const) {
      const nearSquare = await sharp({
        create: { width, height, channels: 4, background: { r: 200, g: 210, b: 220, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const output = await composeLocalRepaint(prepared, nearSquare);
      expect(await sharp(output).metadata()).toMatchObject({ width: 4, height: 4 });
    }
    // Beyond that bound the patch could only be delivered distorted.
    const visiblyWider = await sharp({
      create: { width: 104, height: 100, channels: 4, background: { r: 200, g: 210, b: 220, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await expect(composeLocalRepaint(prepared, visiblyWider)).rejects.toMatchObject({
      code: "local_repaint_geometry_mismatch",
    });
  });

  it("rejects an empty or differently sized mask", async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "white" },
    })
      .png()
      .toBuffer();
    const empty = await sharp(Buffer.alloc(4), {
      raw: { width: 2, height: 2, channels: 1 },
    })
      .png()
      .toBuffer();
    const wrongSize = await sharp(Buffer.alloc(6, 255), {
      raw: { width: 3, height: 2, channels: 1 },
    })
      .png()
      .toBuffer();
    await expect(prepareLocalRepaint(source, empty)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(prepareLocalRepaint(source, wrongSize)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("premultiplies partially transparent pixels at the mask boundary to avoid dark fringes", async () => {
    const source = await sharp(Buffer.from([200, 100, 50, 128]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).png().toBuffer();
    const mask = await sharp(Buffer.from([128]), {
      raw: { width: 1, height: 1, channels: 1 },
    }).png().toBuffer();
    const generated = await sharp(Buffer.from([0, 220, 0, 0]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).png().toBuffer();

    const output = await composeLocalRepaint(
      await prepareLocalRepaint(source, mask),
      generated,
    );
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();

    expect([...pixels]).toEqual([200, 100, 50, 64]);
  });

  it("flattens generated transparency onto an opaque source rather than black", async () => {
    const source = await sharp(Buffer.from([100, 150, 200, 255]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).png().toBuffer();
    const mask = await sharp(Buffer.from([255]), {
      raw: { width: 1, height: 1, channels: 1 },
    }).png().toBuffer();
    const generated = await sharp(Buffer.from([0, 220, 0, 0]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).png().toBuffer();

    const output = await composeLocalRepaint(
      await prepareLocalRepaint(source, mask),
      generated,
    );
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();

    expect([...pixels]).toEqual([100, 150, 200, 255]);
  });
});
