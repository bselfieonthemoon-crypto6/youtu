import { describe, expect, it } from "vitest";

import { parseDesignSyncMessage } from "../src/hooks/use-websocket";

describe("WebSocket design.sync", () => {
  it("accepts the strict top-level outbox event and rejects malformed preview state", () => {
    const event = {
      type: "design.sync",
      designId: "10000000-0000-4000-8000-000000000001",
      revision: 4,
      updateType: "preview",
      changedObjectIds: [],
      previewAssetObjectId: "20000000-0000-4000-8000-000000000001",
      previewRevision: 4,
    };
    expect(parseDesignSyncMessage(event)).toEqual(event);
    expect(parseDesignSyncMessage({ ...event, previewRevision: 5 })).toBeNull();
  });
});
