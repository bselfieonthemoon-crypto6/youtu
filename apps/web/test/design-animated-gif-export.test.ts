import type { DesignObject, LoomicSceneV1 } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_GIF_MAX_EDGE,
  DESIGN_GIF_MAX_FRAMES,
  buildAnimatedDesignSceneFrame,
  evaluateDesignObjectAnimation,
  exportAnimatedDesignGifInBrowser,
  getAnimatedGifPlan,
} from "../src/lib/design-animated-gif-export";

describe("animated design GIF export", () => {
  it("ignores hidden layers and descendants of hidden groups", () => {
    const visible = objectFixture({ animation: { type: "float", durationMs: 2000, amount: 10 } });
    const hidden = objectFixture({ objectId: "hidden", visible: false, animation: { type: "float", durationMs: 3000, amount: 10 } });
    const child = objectFixture({ objectId: "child", animation: { type: "scale", durationMs: 5000, amount: 10 } });
    const group = { ...objectFixture({ objectId: "group", visible: false }), type: "group", childObjectIds: [child.objectId] } as DesignObject;
    expect(getAnimatedGifPlan(sceneFixture([visible, hidden, group, child])).durationMs).toBe(2000);
    expect(() => getAnimatedGifPlan(sceneFixture([hidden, group, child]))).toThrow("可见对象");
  });
  it("evaluates float and centred scale from the immutable original pose", () => {
    const floating = objectFixture({
      animation: { type: "float", durationMs: 1_000, amount: 12 },
    });
    expect(evaluateDesignObjectAnimation(floating, 250).y).toBeCloseTo(28);
    expect(evaluateDesignObjectAnimation(floating, 750).y).toBeCloseTo(52);
    expect(floating.y).toBe(40);

    const scaling = objectFixture({
      animation: { type: "scale", durationMs: 1_000, amount: 20 },
    });
    const peak = evaluateDesignObjectAnimation(scaling, 500);
    expect(peak).toMatchObject({ x: 0, y: 35, width: 120, height: 60 });
    expect(scaling).toMatchObject({ x: 10, y: 40, width: 100, height: 50 });
    const rising = evaluateDesignObjectAnimation(scaling, 250);
    expect(rising.x).toBeCloseTo(5);
    expect(rising.y).toBeCloseTo(37.5);
    expect(rising.width).toBeCloseTo(110);
    expect(rising.height).toBeCloseTo(55);
  });

  it("builds every frame from the source scene rather than accumulating transforms", () => {
    const source = sceneFixture([
      objectFixture({
        animation: { type: "float", durationMs: 1_000, amount: 10 },
      }),
    ]);
    const quarter = buildAnimatedDesignSceneFrame(source, 250);
    const threeQuarter = buildAnimatedDesignSceneFrame(source, 750);
    expect(quarter.objects[0]?.y).toBeCloseTo(30);
    expect(threeQuarter.objects[0]?.y).toBeCloseTo(50);
    expect(source.objects[0]?.y).toBe(40);
  });

  it("downscales visibly bounded output and caps long animations at 60 frames", () => {
    const scene = sceneFixture(
      [
        objectFixture({
          animation: { type: "scale", durationMs: 10_000, amount: 25 },
        }),
      ],
      { width: 4_000, height: 2_000 },
    );
    expect(getAnimatedGifPlan(scene)).toEqual({
      width: DESIGN_GIF_MAX_EDGE,
      height: DESIGN_GIF_MAX_EDGE / 2,
      frameCount: DESIGN_GIF_MAX_FRAMES,
      frameDelayMs: 167,
      durationMs: 10_000,
    });
  });

  it("uses a common loop period when it fits inside the duration cap", () => {
    const scene = sceneFixture([
      objectFixture({
        animation: { type: "float", durationMs: 2_000, amount: 10 },
      }),
      objectFixture({
        objectId: "22222222-2222-4222-8222-222222222222",
        animation: { type: "scale", durationMs: 3_000, amount: 10 },
      }),
    ]);
    expect(getAnimatedGifPlan(scene).durationMs).toBe(6_000);
  });

  it("encodes and downloads a real multi-frame GIF", async () => {
    const scene = sceneFixture([
      objectFixture({
        animation: { type: "float", durationMs: 500, amount: 10 },
      }),
    ]);
    const renderedScenes: LoomicSceneV1[] = [];
    let downloadedBlob: Blob | undefined;
    let encodedBytes: Uint8Array | undefined;
    const clickDownload = vi.fn();
    const result = await exportAnimatedDesignGifInBrowser(
      { name: "动效/海报", scene },
      {
        waitForFonts: vi.fn(async () => undefined),
        waitForImages: vi.fn(async () => ({ missingAssetObjectIds: [] })),
        renderFrame: vi.fn(async (frameScene, size) => {
          renderedScenes.push(frameScene);
          return {
            width: size.width,
            height: size.height,
            data: new Uint8ClampedArray(size.width * size.height * 4).fill(
              255,
            ),
          } as ImageData;
        }),
      },
      {
        createObjectURL: (blob) => {
          downloadedBlob = blob;
          return "blob:gif";
        },
        revokeObjectURL: vi.fn(),
        clickDownload,
        scheduleRevoke: (callback) => callback(),
        yieldToBrowser: async () => undefined,
        createGifBlob: (bytes) => {
          encodedBytes = Uint8Array.from(bytes);
          return new Blob([], { type: "image/gif" });
        },
      },
    );

    expect(result).toMatchObject({
      status: "downloaded",
      filename: "动效-海报.gif",
      frameCount: 6,
      durationMs: 500,
    });
    // Palette analysis renders a bounded first pass, then encoding rerenders
    // the six frames; neither pass retains every full-size frame.
    expect(renderedScenes).toHaveLength(12);
    expect(new Set(renderedScenes.map((frame) => frame.objects[0]?.y)).size).toBeGreaterThan(2);
    expect(clickDownload).toHaveBeenCalledWith("blob:gif", "动效-海报.gif");
    expect(downloadedBlob?.type).toBe("image/gif");
    const bytes = encodedBytes!;
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
    expect(countSequence(bytes, [0x21, 0xf9, 0x04])).toBe(6);
    expect(readGifDelayCentiseconds(bytes)).toBe(50);
    expect(bytes.at(-1)).toBe(0x3b);
  });

  it("keeps a textured stationary background stable while an opaque subject moves without transparent trails", async () => {
    const scene = sceneFixture([
      objectFixture({ animation: { type: "float", durationMs: 500, amount: 10 } }),
    ], { width: 64, height: 40 });
    let encodedBytes: Uint8Array | undefined;
    await exportAnimatedDesignGifInBrowser(
      { name: "palette-stability", scene },
      {
        waitForFonts: async () => undefined,
        waitForImages: async () => ({ missingAssetObjectIds: [] }),
        renderFrame: async (_frame, { width, height, timeMs }) =>
          texturedMovingSubjectFrame(width, height, Math.floor(timeMs / 80)),
      },
      {
        createObjectURL: () => "blob:gif",
        revokeObjectURL: vi.fn(),
        clickDownload: vi.fn(),
        scheduleRevoke: (callback) => callback(),
        yieldToBrowser: async () => undefined,
        createGifBlob: (bytes) => {
          encodedBytes = Uint8Array.from(bytes);
          return new Blob([], { type: "image/gif" });
        },
      },
    );

    const frames = decodeGif(encodedBytes!);
    expect(frames).toHaveLength(6);
    // This pixel is never covered by the moving subject. A per-frame palette
    // changes its decoded colour as the subject's colours change; one palette
    // for the animation keeps the background visually still.
    const stationaryPixel = (18 * 64 + 12) * 4;
    const backgroundColours = frames.map((frame) =>
      Array.from(frame.slice(stationaryPixel, stationaryPixel + 4)),
    );
    expect(new Set(backgroundColours.map((colour) => colour.join(","))).size).toBe(1);

    // The sprite advances in six-pixel steps. Its old location must be fully
    // transparent in the next composited frame rather than retaining a trail.
    for (let index = 1; index < frames.length; index += 1) {
      const oldSpritePixel = (8 * 64 + (4 + (index - 1) * 6)) * 4;
      expect(frames[index]?.[oldSpritePixel + 3]).toBe(0);
    }
  });
});

