import { describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_RETRY_DELAYS_MS, generateWithRateLimitRetry } from "./image-generation.js";

/**
 * A real acceptance run hit `429 当前分组上游负载已饱和，请稍后再试` from the image
 * gateway and the user's request dead-lettered on a transient overload. A 429 is a
 * pre-dispatch rejection (no image can exist), so retrying the same attempt is
 * safe; these tests pin the bound and the code it applies to.
 */
describe("generateWithRateLimitRetry", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };

  it("retries only a rate limit and returns the later success", async () => {
    sleeps.length = 0;
    const generate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("429 overloaded"), { code: "provider_rate_limited" }))
      .mockRejectedValueOnce(Object.assign(new Error("429 overloaded"), { code: "provider_rate_limited" }))
      .mockResolvedValue({ url: "https://example.invalid/a.png", mimeType: "image/png" });

    const result = await generateWithRateLimitRetry(generate, { tag: "[test]", assertNotCanceled: async () => undefined, sleep });

    expect(result).toMatchObject({ url: "https://example.invalid/a.png" });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([RATE_LIMIT_RETRY_DELAYS_MS[0], RATE_LIMIT_RETRY_DELAYS_MS[1]]);
  });

  it("gives up after the bounded delays and keeps the rate-limit code", async () => {
    sleeps.length = 0;
    const generate = vi.fn().mockRejectedValue(Object.assign(new Error("429 overloaded"), { code: "provider_rate_limited" }));

    await expect(generateWithRateLimitRetry(generate, { tag: "[test]", assertNotCanceled: async () => undefined, sleep }))
      .rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(generate).toHaveBeenCalledTimes(RATE_LIMIT_RETRY_DELAYS_MS.length + 1);
    expect(sleeps).toEqual([...RATE_LIMIT_RETRY_DELAYS_MS]);
  });

  it.each(["provider_rejected", "safety_filter", "api_error", "image_generation_result_unknown"])(
    "never retries %s: the paid boundary is untouched",
    async (code) => {
      sleeps.length = 0;
      const generate = vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { code }));

      await expect(generateWithRateLimitRetry(generate, { tag: "[test]", assertNotCanceled: async () => undefined, sleep }))
        .rejects.toMatchObject({ code });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    },
  );

  it("stops retrying when the job is canceled while waiting", async () => {
    sleeps.length = 0;
    let canceled = false;
    const generate = vi.fn().mockImplementation(async () => {
      if (canceled) throw new Error("should not be called after cancellation");
      canceled = true;
      throw Object.assign(new Error("429 overloaded"), { code: "provider_rate_limited" });
    });

    await expect(generateWithRateLimitRetry(generate, { tag: "[test]",
      assertNotCanceled: async () => { if (canceled) throw Object.assign(new Error("job_canceled"), { code: "job_canceled" }); },
      sleep })).rejects.toMatchObject({ code: "job_canceled" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
