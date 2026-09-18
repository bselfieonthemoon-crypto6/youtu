import type { AgentTaskSnapshot } from "./agent-task-service.js";

/** Authenticated SQL creates this marker only after the exact result is on the
 * canvas. It authorizes one read-only review, never a new image request. */
export function canvasResultReviewJobId(task: Pick<AgentTaskSnapshot, "brief">): string | undefined {
  const marker = task.brief?.canvasResultReview as { jobId?: unknown; mode?: unknown } | undefined;
  return marker?.mode === "read_only" && typeof marker.jobId === "string" ? marker.jobId : undefined;
}

export function matchesCanvasResultReview(task: AgentTaskSnapshot, job: {
  id?: string; canvas_id?: string | null; session_id?: string | null;
  result?: Record<string, unknown>;
}): boolean {
  return canvasResultReviewJobId(task) === job.id && task.target.kind === "canvas_image"
    && job.canvas_id === task.canvasId && job.session_id === task.sessionId
    && job.result?.canvas_element_id === task.target.elementId
    && job.result?.asset_id === task.target.assetId && typeof job.result?.canvas_finalized_at === "string";
}