function objectFixture(
  patch: Partial<DesignObject> & {
    animation?: { type: "float" | "scale"; durationMs: number; amount: number };
  } = {},
): DesignObject {
  return {
    objectId: "11111111-1111-4111-8111-111111111111",
    objectVersion: 1,
    type: "rect",
    name: "矩形",
    x: 10,
    y: 40,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    zIndex: 0,
    fill: { kind: "solid", color: "#ff0000" },
    stroke: null,
    strokeWidth: 0,
    radiusX: 0,
    radiusY: 0,
    ...patch,
  } as DesignObject;
}

function sceneFixture(
  objects: DesignObject[],
  canvas: { width: number; height: number } = { width: 320, height: 180 },
): LoomicSceneV1 {
  return {
    schemaVersion: 1,
    engine: "fabric",
    canvas: { ...canvas, background: "#ffffff" },
    objects,
  };
}

function countSequence(bytes: Uint8Array, sequence: number[]) {
  let count = 0;
  for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    if (sequence.every((value, offset) => bytes[index + offset] === value)) {
      count += 1;
    }
  }
  return count;
}

function readGifDelayCentiseconds(bytes: Uint8Array) {
  let duration = 0;
  for (let index = 0; index <= bytes.length - 8; index += 1) {
    if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) {
      duration += (bytes[index + 4] ?? 0) + (bytes[index + 5] ?? 0) * 256;
    }
  }
  return duration;
}

