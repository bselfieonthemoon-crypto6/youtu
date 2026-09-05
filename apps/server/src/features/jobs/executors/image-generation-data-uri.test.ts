import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("generated image persistence", () => {
  it("accepts provider data URLs only through the bounded image decoder", () => {
    const source = readFileSync(
      new URL("./image-generation.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("allowDataUri: true");
    expect(source).toContain("maxBytes: 30 * 1024 * 1024");
    expect(source).toContain('kind: "image"');
    expect(source).toMatch(
      /allowedMimeTypes:\s*\[\s*"image\/png",\s*"image\/jpeg",\s*"image\/webp",\s*"image\/avif",?\s*\]/,
    );
  });
});
