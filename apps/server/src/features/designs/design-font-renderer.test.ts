import { describe, expect, it, vi } from "vitest";
import type { DesignObject, LoomicSceneV1 } from "@loomic/shared";
import type { Font } from "fontkit";
import { loadDesignFontBinaries, parseDesignFonts, renderBoundText, splitDesignTextLines } from "./design-font-renderer.js";

const text = {
  type: "textbox", text: "元旦", fontFaceId: "bound-face", fontFamily: "Original",
  fontSize: 100, x: 10, y: 20, width: 100, textAlign: "left", charSpacing: 0, lineHeight: 1.16,
} as Extract<DesignObject, { type: "textbox" }>;
const scene = { objects: [text] } as LoomicSceneV1;

describe("bound template fonts", () => {
  it.each(["\r", "\n", "\r\n", "\u2028", "\u2029"])("treats %j as a line boundary instead of a missing glyph", separator => {
    const layout = vi.fn((value: string) => ({
      advanceWidth: value.length * 700,
      glyphs: [...value].map(character => ({ id: /[\r\n\u2028\u2029]/.test(character) ? 0 : 1, path: { transform: () => ({ toSVG: () => "M0 0Z" }) } })),
      positions: [...value].map(() => ({ xAdvance: 700, xOffset: 0, yOffset: 0 })),
    }));
    const font = { unitsPerEm: 1000, layout } as unknown as Font;
    const object = { ...text, text: `元${separator}旦${separator}${separator}` };
    const original = JSON.stringify(object);
    expect(splitDesignTextLines(object.text)).toEqual(["元", "旦", "", ""]);
    expect(() => renderBoundText(object, font, 'fill="red"')).not.toThrow();
    expect(layout.mock.calls.every(([value]) => !/[\r\n\u2028\u2029]/.test(value))).toBe(true);
    expect(JSON.stringify(object)).toBe(original);
  });
  it("still rejects genuinely unsupported visible characters with actionable diagnostics", () => {
    const font = { unitsPerEm: 1000, layout: () => ({ advanceWidth: 700, glyphs: [{ id: 0, codePoints: [0x1f600] }], positions: [{ xAdvance: 700, xOffset: 0, yOffset: 0 }] }) } as unknown as Font;
    expect(() => renderBoundText({ ...text, objectId: "text-layer", text: "😀" }, font, "")).toThrow("U+1F600; object text-layer; font bound-face");
  });
  it("never falls back to the family name when the bound font is missing", () => {
    expect(() => parseDesignFonts(scene, new Map())).toThrow("no substitute was used");
  });
  it("rejects invalid font bytes", () => {
    expect(() => parseDesignFonts(scene, new Map([["bound-face", { buffer: Buffer.from("invalid"), mimeType: "font/ttf" }]]))).toThrow("could not be decoded");
  });
  it("keeps unbound legacy system text compatible", () => {
    expect(parseDesignFonts({ objects: [{ ...text, fontFaceId: undefined }] } as LoomicSceneV1, new Map()).size).toBe(0);
  });
  it("uses actual glyph outlines and advances with Fabric baselines, without changing the scene", () => {
    const transform = vi.fn((..._matrix: number[]) => ({ toSVG: () => "M0 0L10 10Z" }));
    const font = {
      unitsPerEm: 1000,
      layout: (value: string) => ({
        advanceWidth: value.length * 700,
        glyphs: [...value].map(() => ({ id: 1, path: { transform } })),
        positions: [...value].map(() => ({ xAdvance: 700, xOffset: 0, yOffset: 0 })),
      }),
    } as unknown as Font;
    const original = JSON.stringify(text);
    const svg = renderBoundText(text, font, 'fill="#ff0000"');
    expect(svg).toContain('<path d="M0 0L10 10Z M0 0L10 10Z"');
    expect(svg).not.toContain("font-family");
    expect(transform.mock.calls[0]?.slice(0, 5)).toEqual([0.1, 0, 0, -0.1, 10]);
    expect(transform.mock.calls[0]?.[5]).toBeCloseTo(107.914);
    expect(transform.mock.calls[1]?.[5]).toBeCloseTo(238.994);
    expect(JSON.stringify(text)).toBe(original);
  });
  it("rejects a foreign-workspace font before downloading any bytes", async () => {
    const query = { select: vi.fn(() => query), in: vi.fn(async () => ({ data: [{ id: "bound-face", scope: "workspace", workspace_id: "foreign", allow_web_embed: true }], error: null })) };
    const admin = { from: vi.fn(() => query), storage: { from: vi.fn() } };
    await expect(loadDesignFontBinaries(admin as never, scene, "current", new Map())).rejects.toMatchObject({ code: "design_font_forbidden" });
    expect(admin.storage.from).not.toHaveBeenCalled();
  });
  it("loads each bound face once, keeping the original binding", async () => {
    const faceQuery = { select: vi.fn(() => faceQuery), in: vi.fn(async () => ({ data: [{ id: "bound-face", asset_object_id: "asset", scope: "workspace", workspace_id: "current", allow_web_embed: true }], error: null })) };
    const assetQuery = { select: vi.fn(() => assetQuery), eq: vi.fn(() => assetQuery), maybeSingle: vi.fn(async () => ({ data: { scope: "workspace", workspace_id: "current", bucket: "assets", object_path: "font.ttf", byte_size: 3 }, error: null })) };
    const download = vi.fn(async () => ({ data: new Blob(["ttf"]), error: null }));
    const admin = { from: (table: string) => table === "font_faces" ? faceQuery : assetQuery, storage: { from: () => ({ download }) } };
    const assets = new Map();
    await loadDesignFontBinaries(admin as never, { objects: [text, text] } as LoomicSceneV1, "current", assets);
    expect(download).toHaveBeenCalledTimes(1);
    expect(assets.get("bound-face").buffer.toString()).toBe("ttf");
  });
});
