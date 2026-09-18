import { describe, expect, it } from "vitest";
import type { DesignTaskTarget } from "@loomic/shared";
import type { ReadyAttachment } from "../src/hooks/use-image-attachments";
import { mergeContinuationAttachments, resolveFreshAuthorizedDesignScope, resolveFreshTaskTarget } from "../src/lib/chat-submission-scope";

const target: DesignTaskTarget = { kind: "canvas_image", elementId: "element-a", assetId: "asset-a" };
const attachment = (assetId: string, source: ReadyAttachment["source"] = "canvas-ref"): ReadyAttachment => ({ assetId, source, url: `https://example.test/${assetId}.png`, mimeType: "image/png" });

describe("fresh target evidence precedence", () => {
  const selection = [{ id: "selected-element", type: "image", assetId: "selected-asset" }];
  const input = { attachments: [], canvasImages: [], selection };
  it("never falls back to a board or selected image for a new upload", () => {
    expect(resolveFreshTaskTarget({ ...input, attachments: [attachment("uploaded", "upload")] })).toBeUndefined();
  });
  it("does not invent a unique target for multiple attachments or an unresolved canvas reference", () => {
    expect(resolveFreshTaskTarget({ ...input, attachments: [attachment("one"), attachment("two")] })).toBeUndefined();
    expect(resolveFreshTaskTarget({ ...input, attachments: [attachment("missing")] })).toBeUndefined();
  });
  it("binds the explicit canvas reference before stale selection", () => {
    expect(resolveFreshTaskTarget({ ...input, attachments: [attachment("new-asset")], canvasImages: [{ id: "new-element", assetId: "new-asset" }] }))
      .toEqual({ kind: "canvas_image", elementId: "new-element", assetId: "new-asset" });
  });
  it("keeps a selected child element rather than widening to the open design", () => {
    expect(resolveFreshTaskTarget({ ...input, selection: [{ id: "title", type: "text", designId: "design-a" }] }))
      .toEqual({ kind: "design", designId: "design-a", elementId: "title" });
    expect(resolveFreshTaskTarget(input)).toEqual({ kind: "canvas_image", elementId: "selected-element", assetId: "selected-asset" });
  });
  it("does not treat an open editor as fresh task evidence", () => {
    expect(resolveFreshTaskTarget({ ...input, selection: [] })).toBeUndefined();
  });
});

describe("fresh multi-board submission scope", () => {
  it("uses the first selected design as the exact primary and keeps all selected designs", () => {
    const scope = resolveFreshAuthorizedDesignScope({ attachments: [], selection: [
      { id: "node-a", type: "rectangle", designId: "design-a" },
      { id: "node-b", type: "rectangle", designId: "design-b" },
    ] });
    expect(scope).toEqual({
      target: { kind: "design", designId: "design-a", elementId: "node-a" },
      authorizedTargets: [
        { kind: "design", designId: "design-a", elementId: "node-a" },
        { kind: "design", designId: "design-b", elementId: "node-b" },
      ],
    });
  });

  it("does not broaden a mixed selection or an attachment into a multi-board scope", () => {
    expect(resolveFreshAuthorizedDesignScope({ attachments: [], selection: [
      { id: "node-a", type: "rectangle", designId: "design-a" }, { id: "shape", type: "rectangle" },
    ] })).toBeUndefined();
    expect(resolveFreshAuthorizedDesignScope({ attachments: [attachment("upload-a")], selection: [
      { id: "node-a", type: "rectangle", designId: "design-a" }, { id: "node-b", type: "rectangle", designId: "design-b" },
    ] })).toBeUndefined();
  });

  it("deduplicates selected design nodes, caps at twenty, and never adds an unselected active board", () => {
    const selection = [
      { id: "first", type: "rectangle", designId: "design-a" }, { id: "duplicate", type: "rectangle", designId: "design-a" },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `node-${index}`, type: "rectangle", designId: `design-${index + 1}` })),
    ];
    const scope = resolveFreshAuthorizedDesignScope({ attachments: [], selection });
    expect(scope?.target).toEqual({ kind: "design", designId: "design-a", elementId: "first" });
    expect(scope?.authorizedTargets).toHaveLength(20);
    expect(scope?.authorizedTargets.map(item => item.designId)).not.toContain("active-but-unselected");
    expect(new Set(scope?.authorizedTargets.map(item => item.designId)).size).toBe(20);
  });
});

describe("continuation attachments", () => {
  it("keeps original references for the same target and lets current metadata replace old metadata", () => {
    const current = { ...attachment("asset-a"), url: "https://example.test/current.png" };
    expect(mergeContinuationAttachments({ previous: [attachment("asset-a"), attachment("style-reference")], current: [current], previousTarget: target }))
      .toEqual([current, attachment("style-reference")]);
  });
  it("removes only the obsolete target image on explicit retarget while retaining other reference evidence", () => {
    expect(mergeContinuationAttachments({ previous: [attachment("asset-a"), attachment("style-reference")], current: [], previousTarget: target,
      nextTarget: { kind: "canvas_image", elementId: "element-b", assetId: "asset-b" }, retargetAttachment: attachment("asset-b") }))
      .toEqual([attachment("style-reference"), attachment("asset-b")]);
  });
  it("retains references for a next deliverable without turning the old target into a destination", () => {
    expect(mergeContinuationAttachments({ previous: [attachment("asset-a"), attachment("brand-reference")],
      current: [], previousTarget: target })).toEqual([attachment("asset-a"), attachment("brand-reference")]);
  });
});
