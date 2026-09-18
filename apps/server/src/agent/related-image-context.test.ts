import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSIVE_IMAGE_INPUT_LIMIT,
  MAX_RELATED_IMAGE_CANDIDATES,
  renderRelatedImageContext,
  selectRelatedImageContext,
} from "./related-image-context.js";

const image = (id: string, ordinal: number, assetId = `asset-${id}`) => ({
  id,
  type: "image",
  x: ordinal * 10,
  y: 0,
  width: 10,
  height: 10,
  customData: { assetId, name: `image ${id}` },
});

describe("related image context", () => {
  it("caps passive metadata at ten and passive image inputs at three without changing explicit sources", () => {
    const explicit = Array.from({ length: 14 }, (_, index) => `attachment-${index}`);
    const context = selectRelatedImageContext({
      elements: Array.from({ length: 18 }, (_, index) => image(`node-${index}`, index)),
      explicitSourceIds: explicit,
    });

    expect(context.candidates).toHaveLength(MAX_RELATED_IMAGE_CANDIDATES);
    expect(context.passiveImageElementIds).toHaveLength(DEFAULT_PASSIVE_IMAGE_INPUT_LIMIT);
    expect(context.candidates.map(candidate => candidate.elementId)).toEqual(["node-17", "node-16", "node-15", "node-14", "node-13", "node-12", "node-11", "node-10", "node-9", "node-8"]);
    expect(context.explicitSourceIds).toEqual(explicit);
  });

  it("puts the current selected image first and deduplicates the backing asset before recent fallbacks", () => {
    const context = selectRelatedImageContext({
      elements: [
        image("old", 0, "shared"),
        image("selected", 1, "shared"),
        image("newest", 2),
        { id: "movie", type: "image", x: 30, y: 0, width: 10, height: 10, customData: { isVideo: true } },
      ],
      selectedElementIds: ["selected"],
      explicitSourceIds: ["uploaded-source", "uploaded-source", "older-history-reference"],
    });

    expect(context.candidates).toEqual([
      expect.objectContaining({ elementId: "selected", assetId: "shared", priority: "selected" }),
      expect.objectContaining({ elementId: "newest", priority: "recent" }),
    ]);
    expect(context.passiveImageElementIds).toEqual(["selected", "newest"]);
    expect(context.explicitSourceIds).toEqual(["uploaded-source", "older-history-reference"]);
  });

  it("bounds verbose candidate metadata without truncating stable identities", () => {
    const elementId = `element-${"e".repeat(150)}`;
    const assetId = `asset-${"a".repeat(1_000)}`;
    const context = selectRelatedImageContext({
      elements: [{
        ...image(elementId, 0, assetId),
        customData: {
          assetId,
          name: "n".repeat(1_000),
          title: "t".repeat(1_000),
          // Scene indexing already rejects roles longer than 80 characters.
          role: "r".repeat(80),
        },
      }],
      selectedElementIds: [elementId],
    });

    expect(context.candidates[0]).toMatchObject({ elementId, assetId, priority: "selected" });
    expect(context.candidates[0]?.name).toHaveLength(120);
    expect(context.candidates[0]?.title).toHaveLength(160);
    expect(context.candidates[0]?.role).toHaveLength(80);
    expect(context.candidates[0]?.name).toMatch(/…$/u);

    const boundedRendered = renderRelatedImageContext(selectRelatedImageContext({
      elements: Array.from({ length: 10 }, (_, index) => ({
        ...image(`short-${index}`, index),
        customData: {
          assetId: `asset-${index}`,
          name: "n".repeat(1_000),
          title: "t".repeat(1_000),
          role: "r".repeat(80),
        },
      })),
    }));
    // Ten long scene labels remain bounded; stable IDs are intentionally not
    // shortened and are therefore tested independently above.
    expect(boundedRendered?.length).toBeLessThan(5_000);
  });
});
