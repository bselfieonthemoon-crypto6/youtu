import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importFromTarballUrl } from "./skill-import-service.js";

const source = readFileSync(fileURLToPath(new URL("./skill-import-service.ts", import.meta.url)), "utf8");

describe("skill import download boundary", () => {
  it("rejects arbitrary tarball hosts before downloading", async () => {
    await expect(importFromTarballUrl("https://attacker.example/package.tgz"))
      .rejects.toMatchObject({ code: "tarball_extract_error" });
  });

  it("enforces compressed, expanded, entry-count and per-file budgets", () => {
    expect(source).toContain("MAX_TARBALL_BYTES = 25 * 1024 * 1024");
    expect(source).toContain("MAX_TARBALL_ENTRIES = 500");
    expect(source).toContain("MAX_TARBALL_EXPANDED_BYTES = 20 * 1024 * 1024");
    expect(source).toContain("MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024");
    expect(source).toContain('normalizedParts.includes("..")');
  });
});