function texturedMovingSubjectFrame(width: number, height: number, step: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const spriteX = 4 + step * 6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      // Deliberately use more than 256 stationary background colours. The
      // changing foreground otherwise makes a separate palette per frame map
      // this background to different representative colours.
      data[offset] = (x * 17 + y * 11) & 255;
      data[offset + 1] = (x * 7 + y * 23) & 255;
      data[offset + 2] = (x * 29 + y * 5) & 255;
      data[offset + 3] = 255;
      if (y >= 6 && y < 14 && x >= spriteX && x < spriteX + 6) {
        data[offset] = 245 - step * 25;
        data[offset + 1] = 25 + step * 35;
        data[offset + 2] = 160 + step * 12;
        data[offset + 3] = 255;
      }
    }
  }
  // Make the area where the object was on the previous frame transparent.
  // This exercises GIF disposal/compositing rather than just checking indexed
  // pixels in isolation.
  if (step > 0) {
    const oldX = 4 + (step - 1) * 6;
    for (let y = 6; y < 14; y += 1) {
      for (let x = oldX; x < oldX + 6; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset + 3] = 0;
      }
    }
  }
  return { width, height, data } as ImageData;
}

/** Minimal GIF89a decoder for the encoder contract exercised in this test. */
function decodeGif(bytes: Uint8Array): Uint8Array[] {
  let offset = 6;
  const width = readUint16(bytes, offset);
  const height = readUint16(bytes, offset + 2);
  const packed = bytes[offset + 4] ?? 0;
  offset += 7;
  let globalPalette = (packed & 0x80) !== 0 ? readPalette(bytes, offset, packed) : [];
  if (globalPalette.length) offset += globalPalette.length * 3;
  const canvas = new Uint8Array(width * height * 4);
  const frames: Uint8Array[] = [];
  let transparentIndex = -1;
  let dispose = 0;
  while (offset < bytes.length && bytes[offset] !== 0x3b) {
    const marker = bytes[offset++];
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) {
        offset += 1; // block size
        const control = bytes[offset++] ?? 0;
        dispose = (control >> 2) & 7;
        offset += 2; // delay
        transparentIndex = (control & 1) !== 0 ? (bytes[offset] ?? -1) : -1;
        offset += 2; // transparent index and terminator
      } else {
        offset = skipSubBlocks(bytes, offset);
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`Unexpected GIF marker: ${marker}`);
    const left = readUint16(bytes, offset);
    const top = readUint16(bytes, offset + 2);
    const frameWidth = readUint16(bytes, offset + 4);
    const frameHeight = readUint16(bytes, offset + 6);
    const descriptor = bytes[offset + 8] ?? 0;
    offset += 9;
    let palette = globalPalette;
    if ((descriptor & 0x80) !== 0) {
      palette = readPalette(bytes, offset, descriptor);
      offset += palette.length * 3;
    }
    const minimumCodeSize = bytes[offset++] ?? 2;
    const blocksStart = offset;
    offset = skipSubBlocks(bytes, offset);
    const indices = decodeGifLzw(readSubBlocks(bytes, blocksStart), minimumCodeSize);
    for (let index = 0; index < frameWidth * frameHeight; index += 1) {
      const colourIndex = indices[index] ?? 0;
      if (colourIndex === transparentIndex) continue;
      const colour = palette[colourIndex] ?? [0, 0, 0];
      const pixel = ((top + Math.floor(index / frameWidth)) * width + left + (index % frameWidth)) * 4;
      canvas.set([colour[0] ?? 0, colour[1] ?? 0, colour[2] ?? 0, 255], pixel);
    }
    frames.push(Uint8Array.from(canvas));
    if (dispose === 2) {
      for (let y = top; y < top + frameHeight; y += 1) {
        canvas.fill(0, (y * width + left) * 4, (y * width + left + frameWidth) * 4);
      }
    }
  }
  return frames;
}

