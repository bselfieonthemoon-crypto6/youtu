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

  it("carries the asset id as the durable reference and says the ordinal is order only", () => {
    // 图片编号和顺序也应该绑定稳定的 asset ID，不能靠位置猜测: the ordinal orders
    // the listing, the asset id answers "which image", and the text must say which
    // of the two is durable.
    const context = selectRelatedImageContext({
      elements: [
        image("poster", 0, "70000000-0000-4000-8000-000000000010"),
        // No assetId at all: an unnamed/unbacked canvas file.
        { id: "loose-png", type: "image", x: 30, y: 0, width: 10, height: 10, customData: { name: "loose" } },
      ],
    });
    expect(context.candidates[0]).toMatchObject({ elementId: "poster", canvasIndex: 0,
      assetId: "70000000-0000-4000-8000-000000000010", hasAssetId: true, assetIdentitySource: "customData.assetId" });
    // The unbacked case is stated positively rather than left as a missing key.
    expect(context.candidates[1]).toMatchObject({ elementId: "loose-png", canvasIndex: 1,
      hasAssetId: false, assetIdentitySource: "unbacked" });
    expect(context.candidates[1]).not.toHaveProperty("assetId");

    const rendered = renderRelatedImageContext(context)!;
    expect(rendered).toContain('asset_id="70000000-0000-4000-8000-000000000010"');
    expect(rendered).toContain('asset_identity="asset_id+element_id"');
    expect(rendered).toContain('element_id="loose-png"');
    expect(rendered).toContain('asset_identity="unbacked_no_asset_id"');
    expect(rendered).toContain("canvas_index is this listing's order");
    expect(rendered).toContain("never an image's identity or a request reference");
    // The negative claim: the listing never presents the position as the identity
    // — an ordinal is not an id, and no candidate may be identified by "image N".
    expect(rendered).not.toMatch(/asset_identity="canvas_index/);
    expect(rendered).not.toMatch(/asset_identity="\d/);
    expect(rendered).toContain("this listing carries no size");
  });

  it("states that it carries none of the four image sizes instead of implying the frame is the pixels", () => {
    // The candidate block is the listing the status answer was built from, so it
    // must not look like it knows a size: ② lives on the job receipt and ③ on the
    // canvas element, and neither is here.
    const rendered = renderRelatedImageContext(selectRelatedImageContext({
      elements: [image("poster", 0, "asset-poster")],
    }))!;
    expect(rendered).toContain("this listing carries no size");
    expect(rendered).toContain("generation job receipt (sourcePixelWidth/sourcePixelHeight)");
    expect(rendered).toContain("canvas display frame comes from inspect_canvas");
    expect(rendered).toContain("an export size only from the export job's own result");
    // No bare size keys on the candidate itself.
    expect(rendered).not.toMatch(/width="\d+"/);
    expect(rendered).not.toMatch(/canvas_frame_width="\d+"/);
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
    // again because the block now states the identity and four-size rules once
    // for the whole listing; per-candidate metadata caps are unchanged, which is
    // what the second assertion below guards.
    expect(boundedRendered?.length).toBeLessThan(6_200);
    // The fixed rule text is constant, so per-candidate cost is what actually
    // scales: ten maximal labels add ~3.6 KB here, while the same ten candidates
    // with ordinary labels add none of it. A regression that stopped truncating
    // verbose metadata would add tens of KB in this difference, not hundreds.
    const shortRendered = renderRelatedImageContext(selectRelatedImageContext({
      elements: Array.from({ length: 10 }, (_, index) => image(`short-${index}`, index)),
    }))!;
    expect(boundedRendered!.length - shortRendered.length).toBeLessThan(4_500);
  });
});