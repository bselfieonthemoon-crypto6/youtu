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

describe("durable HTTP video submission", () => {
  it("replays a server-owned key and commits billing plus publication atomically", () => {
    // The video route is the last route in this module, so the remainder of the
    // source is the route body plus its helpers.
    const video = source.slice(
      source.indexOf('app.post("/api/agent/generate-video"'),
    );
    expect(video).toContain("deferEnqueue: true");
    expect(video).toContain('request.headers["idempotency-key"]');
    expect(video).toContain("findVideoSubmission(user");
    expect(video).toContain("videoSubmission: { kind: \"http\", key: submissionKey }");
    expect(video).toContain("commitVideoJob(user");
    expect(video).toContain("cancelUncommittedVideoJob(user");
    expect(video).not.toContain("refundCredits(");

    const deferred = video.indexOf("deferEnqueue: true");
    const commit = video.indexOf("commitVideoJob(user");
    expect(deferred).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(deferred);
  });
});
