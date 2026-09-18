import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  nodeImageSubmissionRequestSchema,
  nodeImageSubmissionLookupSchema,
  type BackgroundJob,
  type NodeImageSubmissionLookup,
  type NodeImageSubmissionRequest,
} from "@loomic/shared";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { CreditService } from "../credits/credit-service.js";
import type { TierGuard } from "../credits/tier-guard.js";
import { imageResolutionBillingQuality } from "../credits/tier-guard.js";
import type { WorkspaceModelCatalogService } from "../providers/workspace-model-catalog-service.js";
import { getAvailableImageModels } from "../../generation/providers/registry.js";
import type { JobService } from "./job-service.js";

export class NodeImageSubmissionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

const frozenInput = (request: NodeImageSubmissionRequest) => ({
  prompt: request.prompt, model: request.model,
  aspect_ratio: request.aspect_ratio, quality: request.quality,
  ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
});

export function createNodeImageSubmissionService(options: {
  createUserClient: (token: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  jobService: JobService;
  creditService: CreditService;
  tierGuard: TierGuard;
  workspaceModelCatalogService: WorkspaceModelCatalogService;
  builtinModels?: () => Array<{ id: string }>;
}) {
  async function target(user: AuthenticatedUser, canvasId: string) {
    const client = options.createUserClient(user.accessToken);
    const { data, error } = await client.from("canvases")
      .select("id,workspace_id,project_id").eq("id", canvasId).maybeSingle();
    if (error) throw new NodeImageSubmissionError("node_submission_unavailable", "暂时无法读取画布，请稍后查询原任务。", 503);
    if (!data) throw new NodeImageSubmissionError("node_canvas_forbidden", "画布不存在或没有访问权限。", 403);
    const project = await client.from("projects").select("archived_at").eq("id", data.project_id).maybeSingle();
    if (project.error) throw new NodeImageSubmissionError("node_submission_unavailable", "暂时无法读取项目。", 503);
    if (!project.data || project.data.archived_at !== null)
      throw new NodeImageSubmissionError("node_canvas_forbidden", "项目不存在、已归档或没有访问权限。", 403);
    return data;
  }

  async function lookup(user: AuthenticatedUser, key: NodeImageSubmissionLookup) {
    const { data, error } = await (options.createUserClient(user.accessToken).from("node_image_submissions" as never) as any)
      .select("canvas_id,element_id,input,job_id").eq("created_by", user.id).eq("request_id", key.requestId).maybeSingle();
    if (error) throw new NodeImageSubmissionError("node_submission_unavailable", "暂时无法查询提交状态；请勿新建重复请求。", 503);
    if (!data) return null;
    if (data.canvas_id !== key.canvasId || data.element_id !== key.elementId)
      throw new NodeImageSubmissionError("node_submission_conflict", "请求标识已用于其他节点。", 409);
    if (!data.job_id) throw new NodeImageSubmissionError("node_submission_expired", "原任务记录已清理，此请求不能重新生成。", 410);
    const job = await options.jobService.getJob(user, data.job_id);
    if (job.created_by !== user.id || job.canvas_id !== key.canvasId || job.job_type !== "image_generation")
      throw new NodeImageSubmissionError("node_submission_conflict", "任务与原请求不一致。", 409);
    return { job, input: data.input };
  }

  return {
    async get(user: AuthenticatedUser, rawKey: unknown): Promise<{ job: BackgroundJob | null }> {
      const key = nodeImageSubmissionLookupSchema.parse(rawKey);
      await target(user, key.canvasId);
      return { job: (await lookup(user, key))?.job ?? null };
    },
    async submit(user: AuthenticatedUser, rawRequest: unknown) {
      const request = nodeImageSubmissionRequestSchema.parse(rawRequest);
      const canvas = await target(user, request.canvas_id);
      const existing = await lookup(user, {
        requestId: request.request_id, canvasId: request.canvas_id, elementId: request.element_id,
      });
      if (existing) {
        if (!isDeepStrictEqual(existing.input, frozenInput(request)))
          throw new NodeImageSubmissionError("node_submission_conflict", "同一请求不能更换提示词或模型，请先查询原任务。", 409);
        return { job: existing.job, replayed: true };
      }
      let upstreamModel = request.model;
      let providerRevision: number | null = null;
      if (request.model.startsWith("workspace:")) {
        const resolved = await options.workspaceModelCatalogService.resolvePublishedModel(user, canvas.workspace_id, request.model, "image");
        if (!resolved?.capabilities.includes("image_generation"))
          throw new NodeImageSubmissionError("node_model_unavailable", "当前节点选用的图片模型不可用，请重新选择；未自动更换模型。", 409);
        upstreamModel = resolved.upstreamModelId;
        providerRevision = resolved.revision;
      } else if (!(options.builtinModels ?? getAvailableImageModels)().some(model => model.id === request.model)) {
        throw new NodeImageSubmissionError("node_model_unavailable", "当前节点选用的图片模型不可用；未自动更换模型。", 409);
      }
      const subscription = await options.creditService.getSubscription(canvas.workspace_id);
      options.tierGuard.checkModelAccess(subscription.plan, upstreamModel);
      const billingQuality = imageResolutionBillingQuality(request.resolution, request.quality);
      options.tierGuard.checkResolution(subscription.plan, billingQuality);
      await options.tierGuard.checkConcurrency(canvas.workspace_id, subscription.plan);
      const cost = options.tierGuard.calculateCreditCost(upstreamModel, "image_generation", { quality: billingQuality, ...(request.resolution ? { imageResolution: request.resolution } : {}) });
      // The RPC owns creation, provider snapshot, ledger debit, placeholder update
      // and enqueue in ONE transaction. A lost HTTP response can only replay it.
      const { data, error } = await (options.getAdminClient().rpc as any)("loomic_submit_node_image", {
        p_user: user.id, p_request: request.request_id, p_canvas: request.canvas_id,
        p_element: request.element_id, p_input: frozenInput(request), p_cost: cost,
        p_provider_revision: providerRevision, p_upstream_model: providerRevision === null ? null : upstreamModel,
      });
      if (error) throw mapSubmissionError(error);
      const result = z.object({ job_id: z.string().uuid(), replayed: z.boolean() }).strict().safeParse(data);
      if (!result.success) throw new NodeImageSubmissionError("node_submission_unavailable", "提交结果暂时无法确认，请查询原请求，不要重复生成。", 503);
      return { job: await options.jobService.getJob(user, result.data.job_id), replayed: result.data.replayed };
    },
  };
}

function mapSubmissionError(error: { message?: string }) {
  const message = error.message ?? "";
  const known: Array<[string, string, number]> = [
    ["node_canvas_forbidden", "没有修改此画布的权限，或项目已归档。", 403],
    ["node_not_saved", "节点尚未保存，请保存画布后使用原请求重试。", 409],
    ["node_submission_conflict", "节点或请求已变化，请检查原任务，未提交新的生成。", 409],
    ["node_generation_active", "该节点已有生成任务，请等待原任务完成。", 409],
    ["node_model_changed", "模型配置已变化，请重新确认；本次没有扣费或入队。", 409],
    ["node_submission_expired", "原任务记录已清理，此请求不能重新生成。", 410],
    ["node_submission_invalid", "节点生成请求无效。", 400],
    ["insufficient_credits", "积分不足，本次没有提交生成任务。", 402],
  ];
  const matched = known.find(([code]) => message.includes(code));
  return matched ? new NodeImageSubmissionError(...matched)
    : new NodeImageSubmissionError("node_submission_unavailable", "提交结果暂时无法确认，请查询原请求；未自动重新生图。", 503);
}

export type NodeImageSubmissionService = ReturnType<typeof createNodeImageSubmissionService>;
