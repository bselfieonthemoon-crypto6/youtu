import { loomicSceneV1Schema } from "@loomic/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectDesignFontReferences,
  loadDesignSceneFonts,
  resetDesignFontLoaderCache,
} from "../src/lib/design-font-loader";
import { DesignResourceApiError } from "../src/lib/design-resource-api";

const faceId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const scene = loomicSceneV1Schema.parse({
  schemaVersion: 1,
  engine: "fabric",
  canvas: { width: 800, height: 600, background: null },
  objects: [
    {
      objectId,
      objectVersion: 1,
      type: "text",
      name: "标题",
      x: 10,
      y: 20,
      width: 200,
      height: 60,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      zIndex: 0,
      text: "Loomic",
      fontFaceId: faceId,
      fontFamily: "Catalog Sans",
      fontSize: 48,
      fontWeight: 700,
      fontStyle: "normal",
      textAlign: "left",
      lineHeight: 1.2,
      charSpacing: 0,
      fill: { kind: "solid", color: "#111111" },
    },
  ],
});

describe("design font loader", () => {
  const add = vi.fn();
  const load = vi.fn(async function (this: object) {
    return this;
  });

  beforeEach(() => {
    resetDesignFontLoaderCache();
    add.mockClear();
    load.mockClear();
    vi.stubGlobal(
      "FontFace",
      vi.fn(() => ({ load })),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add, ready: Promise.resolve() },
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:font"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("collects durable face metadata and reloads it after a fresh browser cache", async () => {
    expect(collectDesignFontReferences(scene)).toEqual([
      {
        faceId,
        family: "Catalog Sans",
        style: "normal",
        weight: "700",
      },
    ]);
    const getFontFaceContent = vi.fn(async () => new Blob(["font"]));

    await expect(
      loadDesignSceneFonts({
        scene,
        accessToken: "token",
        client: { getFontFaceContent },
      }),
    ).resolves.toEqual({ loadedFaceIds: [faceId], issues: [] });
    expect(getFontFaceContent).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);

    resetDesignFontLoaderCache();
    await loadDesignSceneFonts({
      scene,
      accessToken: "token",
      client: { getFontFaceContent },
    });
    expect(getFontFaceContent).toHaveBeenCalledTimes(2);
  });

  it("reports embedding policy failures instead of silently falling back", async () => {
    const result = await loadDesignSceneFonts({
      scene,
      accessToken: "token",
      client: {
        getFontFaceContent: vi.fn(async () => {
          throw new DesignResourceApiError("forbidden", 403);
        }),
      },
    });

    expect(result.loadedFaceIds).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        faceId,
        reason: "embedding_forbidden",
      }),
    ]);
  });
  it("loads each family alias of the same font file instead of reusing the wrong registration", async () => {
    const aliasScene = structuredClone(scene);
    const alias = { ...aliasScene.objects[0], objectId: "33333333-3333-4333-8333-333333333333", zIndex: 1, fontFamily: "中文字体名" };
    aliasScene.objects.push(alias as typeof aliasScene.objects[number]);
    const getFontFaceContent = vi.fn(async () => new Blob(["font"]));
    expect(collectDesignFontReferences(aliasScene)).toHaveLength(2);
    await loadDesignSceneFonts({ scene: aliasScene, accessToken: "token", client: { getFontFaceContent } });
    expect(add).toHaveBeenCalledTimes(2);
    await loadDesignSceneFonts({ scene: aliasScene, accessToken: "token", client: { getFontFaceContent } });
    expect(add).toHaveBeenCalledTimes(2);
  });
});
