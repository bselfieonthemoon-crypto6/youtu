import { describe, expect, it } from "vitest";
import { mergeCompletedImageReplacement, mergePendingNodeImageSubmission } from "./canvas-generation-merge.js";

const request = { requestId: "request-1", prompt: "原文", model: "gpt-image-2", aspectRatio: "1:1", quality: "hd" };
const pending = { id: "node-1", type: "rectangle", x: 40, y: -500, version: 30,
  customData: { type: "image-generator", status: "error", nodeImageRequest: { ...request, state: "unknown" } } };
const accepted = { ...pending, x: 0, y: 0, version: 9,
  customData: { type: "image-generator", status: "generating", jobId: "job-1", nodeImageRequest: { ...request, state: "accepted" } } };
describe("durable node progress merge", () => {
  it.each([false, true])("preserves latest geometry and accepted identity in both merge directions: %s", reverse => {
    const merged = reverse ? mergePendingNodeImageSubmission(accepted, pending) : mergePendingNodeImageSubmission(pending, accepted);
    expect(merged).toMatchObject({ x: 40, y: -500, version: 31, customData: { status: "generating", jobId: "job-1", nodeImageRequest: { state: "accepted" } } });
    expect(mergePendingNodeImageSubmission(merged!, accepted)).toBe(merged);
  });
  it("does not resurrect a deleted pending node", () => {
    expect(mergePendingNodeImageSubmission({ ...pending, isDeleted: true }, accepted)).toMatchObject({ isDeleted: true, customData: { jobId: "job-1" } });
  });
  it("keeps the active accepted input over stale or altered request drafts", () => {
    for (const change of [{ requestId: "other" }, { prompt: "changed" }, { model: "other" }]) {
      expect(mergePendingNodeImageSubmission({ ...pending, customData: { ...pending.customData, nodeImageRequest: { ...request, state: "unknown", ...change } } }, accepted))
        .toMatchObject({ x: 40, y: -500, customData: { prompt: request.prompt, model: request.model, jobId: "job-1", nodeImageRequest: { ...request, state: "accepted" } } });
    }
  });
  it.each([false, true])("keeps the job over a pre-submission tab, including deletion: %s", deleted => {
    const old = { ...pending, isDeleted: deleted, customData: { type: "image-generator", status: "idle", prompt: "old draft" } };
    for (const pair of [[old, accepted], [accepted, old]]) {
      expect(mergePendingNodeImageSubmission(pair[0]!, pair[1]!)).toMatchObject({
        x: 40, y: -500, isDeleted: deleted,
        customData: { status: "generating", prompt: request.prompt, jobId: "job-1", nodeImageRequest: { state: "accepted" } },
      });
    }
  });
  it.each([false, true])("uses submission revision over a higher old attempt version: %s", deleted => {
    const old = { ...accepted, version: 100, x: 900, isDeleted: deleted,
      customData: { ...accepted.customData, nodeImageRequest: { ...request, state: "accepted", submissionRevision: 10 } } };
    const recent = { ...accepted, version: 20,
      customData: { ...accepted.customData, jobId: "job-2", nodeImageRequest: { ...request, requestId: "request-2", prompt: "new prompt", state: "accepted", submissionRevision: 30 } } };
    for (const pair of [[old, recent], [recent, old]]) {
      expect(mergePendingNodeImageSubmission(pair[0]!, pair[1]!)).toMatchObject({
        x: 900, isDeleted: deleted, customData: { jobId: "job-2", prompt: "new prompt", nodeImageRequest: { submissionRevision: 30 } },
      });
    }
  });
  it("allows a new request after terminal error without weakening same-request recovery", () => {
    const failed = { ...accepted, customData: { ...accepted.customData, status: "error", errorMessage: "terminal failure" } };
    const retry = { ...pending, customData: { ...pending.customData, status: "generating", nodeImageRequest: { ...request, requestId: "new-request", state: "submitting" } } };
    expect(mergePendingNodeImageSubmission(retry, failed)).toBeNull();
    expect(mergePendingNodeImageSubmission(failed, retry)).toBeNull();
    expect(mergePendingNodeImageSubmission(pending, failed)).toMatchObject({ customData: { status: "error", jobId: "job-1" } });
  });
  it("preserves the newer terminal state of the same accepted job", () => {
    const failed = { ...accepted, version: 31, customData: { ...accepted.customData, status: "error", errorMessage: "terminal failure" } };
    expect(mergePendingNodeImageSubmission(accepted, failed)).toMatchObject({ customData: { status: "error", errorMessage: "terminal failure" } });
  });
  it("allows editing a terminal attempt's next prompt without changing its frozen request", () => {
    const edited = { ...accepted, version: 35, customData: { ...accepted.customData, status: "error", prompt: "retry draft" } };
    expect(mergePendingNodeImageSubmission(accepted, edited)).toMatchObject({
      customData: { prompt: "retry draft", nodeImageRequest: { prompt: request.prompt } },
    });
  });
  it.each([undefined, { ...request, requestId: "previous-request", state: "accepted", submissionRevision: 1 }])("keeps completed node pixels over an old request: %j", oldRequest => {
    const old = { ...pending, isDeleted: true, customData: { type: "image-generator", jobId: oldRequest ? "old-job" : undefined, nodeImageRequest: oldRequest } };
    const image = { id: "node-1", type: "image", version: 12, fileId: "file",
      customData: { sourceJobId: "new-job", sourceRequestId: "new-request", sourceNodeType: "image-generator" } };
    for (const pair of [[old, image], [image, old]]) {
      expect(mergeCompletedImageReplacement(pair[0]!, pair[1]!)).toMatchObject({ type: "image", isDeleted: true, fileId: "file", y: -500 });
    }
  });
  it("completed pixels survive a late unknown state with no jobId", () => {
    const image = { id: "node-1", type: "image", x: 0, y: 0, version: 12, fileId: "file",
      customData: { sourceJobId: "job-1", sourceRequestId: "request-1" } };
    expect(mergeCompletedImageReplacement(pending, image)).toMatchObject({ type: "image", y: -500, fileId: "file", version: 31 });
    expect(mergeCompletedImageReplacement({ ...pending, isDeleted: true }, image)).toMatchObject({ type: "image", isDeleted: true });
    expect(mergeCompletedImageReplacement(pending, { ...image, customData: { sourceJobId: "other", sourceRequestId: "other" } })).toBeNull();
  });
});
