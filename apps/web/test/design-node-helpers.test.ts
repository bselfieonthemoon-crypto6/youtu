import { describe, expect, it } from "vitest";

import {
  findDuplicateDesignNodes,
  inspectPastedDesignNodes,
  readDesignNodeMetadata,
} from "../src/lib/design-node-helpers";

const designId = "10000000-0000-4000-8000-000000000001";

describe("design node duplicate and paste guards", () => {
  it("recognizes only strict, live Loomic design metadata", () => {
    expect(readDesignNodeMetadata(node("node-1", designId))).toMatchObject({
      designId,
      revision: 2,
    });
    expect(
      readDesignNodeMetadata({
        ...node("node-1", designId),
        customData: {
          ...node("node-1", designId).customData,
          unexpected: true,
        },
      }),
    ).toBeNull();
    expect(
      readDesignNodeMetadata({ ...node("node-1", designId), isDeleted: true }),
    ).toBeNull();
  });

  it("finds every extra live node sharing one design identity", () => {
    expect(
      findDuplicateDesignNodes([
        node("original", designId),
        node("copy-1", designId),
        node("copy-2", designId),
      ]),
    ).toEqual([
      {
        designId,
        authoritativeElementId: "original",
        duplicateElementIds: ["copy-1", "copy-2"],
      },
    ]);
  });

  it("flags pasted design nodes for server-side clone before persistence", () => {
    const malformed = {
      id: "bad-copy",
      customData: {
        kind: "loomic-design",
        schemaVersion: 1,
        designId: "not-a-uuid",
        revision: 2,
        previewAssetObjectId: null,
        previewRevision: 0,
      },
    };
    expect(
      inspectPastedDesignNodes(
        [node("original", designId)],
        [node("original", designId), node("copy", designId), malformed],
      ),
    ).toMatchObject({
      requiresClone: true,
      pasted: [{ elementId: "copy", metadata: { designId } }],
      duplicateElementIds: ["copy"],
      malformedElementIds: ["bad-copy"],
    });
  });

  it("keeps the pre-paste binding authoritative even when the copied node sorts first", () => {
    expect(
      inspectPastedDesignNodes(
        [node("original", designId)],
        [node("copy", designId), node("original", designId)],
      ).duplicateElementIds,
    ).toEqual(["copy"]);
  });
});

function node(id: string, currentDesignId: string) {
  return {
    id,
    isDeleted: false,
    customData: {
      kind: "loomic-design" as const,
      schemaVersion: 1 as const,
      designId: currentDesignId,
      revision: 2,
      previewAssetObjectId: null,
      previewRevision: 0,
    },
  };
}
