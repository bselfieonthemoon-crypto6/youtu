import type {
  NodeImageSubmissionRequest,
  NodeImageSubmissionResponse,
} from "@loomic/shared";
import { ApiApplicationError } from "./server-api";

export const NODE_IMAGE_UNKNOWN_MESSAGE =
  "暂时无法确认任务是否已提交。不会自动重新扣费；请稍后刷新，或点击重试提交。";

export type NodeImageRequestState = "submitting" | "unknown" | "accepted" | "rejected";

const activeSubmissionRequestIds = new Set<string>();

export function isNodeImageSubmissionActive(requestId: string): boolean {
  return activeSubmissionRequestIds.has(requestId);
}

export type NodeImageRequest = {
  requestId: string;
  state: NodeImageRequestState;
  /** Assigned by the server's atomic canvas submission, never by the browser. */
  submissionRevision?: number;
  prompt: string;
  model: string;
  aspectRatio: NodeImageSubmissionRequest["aspect_ratio"];
  quality: NodeImageSubmissionRequest["quality"];
  resolution?: "1k" | "2k" | "4k";
};

export function acceptNodeImageRequest(
  request: NodeImageRequest,
  payload: Record<string, unknown>,
): NodeImageRequest {
  const revision = payload.node_submission_revision;
  return {
    ...request,
    state: "accepted",
    ...(typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
      ? { submissionRevision: revision } : {}),
  };
}

type NodeImageDraft = {
  prompt: string;
  model: string;
  aspectRatio: string;
  quality: string;
  nodeImageRequest?: NodeImageRequest;
};

export type NodeImageGenerationPayload = NodeImageSubmissionRequest;

export class NodeImageSubmissionError extends Error {
  constructor(
    readonly phase: "persist" | "submit",
    readonly cause: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : "Node image submission failed",
      { cause },
    );
    this.name = "NodeImageSubmissionError";
  }
}

// Only errors known to occur before enqueue, or from a rolled-back RPC, can
// release the frozen request. Conflicts/active jobs require lookup recovery.
const confirmedRejectionCodes = new Set([
  "invalid_request", "node_submission_invalid", "node_model_unavailable",
  "node_model_changed", "node_not_saved", "insufficient_credits",
  "model_not_accessible", "resolution_not_allowed", "concurrency_limit",
]);

export function nodeImageSubmissionFailure(
  error: unknown,
  previouslyUnknown = false,
): { state: "rejected" | "unknown"; message: string } {
  const cause = error instanceof NodeImageSubmissionError ? error.cause : error;
  // A failed save on a retry cannot resolve an earlier lost POST response.
  if (error instanceof NodeImageSubmissionError && error.phase === "persist") {
    return previouslyUnknown
      ? { state: "unknown", message: NODE_IMAGE_UNKNOWN_MESSAGE }
      : { state: "rejected", message: "无法保存生图节点，任务尚未提交。可修改后重试。" };
  }
  if (cause instanceof ApiApplicationError && confirmedRejectionCodes.has(cause.code)) {
    return { state: "rejected", message: `${cause.message} 本次未提交生成任务，可修改后重试。` };
  }
  return { state: "unknown", message: NODE_IMAGE_UNKNOWN_MESSAGE };
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createNodeImageRequest(
  data: Omit<NodeImageDraft, "nodeImageRequest">,
): NodeImageRequest {
  const aspectRatio = data.aspectRatio as NodeImageRequest["aspectRatio"];
  const quality = data.quality as NodeImageRequest["quality"];
  if (!["1:1", "16:9", "9:16", "4:3", "3:4"].includes(aspectRatio)) {
    throw new Error("不支持的图片比例，请重新选择。");
  }
  if (!["standard", "hd", "ultra"].includes(quality)) {
    throw new Error("不支持的图片质量，请重新选择。");
  }
  return {
    requestId:
      typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : fallbackUuid(),
    state: "submitting",
    prompt: data.prompt,
    model: data.model,
    aspectRatio,
    quality: "standard",
    resolution: quality === "ultra" ? "4k" : quality === "hd" ? "2k" : "1k",
  };
}

/** Unknown submission retries must reuse the exact paid-operation identity/input. */
export function prepareNodeImageRequest(
  data: NodeImageDraft,
): NodeImageRequest {
  const previous = data.nodeImageRequest;
  if (previous?.state === "unknown") {
    return { ...previous, state: "submitting" };
  }
  return createNodeImageRequest(data);
}

export function toNodeImageGenerationPayload(
  canvasId: string,
  elementId: string,
  request: NodeImageRequest,
): NodeImageGenerationPayload {
  return {
    request_id: request.requestId,
    canvas_id: canvasId,
    element_id: elementId,
    prompt: request.prompt,
    model: request.model,
    aspect_ratio: request.aspectRatio,
    quality: request.quality,
    ...(request.resolution ? { resolution: request.resolution } : {}),
  };
}

/**
 * The placeholder/request snapshot must be durably saved before the paid job
 * is submitted. This helper deliberately has no cancellation path: closing a
 * panel never cancels or resubmits an accepted server job.
 */
export async function submitDurableNodeImage(input: {
  accessToken: string;
  canvasId: string;
  elementId: string;
  request: NodeImageRequest;
  persistCanvas: () => Promise<void>;
  submit: (
    accessToken: string,
    payload: NodeImageGenerationPayload,
  ) => Promise<NodeImageSubmissionResponse>;
}): Promise<NodeImageSubmissionResponse> {
  activeSubmissionRequestIds.add(input.request.requestId);
  try {
    try {
      await input.persistCanvas();
    } catch (error) {
      throw new NodeImageSubmissionError("persist", error);
    }
    try {
      return await input.submit(
        input.accessToken,
        toNodeImageGenerationPayload(input.canvasId, input.elementId, input.request),
      );
    } catch (error) {
      throw new NodeImageSubmissionError("submit", error);
    }
  } finally {
    activeSubmissionRequestIds.delete(input.request.requestId);
  }
}
