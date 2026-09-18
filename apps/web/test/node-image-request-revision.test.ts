import { describe, expect, it } from "vitest";
import {
  acceptNodeImageRequest,
  nodeImageSubmissionFailure,
  NodeImageSubmissionError,
  prepareNodeImageRequest,
  toNodeImageGenerationPayload,
  type NodeImageRequest,
} from "../src/lib/node-image-generation";
import { ApiApplicationError } from "../src/lib/server-api";

const request: NodeImageRequest = {
  requestId: "original-request", state: "unknown", prompt: "original prompt",
  model: "gpt-image-2", aspectRatio: "1:1", quality: "hd",
};

describe("server-assigned node submission revision", () => {
  it.each([["standard", "1k"], ["hd", "2k"], ["ultra", "4k"]])("separates %s resolution from quality", (quality, resolution) => {
    const next = prepareNodeImageRequest({ ...request, quality });
    expect(next).toMatchObject({ quality: "standard", resolution });
    expect(toNodeImageGenerationPayload("canvas", "element", next)).toMatchObject({ quality: "standard", resolution });
  });
  it("keeps the recovered identity and server revision until an explicit next attempt", () => {
    const accepted = acceptNodeImageRequest(request, { node_submission_revision: 42 });
    expect(accepted).toMatchObject({ ...request, state: "accepted", submissionRevision: 42 });
    const next = prepareNodeImageRequest({ ...request, prompt: "retry prompt", nodeImageRequest: accepted });
    expect(next.requestId).not.toBe(request.requestId);
    expect(next).toMatchObject({ state: "submitting", prompt: "retry prompt" });
    expect(next).not.toHaveProperty("submissionRevision");
  });

  it("retains the frozen identity on an unknown retry instead of using the edited draft", () => {
    expect(prepareNodeImageRequest({ ...request, prompt: "edited draft", nodeImageRequest: request }))
      .toEqual({ ...request, state: "submitting" });
  });

  it("lets a rejected model change and creates a new request identity", () => {
    const failure = nodeImageSubmissionFailure(new NodeImageSubmissionError("submit",
      new ApiApplicationError("node_model_unavailable", "Selected model is unavailable")));
    expect(failure.state).toBe("rejected");
    const next = prepareNodeImageRequest({ ...request, model: "replacement-model", nodeImageRequest: { ...request, state: failure.state } });
    expect(next.requestId).not.toBe(request.requestId);
    expect(next.model).toBe("replacement-model");
  });

  it.each([new TypeError("Failed to fetch"),
    new ApiApplicationError("node_submission_unavailable", "Unknown result"),
    new ApiApplicationError("node_submission_conflict", "Conflicting request"),
    new ApiApplicationError("node_generation_active", "An earlier job is active")])("keeps ambiguous errors frozen: %s", error => {
    const failure = nodeImageSubmissionFailure(new NodeImageSubmissionError("submit", error));
    expect(failure.state).toBe("unknown");
    const next = prepareNodeImageRequest({ ...request, model: "edited-model", nodeImageRequest: { ...request, state: failure.state } });
    expect(next).toEqual({ ...request, state: "submitting" });
  });

  it("releases a first failed save but preserves an already-unknown paid identity", () => {
    const error = new NodeImageSubmissionError("persist", new Error("Save failed"));
    expect(nodeImageSubmissionFailure(error).state).toBe("rejected");
    expect(nodeImageSubmissionFailure(error, true).state).toBe("unknown");
  });
});
