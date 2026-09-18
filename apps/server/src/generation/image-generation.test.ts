import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateImage } from "./image-generation.js";
import { clearProviders, registerImageProvider } from "./providers/registry.js";

describe("image provider mask capability", () => {
  beforeEach(clearProviders);

  it("rejects a masked edit before calling an adapter that would drop it", async () => {
    const generate = vi.fn();
    registerImageProvider({
      name: "no-mask",
      models: [{ id: "model", displayName: "Model", description: "test" }],
      generate,
    });

    await expect(
      generateImage("no-mask", {
        model: "model",
        prompt: "Repaint the selected area",
        inputImages: ["data:image/png;base64,aWFnZQ=="],
        maskImage: "data:image/png;base64,bWFzaw==",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(generate).not.toHaveBeenCalled();
  });
});