function readPalette(bytes: Uint8Array, offset: number, packed: number): number[][] {
  const length = 1 << ((packed & 7) + 1);
  return Array.from({ length }, (_, index) => Array.from(bytes.slice(offset + index * 3, offset + index * 3 + 3)));
}

function readUint16(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function skipSubBlocks(bytes: Uint8Array, offset: number) {
  while ((bytes[offset] ?? 0) !== 0) offset += 1 + (bytes[offset] ?? 0);
  return offset + 1;
}

function readSubBlocks(bytes: Uint8Array, offset: number) {
  const parts: number[] = [];
  while ((bytes[offset] ?? 0) !== 0) {
    const length = bytes[offset++] ?? 0;
    parts.push(...bytes.slice(offset, offset + length));
    offset += length;
  }
  return Uint8Array.from(parts);
}

function decodeGifLzw(data: Uint8Array, minimumCodeSize: number) {
  let bitOffset = 0;
  const readCode = (size: number) => {
    let value = 0;
    for (let bit = 0; bit < size; bit += 1) value |= ((data[(bitOffset + bit) >> 3] ?? 0) >> ((bitOffset + bit) & 7) & 1) << bit;
    bitOffset += size;
    return value;
  };
  const clear = 1 << Math.max(2, minimumCodeSize);
  const end = clear + 1;
  let codeSize = Math.max(2, minimumCodeSize) + 1;
  let dictionary: number[][] = [];
  const reset = () => {
    dictionary = Array.from({ length: clear + 2 }, (_, index) =>
      index < clear ? [index] : [],
    );
    codeSize = Math.max(2, minimumCodeSize) + 1;
  };
  reset();
  const output: number[] = [];
  let previous: number[] | undefined;
  while (bitOffset + codeSize <= data.length * 8) {
    const code = readCode(codeSize);
    if (code === clear) { reset(); previous = undefined; continue; }
    if (code === end) break;
    const entry = dictionary[code] ?? (previous ? [...previous, previous[0] ?? 0] : []);
    output.push(...entry);
    if (previous && entry.length) {
      dictionary.push([...previous, entry[0]!]);
      if (dictionary.length === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  return output;
}
