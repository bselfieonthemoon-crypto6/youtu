import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { composeLocalRepaint } from "./local-repaint.js";
import { directOutpaintRequest, composeOutpaint, outpaintRequest, prepareOutpaint } from "./outpaint.js";

async function rgba(buffer: Buffer) {
  return sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe("outpaint preparation and composition", () => {
  it("sends original unpadded pixels and explicit target dimensions without a mask", async () => {
    const source = await sharp({create:{width:800,height:600,channels:4,background:"green"}}).png().toBuffer();
    const request = await directOutpaintRequest(source,{left:100,right:100,top:100,bottom:100},"延伸光带");
    expect(request).toMatchObject({outputWidth:1008,outputHeight:800,aspectRatio:"1008:800"});
    expect(request).not.toHaveProperty("maskImage");
    expect(request.prompt).toContain("延伸光带");
    const input=Buffer.from(request.inputImages[0]!.split(",")[1]!,"base64");
    expect((await rgba(input)).data).toEqual((await rgba(source)).data);
    expect(await sharp(input).metadata()).toMatchObject({width:800,height:600});
  });
  it("blends expanded edges smoothly, preserves the core and does not edit unexpanded edges", async () => {
    const source = await sharp({create:{width:100,height:100,channels:4,background:{r:20,g:20,b:20,alpha:1}}}).png().toBuffer();
    const prepared = await prepareOutpaint(source,{left:20,right:0,top:0,bottom:0});
    const generated = await sharp({create:{width:120,height:100,channels:4,background:{r:220,g:220,b:220,alpha:1}}}).png().toBuffer();
    const output = await rgba(await composeOutpaint(prepared,generated));
    const red = (x:number,y=50)=>output.data[(y*120+x)*4];
    expect(red(19)).toBe(220); expect(red(20)).toBe(220);
    expect(red(24)).toBeGreaterThan(20); expect(red(24)).toBeLessThan(220);
    expect(red(28)).toBe(20); expect(red(119)).toBe(20); expect(red(60,0)).toBe(20);
    for(let x=20;x<28;x++) expect(Math.abs(red(x)!-red(x+1)!)).toBeLessThan(40);
    const mask=await rgba(prepared.providerMaskPng);
    expect(mask.data[(50*120+24)*4+3]).toBe(0);
    expect(mask.data[(50*120+60)*4+3]).toBe(255);
    await expect(composeOutpaint(prepared,source)).rejects.toMatchObject({code:"outpaint_geometry_mismatch"});
  });
  it("places the original at the requested offset and derives the synthetic mask", async () => {
    const sourcePixels = Buffer.from([
      1, 2, 3, 255, 4, 5, 6, 255,
      7, 8, 9, 255, 10, 11, 12, 255,
    ]);
    const source = await sharp(sourcePixels, {
      raw: { width: 2, height: 2, channels: 4 },
    })
      .png()
      .toBuffer();
    const prepared = await prepareOutpaint(source, {
      top: 1,
      right: 2,
      bottom: 1,
      left: 1,
    });

    expect(prepared).toMatchObject({ width: 5, height: 4, background: "opaque" });
    const padded = await rgba(prepared.sourcePng);
    expect([...padded.data.subarray((1 * 5 + 1) * 4, (1 * 5 + 3) * 4)]).toEqual(
      [...sourcePixels.subarray(0, 8)],
    );
    expect([...padded.data.subarray((2 * 5 + 1) * 4, (2 * 5 + 3) * 4)]).toEqual(
      [...sourcePixels.subarray(8, 16)],
    );
    expect(padded.data[3]).toBe(0);

    const providerMask = await rgba(prepared.providerMaskPng);
    const alpha = [...providerMask.data].filter((_, index) => index % 4 === 3);
    expect(alpha).toEqual([
      0, 0, 0, 0, 0,
      0, 255, 255, 0, 0,
      0, 255, 255, 0, 0,
      0, 0, 0, 0, 0,
    ]);
    expect([...prepared.maskPixels]).toEqual(alpha.map((value) => 255 - value));
  });

  it("derives background policy from the original alpha, not transparent padding", async () => {
    const opaque = await sharp(Buffer.from([20, 30, 40, 255]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).png().toBuffer();
    const transparent = await sharp(Buffer.from([20, 30, 40, 254]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).png().toBuffer();
    const margins = { top: 0, right: 1, bottom: 0, left: 0 };

    expect((await prepareOutpaint(opaque, margins)).background).toBe("opaque");
    expect((await prepareOutpaint(transparent, margins)).background).toBe(
      "transparent",
    );
  });

  it("keeps the central original pixels byte-exact while filling outside pixels", async () => {
    const sourcePixels = Buffer.from([
      10, 20, 30, 255, 40, 50, 60, 128,
      70, 80, 90, 255, 100, 110, 120, 255,
    ]);
    const source = await sharp(sourcePixels, {
      raw: { width: 2, height: 2, channels: 4 },
    }).png().toBuffer();
    const prepared = await prepareOutpaint(source, {
      top: 1,
      right: 1,
      bottom: 1,
      left: 2,
    });
    const generated = await sharp({
      create: {
        width: 10,
        height: 8,
        channels: 4,
        background: { r: 200, g: 210, b: 220, alpha: 1 },
      },
    }).png().toBuffer();

    const output = await rgba(
      await composeLocalRepaint(prepared, generated),
    );
    expect(output.info).toMatchObject({ width: 5, height: 4 });
    for (let y = 0; y < 2; y += 1) {
      const outputStart = ((y + 1) * 5 + 2) * 4;
      expect([...output.data.subarray(outputStart, outputStart + 8)]).toEqual(
        [...sourcePixels.subarray(y * 8, y * 8 + 8)],
      );
    }
    expect([...output.data.subarray(0, 4)]).toEqual([200, 210, 220, 255]);
  });

  it("builds a masked edit request that forbids resizing the original subject", async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "white" },
    }).png().toBuffer();
    const prepared = await prepareOutpaint(source, {
      top: 1,
      right: 0,
      bottom: 0,
      left: 0,
    });
    const request = outpaintRequest(prepared, "Continue the cloudy sky.");

    expect(request).toMatchObject({
      background: "opaque",
      outputFormat: "png",
      aspectRatio: "2:3",
      inputImages: [expect.stringMatching(/^data:image\/png;base64,/)],
      maskImage: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(request.prompt).toContain("Continue the cloudy sky.");
    expect(request.prompt).toMatch(/unchanged/i);
    expect(request.prompt).toMatch(/not crop, move, resize, rescale/i);
  });

  it("rejects expanded canvases beyond edge, area, or ratio bounds", async () => {
    const wide = await sharp({
      create: { width: 2_000, height: 1_000, channels: 4, background: "white" },
    }).png().toBuffer();
    const square = await sharp({
      create: { width: 2_880, height: 2_880, channels: 4, background: "white" },
    }).png().toBuffer();

    await expect(
      prepareOutpaint(wide, { top: 0, right: 2_000, bottom: 0, left: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      prepareOutpaint(square, { top: 1, right: 0, bottom: 0, left: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      prepareOutpaint(wide, { top: 0, right: 1_001, bottom: 0, left: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
