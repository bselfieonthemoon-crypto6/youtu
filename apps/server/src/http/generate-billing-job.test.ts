import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = fileURLToPath(new URL("./generate.ts", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

describe("legacy synchronous image billing", () => {
  it("creates an unqueued job before charging and refunds failures", () => {
    const directImage = source.slice(
      source.indexOf('app.post("/api/agent/generate-image"'),
      source.indexOf("// ── POST /api/agent/generate-video"),
    );
    expect(directImage).toContain("deferEnqueue: true");
    expect(directImage).toContain("job.id,");
    expect(directImage).toContain("markRunning(job.id)");
    expect(directImage).toContain("markSucceeded(billingJobId");
    expect(directImage).toContain("refundCredits(");
  });
});
