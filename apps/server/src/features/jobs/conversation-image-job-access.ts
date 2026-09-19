import { workspaceRoleSchema } from "@loomic/shared";
import { z } from "zod";

export type ConversationImageJobScope = {
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  liveDesignIds: ReadonlySet<string>;
};

export class ImageJobAccessError extends Error {
  readonly code = "image_job_forbidden";
  readonly statusCode = 403;
  constructor() { super("Image job access forbidden."); }
}

/** Service-role access requires fresh membership and a persisted session/canvas fence. */
export async function authorizeConversationImageJobs(admin: any, userId: string, scope: ConversationImageJobScope) {
  if (![userId, scope.workspaceId, scope.sessionId, scope.canvasId, ...scope.liveDesignIds]
    .every(value => z.string().uuid().safeParse(value).success)) throw new ImageJobAccessError();
  const member = await admin.from("workspace_members").select("role")
    .eq("workspace_id", scope.workspaceId).eq("user_id", userId).maybeSingle();
  const role = workspaceRoleSchema.safeParse(member.data?.role);
  if (member.error || !role.success) throw new ImageJobAccessError();
  const session = await admin.from("chat_sessions").select("canvas_id").eq("id", scope.sessionId).maybeSingle();
  if (session.error || session.data?.canvas_id !== scope.canvasId) throw new ImageJobAccessError();
  const canvas = await admin.from("canvases").select("workspace_id").eq("id", scope.canvasId).maybeSingle();
  if (canvas.error || canvas.data?.workspace_id !== scope.workspaceId) throw new ImageJobAccessError();
  return role.data;
}

/**
 * Scope a job query to this conversation, for one job type.
 *
 * The video status tool reads the same table through the same membership and
 * session/canvas fence; only the `job_type` differs, and the image path must
 * never widen to video (a video job is not an image source or a candidate for
 * `cancel_image_job`).
 */
export function scopeConversationJobs(query: any, scope: ConversationImageJobScope,
  jobType: "image_generation" | "video_generation" = "image_generation") {
  query = query.eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId)
    .eq("job_type", jobType);
  return scope.liveDesignIds.size
    ? query.or(`canvas_id.eq.${scope.canvasId},design_id.in.(${[...scope.liveDesignIds].join(",")})`)
    : query.eq("canvas_id", scope.canvasId);
}

export function scopeConversationImageJobs(query: any, scope: ConversationImageJobScope) {
  return scopeConversationJobs(query, scope, "image_generation");
}
