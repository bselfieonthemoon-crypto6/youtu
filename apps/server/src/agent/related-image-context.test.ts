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
    // The ten newest images survive the cap, but they are LISTED in canvas
    // order; the recency preference shows up in `passiveImageElementIds`.
    expect(context.candidates.map(candidate => candidate.elementId)).toEqual(["node-8", "node-9", "node-10", "node-11", "node-12", "node-13", "node-14", "node-15", "node-16", "node-17"]);
    expect(context.passiveImageElementIds).toEqual(["node-17", "node-16", "node-15"]);
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
      expect.objectContaining({ elementId: "selected", canvasIndex: 1, assetId: "shared", priority: "selected" }),
      expect.objectContaining({ elementId: "newest", canvasIndex: 2, priority: "recent" }),
    ]);
    expect(context.passiveImageElementIds).toEqual(["selected", "newest"]);
    expect(context.explicitSourceIds).toEqual(["uploaded-source", "older-history-reference"]);
  });

  it("lists the same canvas order for repeated reads of one scene and renders the stable canvas_index", () => {
    // Two same-size squares once came back reversed between reads because this
    // listing was recency-first while every other canvas surface was not.
    const scene = [
      image("poster", 0, "asset-poster"),
      image("square-first", 1, "asset-first"),
      image("square-edit", 2, "asset-edit"),
    ];
    const first = selectRelatedImageContext({ elements: scene });
    const second = selectRelatedImageContext({ elements: scene.map(item => ({ ...item })) });
    expect(first.candidates.map(candidate => candidate.elementId)).toEqual(["poster", "square-first", "square-edit"]);
    expect(second.candidates.map(candidate => candidate.elementId))
      .toEqual(first.candidates.map(candidate => candidate.elementId));
    expect(first.candidates.map(candidate => candidate.canvasIndex)).toEqual([0, 1, 2]);
    expect(renderRelatedImageContext(first)).toBe(renderRelatedImageContext(second));
    const rendered = renderRelatedImageContext(first)!;
    expect(rendered).toContain('index="1" canvas_index="0" element_id="poster"');
    expect(rendered).toContain('index="3" canvas_index="2" element_id="square-edit"');
    expect(rendered).toContain("Listed in canvas order");
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
    // shortened and are therefore tested independently above. The bound moved
    // from 5_000 only because every candidate now also carries the stable
    // `canvas_index` that keeps a repeated read from reshuffling same-size
    // images; per-candidate metadata caps are unchanged.
    expect(boundedRendered?.length).toBeLessThan(5_300);
  });
});
