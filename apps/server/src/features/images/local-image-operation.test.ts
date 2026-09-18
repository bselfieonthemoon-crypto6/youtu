import { describe, expect, it } from "vitest";

import { isLocalImageOperation } from "./local-image-operation.js";

describe("isLocalImageOperation", () => {
  it.each(["region_matting", "split_layers", "erase_transparent", "smart_erase"])(
    "routes %s through the local image backend",
    (operation) => {
      expect(isLocalImageOperation(operation)).toBe(true);
    },
  );

  it.each(["remove_background", "generate", undefined, null, "local:feynobg"])(
    "does not classify %s as a local image operation",
    (operation) => {
      expect(isLocalImageOperation(operation)).toBe(false);
    },
  );
});
