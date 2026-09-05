import { describe, expect, it } from "vitest";

import {
  findDesignOpenTarget,
  findDesignOpenTargetAtPoint,
  findDesignPreviewOpenTarget,
  findPastedDuplicateDesignElementIds,
  getDesignCopyPlacement,
  getDesignNodePlacement,
  getOrCreateDesignCopyAttempt,
  readDesignNodeMetadata,
  tombstonePastedDuplicateDesignNodes,
} from "./canvas-design";

const designId = "24fb3221-cb46-4878-b729-cd3299e1f18e";

describe("canvas design nodes", () => {
  it("centers a lightweight node in scene coordinates", () => {
    expect(
      getDesignNodePlacement(
        {
          scrollX: -100,
          scrollY: -50,
          width: 1000,
          height: 600,
          zoom: { value: 2 },
        },
        1600,
        900,
      ),
    ).toEqual({
      x: 190,
      y: 110,
      width: 320,
      height: 180,
    });
  });

  it("keeps copy ids stable across retry and places the copy to the right", () => {
    const attempts = new Map();
    const ids = ["request-id", "element-id", "unused-id"];
    const createId = () => ids.shift() ?? "unexpected";
    const first = getOrCreateDesignCopyAttempt(attempts, "source", createId);
    expect(getOrCreateDesignCopyAttempt(attempts, "source", createId)).toBe(
      first,
    );
    expect(first).toEqual({ requestId: "request-id", elementId: "element-id" });
    expect(
      getDesignCopyPlacement({ x: 10, y: 20, width: 320, height: 180 }),
    ).toEqual({
      x: 370,
      y: 20,
      width: 320,
      height: 180,
    });
    expect(ids).toEqual(["unused-id"]);
  });

  it("opens only a selected, live Loomic design node", () => {
    const element = {
      id: "design-element",
      type: "rectangle",
      customData: {
        kind: "loomic-design",
        schemaVersion: 1,
        designId,
        revision: 0,
        previewAssetObjectId: null,
        previewRevision: 0,
      },
    };
    expect(findDesignOpenTarget([element], { "design-element": true })).toEqual(
      {
        designId,
        canvasElementId: "design-element",
      },
    );
    expect(
      findDesignOpenTarget([{ ...element, isDeleted: true }], {
        "design-element": true,
      }),
    ).toBeNull();
    expect(findDesignOpenTarget([element], { other: true })).toBeNull();
  });

  it("opens the design under the double-click instead of the stale selection", () => {
    const otherDesignId = "35fc4332-7fe8-405f-bbc2-b6034140d422";
    const node = (id: string, nodeDesignId: string, x: number) => ({
      id,
      x,
      y: 20,
      width: 300,
      height: 180,
      angle: 0,
      customData: {
        kind: "loomic-design",
        schemaVersion: 1,
        designId: nodeDesignId,
        revision: 0,
        previewAssetObjectId: null,
        previewRevision: 0,
      },
    });
    const first = node("design-a", designId, 10);
    const second = node("design-b", otherDesignId, 400);

    expect(findDesignOpenTarget([first, second], { "design-a": true })).toEqual(
      { designId, canvasElementId: "design-a" },
    );
    expect(
      findDesignOpenTargetAtPoint(
        [first, second],
        { scrollX: -100, scrollY: -10, zoom: { value: 2 } },
        { x: 800, y: 200 },
      ),
    ).toEqual({ designId: otherDesignId, canvasElementId: "design-b" });
    expect(
      findDesignPreviewOpenTarget(
        [
          {
            designId,
            canvasElementId: "design-a",
            left: 10,
            top: 20,
            right: 310,
            bottom: 200,
          },
          {
            designId: otherDesignId,
            canvasElementId: "design-b",
            left: 400,
            top: 20,
            right: 700,
            bottom: 200,
          },
        ],
        { x: 550, y: 110 },
      ),
    ).toEqual({ designId: otherDesignId, canvasElementId: "design-b" });
  });

  it("rejects malformed metadata instead of opening an arbitrary element", () => {
    expect(
      readDesignNodeMetadata({
        customData: {
          kind: "loomic-design",
          schemaVersion: 1,
          designId: "not-a-uuid",
          revision: 0,
          previewAssetObjectId: null,
          previewRevision: 0,
        },
      }),
    ).toBeNull();
  });

  it("detects a newly pasted duplicate even when Excalidraw orders it first", () => {
    const metadata = {
      kind: "loomic-design" as const,
      schemaVersion: 1 as const,
      designId,
      revision: 0,
      previewAssetObjectId: null,
      previewRevision: 0,
    };
    const original = { id: "original", customData: metadata };
    const pasted = { id: "pasted", customData: metadata };
    expect(
      findPastedDuplicateDesignElementIds([original], [pasted, original]),
    ).toEqual(["pasted"]);
    expect(
      tombstonePastedDuplicateDesignNodes(
        [original],
        [{ ...pasted, version: 4 }, original],
        123,
        () => 456,
      ),
    ).toMatchObject({
      rejectedElementIds: ["pasted"],
      elements: [
        {
          id: "pasted",
          isDeleted: true,
          version: 5,
          versionNonce: 456,
          updated: 123,
        },
        { id: "original" },
      ],
    });
  });
});
