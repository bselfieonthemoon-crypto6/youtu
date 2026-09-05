import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./image-proxy.ts", import.meta.url)), "utf8");

describe("image proxy network boundary", () => {
  it("requires HTTPS and an exact host boundary", () => {
    expect(source).toContain("safeDownload(url");
    expect(source).toContain("allowedHosts: allowed");
  });

  it("blocks redirects and maps time, MIME and body size through the shared boundary", () => {
    expect(source).toContain("maxRedirects: 0");
    expect(source).toContain("timeoutMs: 10_000");
    expect(source).toContain("allowedMimeTypes");
    expect(source).toContain("20 * 1024 * 1024");
    expect(source).toContain('error.code === "too_large" ? 413');
  });
});
