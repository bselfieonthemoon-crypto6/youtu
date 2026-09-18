import { z } from "zod";

import type { JobService } from "../features/jobs/job-service.js";
import { imageSubmissionReceipt } from "../features/jobs/image-submission-receipt.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { compactMastraToolResult } from "./tool-result-projection.js";
import { createAgentTool } from "./tools/tool-run-context.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Expose the same persisted receipt as the chat card, without raw payloads. */
function withImageSubmissionReceipt(job: Record<string, unknown>) {
  const { creditsCost, creditsCostColumn, pricingVersion, quality, resolution, ...rest } = job;
  const cost = numeric(creditsCostColumn) ?? numeric(creditsCost);
  return {
    ...rest,
    ...(typeof rest.error_message === "string"
      ? { error_message: sanitizeErrorForClient(new Error(rest.error_message)) }
      : {}),
    ...imageSubmissionReceipt({
      payload: { mastra_pricing_version: pricingVersion, quality, resolution },
      ...(cost !== undefined ? { credits_cost: cost } : {}),
    }),
  };
}

export type MastraImageJobScope = {
  userId: string;
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  liveDesignIds: ReadonlySet<string>;
};

export type MastraImageJobScopeQuery = (query: any) => any;

/** The Set is intentionally read at invocation time so boards created earlier
 * in the same run become eligible without trusting the active editor state. */
export function createMastraImageJobScopeQuery(
  canvasId: string,
  liveDesignIds: ReadonlySet<string>,
): MastraImageJobScopeQuery {
  return query => liveDesignIds.size
    ? query.or(`canvas_id.eq.${canvasId},design_id.in.(${[...liveDesignIds].join(",")})`)
    : query.eq("canvas_id", canvasId);
}

export function createMastraImageStatusTools(input: {
  jobService: Pick<JobService, "getConversationImageJob" | "cancelJobAdmin">;
  user: AuthenticatedUser;
  scope: MastraImageJobScope;
}) {
  function assertIdentity() {
    if (input.scope.userId !== input.user.id) throw new Error("image_job_forbidden");
  }
  function failure(error: unknown) {
    const code = (error as { code?: string })?.code;
    if (code === "image_job_forbidden" || (error as Error)?.message === "image_job_forbidden")
      return { status: "forbidden" as const, summary: "无权查看或取消此工作区会话中的图片任务；未取消、未重新生成。" };
    if (code === "job_not_found")
      return { status: "not_found" as const, summary: "当前对话和画布范围内没有该图片任务；未取消、未重新生成。" };
    throw error;
  }
  const getImageStatus = createAgentTool({
    id: "get_image_status",
    description: "Read the latest or exact image job in this workspace conversation. Workspace members may view scoped jobs. Never resubmits or charges.",
    inputSchema: z.object({ jobId: z.string().uuid().optional() }),
    execute: async ({ jobId }) => {
      try {
        assertIdentity();
        const job = await input.jobService.getConversationImageJob(input.user, input.scope, jobId);
        if (!job) return compactMastraToolResult({ status: "not_found" });
        return compactMastraToolResult(withImageSubmissionReceipt(job));
      } catch (error) { return failure(error); }
    },
  });
  const cancelImageJob = createAgentTool({
    id: "cancel_image_job",
    description: "Stop a specific scoped conversation image job only when the user requests it. Only its creator or workspace owner/admin may cancel. Never cancels another conversation or creates a retry.",
    inputSchema: z.object({ jobId: z.string().uuid() }).strict(),
    execute: async ({ jobId }) => {
      try {
        assertIdentity();
        const current = await input.jobService.getConversationImageJob(input.user, input.scope, jobId);
        if (!current) return { status: "not_found" as const, summary: "当前对话和画布范围内没有该图片任务；未取消、未重新生成。" };
        if (["succeeded", "failed", "dead_letter", "canceled"].includes(String(current.status)))
          return { jobId, status: current.status, summary: "任务已经结束，未再次取消、未重新生成；退款状态只能以服务端账务记录为准。" };
        const canceled = await input.jobService.cancelJobAdmin(input.user, jobId, input.scope);
        const terminal = ["succeeded", "failed", "dead_letter"].includes(canceled.status);
        return {
          jobId, status: canceled.status,
          summary: terminal
            ? "任务已经结束，未再次取消、未重新生成；退款状态只能以服务端账务记录为准。"
            : "已请求停止此图片任务；第三方请求是否撤销以及是否产生退款尚未确认，只能以服务端实际任务和账务结果为准。未重新生成。",
        };
      } catch (error) { return failure(error); }
    },
  });
  return { getImageStatus, cancelImageJob };
}
