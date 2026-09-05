import { describe, expect, it } from "vitest";

import { runImageGenerate } from "./image-generate.js";

describe("generate_image billing passthrough", () => {
  it("returns only the authoritative billing supplied by the server submitter", async () => {
    const billing = {
      estimate: 8,
      charged: 8,
      balanceAfter: 92,
      currency: "credits" as const,
    };
    const result = await runImageGenerate(
      {
        title: "Logo",
        prompt: "A logo",
        model: "model",
        aspectRatio: "1:1",
      },
      undefined,
      async () => ({
        jobId: "job-1",
        imageUrl: "https://example.com/image.png",
        width: 1024,
        height: 1024,
        mimeType: "image/png",
        billing,
      }),
    );

    expect(result.billing).toEqual(billing);
  });
});
