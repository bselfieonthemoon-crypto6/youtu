import { describe, expect, it } from "vitest";

import { GENERIC_PROVIDER_FAILURE_COPY, providerFailureDescription } from "./provider-failure-copy.js";

describe("providerFailureDescription", () => {
  it("explains a rate-limited channel in Chinese instead of leaking the upstream text", () => {
    const copy = providerFailureDescription("provider_rate_limited");
    expect(copy).toContain("429");
    expect(copy).toContain("没有生成");
    expect(copy).not.toMatch(/[a-z]{4,}/i);
  });

  it.each([
    ["provider_rejected"],
    ["image_generation_result_unknown"],
    ["http_401"],
    ["provider_snapshot_invalid"],
    ["invalid_input"],
    ["safety_filter"],
    ["local_repaint_geometry_mismatch"],
    ["outpaint_geometry_mismatch"],
  ])("covers every terminal code a user can hit: %s", (code) => {
    const copy = providerFailureDescription(code);
    expect(typeof copy).toBe("string");
    expect(copy!.length).toBeGreaterThan(8);
    // No raw upstream identifiers or English sentences.
    expect(copy).not.toMatch(/workspace:|http\s?\d|upstream|token/i);
  });

  it("returns undefined for an unknown code so the caller falls back to generic copy", () => {
    expect(providerFailureDescription(null)).toBeUndefined();
    expect(providerFailureDescription(undefined)).toBeUndefined();
    expect(providerFailureDescription("some_new_code")).toBeUndefined();
    expect(GENERIC_PROVIDER_FAILURE_COPY).toContain("失败");
  });
});
