import type { ImageGenerateInput } from "../../agent/tools/image-generate.js";
import { namedImageCancellationSubject, matchesNamedImageCancellation } from "../../agent/tools/named-image-cancellation.js";
import { designJobTargetSchema, imageForegroundPolicySchema } from "@loomic/shared";
import { z } from "zod";
import { imageReferenceHash, verifyImageProposalSources } from "../../agent/image-proposal-sources.js";
import { imageGenerationModelConstraintSchema } from "../../agent/tools/image-generate.js";

// Re-validate durable input after restart. Unknown operations must not become
// ordinary image generation, and old proposals without an operation remain valid.
export const imageProposalInputSchema = z.object({
  operation: z.enum(["generate", "remove_background"]).default("generate"),
  title: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  aspectRatio: z.string().optional(),
  quality: z.string().optional(),
  outputFormat: z.enum(["png", "jpg", "webp"]).optional(),
  inputImages: z.array(z.string()).optional(),
  inputImageSources: z.array(z.object({ assetId: z.string().uuid(), referenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100).optional(),
  modelConstraint: imageGenerationModelConstraintSchema.optional(),
  sourceUsage: z.enum(["edit", "reference"]).optional(),
  aspectRatioIntent: z.enum(["preserve_source", "resize"]).optional(),
  // Shared contracts may use a different Zod major. Parse at this boundary
  // instead of nesting that schema into the server's local Zod object.
  foregroundPolicy: z.unknown().transform((value, context) => {
    const parsed = imageForegroundPolicySchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Invalid foreground policy" });
      return z.NEVER;
    }
    return parsed.data;
  }).optional(),
  placementX: z.number().finite().optional(),
  placementY: z.number().finite().optional(),
  placementWidth: z.number().positive().optional(),
  placementHeight: z.number().positive().optional(),
  target: z.unknown().transform((value, context) => {
    const parsed = designJobTargetSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Invalid design target" });
      return z.NEVER;
    }
    return parsed.data;
  }).optional(),
}).superRefine((input, context) => {
  if (input.inputImageSources && (input.inputImageSources.length !== input.inputImages?.length ||
    input.inputImageSources.some((source, index) => source.referenceHash !== imageReferenceHash(input.inputImages?.[index] ?? "")))) {
    context.addIssue({ code: "custom", path: ["inputImageSources"], message: "Frozen image source binding changed" });
  }
  if (input.operation === "remove_background") {
    if (input.inputImages?.length !== 1) context.addIssue({ code: "custom", path: ["inputImages"], message: "Background removal requires exactly one source image" });
    if (input.outputFormat !== undefined && input.outputFormat !== "png") context.addIssue({ code: "custom", path: ["outputFormat"], message: "Background removal requires PNG" });
    if (input.quality !== undefined && input.quality !== "hd") context.addIssue({ code: "custom", path: ["quality"], message: "Background removal uses fixed hd quality" });
  }
  if (input.aspectRatioIntent === "resize" && (input.sourceUsage !== "edit" || input.aspectRatio === undefined))
    context.addIssue({ code: "custom", path: ["aspectRatioIntent"], message: "Resize intent requires edit usage and an explicit ratio" });
  if (input.aspectRatioIntent === "preserve_source" && input.sourceUsage !== "edit")
    context.addIssue({ code: "custom", path: ["aspectRatioIntent"], message: "Preserve intent requires edit usage" });
  if (input.foregroundPolicy && input.outputFormat !== undefined && input.outputFormat !== "png")
    context.addIssue({ code: "custom", path: ["outputFormat"], message: "Transparent foreground delivery requires PNG" });
}).transform((input) => input.operation === "remove_background"
  ? { ...input, outputFormat: "png" as const, quality: "hd" as const }
  : input.foregroundPolicy
    ? { ...input, outputFormat: "png" as const }
    : input);

export type StoredImageProposal = {
  id: string;
  input: ImageGenerateInput;
  status: string;
  originRunId?: string;
  createdAt?: string;
};

function parseStoredProposal(data: any): StoredImageProposal {
  const parsed = imageProposalInputSchema.parse(data?.input);
  const input = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as ImageGenerateInput;
  const originRunId = data?.origin_run_id == null ? undefined : z.string().uuid().parse(data.origin_run_id);
  const createdAt = data?.created_at == null ? undefined : z.string().datetime({ offset: true }).parse(data.created_at);
  return {
    id: z.string().uuid().parse(data?.id),
    status: z.string().parse(data?.status),
    input,
    ...(originRunId ? { originRunId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export type ImageProposalContext = {
  access_token: string;
  user_id: string;
  canvas_id: string;
  session_id: string;
  run_id: string;
};

export function createImageProposalStore(
  createClient: (token: string) => any,
  /** Service-role client for the exact-proposal decision RPC. Required by
   * `decide`; the legacy `loomic_decide_image` grant is service-role only. */
  getAdminClient?: () => any,
) {
  function client(context: ImageProposalContext) {
    if (
      !context.access_token ||
      !context.session_id ||
      !context.canvas_id ||
      !context.run_id
    )
      throw new Error("缺少对话身份，未提交图片任务，请重新打开对话。");
    return createClient(context.access_token);
  }
  return {
    async verifySources(context: ImageProposalContext, input: ImageGenerateInput) {
      return verifyImageProposalSources(client(context), input);
    },
    async namedCancellation(context: ImageProposalContext, prompt: unknown) {
      const subject = namedImageCancellationSubject(prompt);
      if (!subject) return null;
      const { data, error } = await client(context).from("image_generation_proposals")
        .select("id,input,status,origin_run_id,created_at")
        .eq("session_id", context.session_id).eq("canvas_id", context.canvas_id).eq("created_by", context.user_id)
        .eq("status", "pending").order("created_at", { ascending: false }).limit(101);
      if (error) throw new Error("image_proposal_query_failed");
      if (!Array.isArray(data) || data.length >= 101) return null;
      const matches = data.map(parseStoredProposal).filter(proposal => matchesNamedImageCancellation(subject, proposal.input.title));
      return matches.length === 1 ? matches[0]! : null;
    },
    async latest(context: ImageProposalContext) {
      const { data, error } = await client(context)
        .from("image_generation_proposals")
        .select("id,input,status,origin_run_id,created_at")
        .eq("session_id", context.session_id)
        .eq("canvas_id", context.canvas_id)
        .eq("created_by", context.user_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("读取图片方案失败，请稍后重试。");
      return data ? parseStoredProposal(data) : null;
    },
    /**
     * Resolve the proposal discussed by the current requirement, rather than
     * merely the newest historical row in the session. Confirmation-only user
     * turns do not change the requirement, so repeated confirmation can safely
     * replay the same confirmed job. Any intervening non-decision user message
     * makes the proposal ineligible and forces the Agent to freeze a new plan.
     */
    async latestForCurrentRequirement(context: ImageProposalContext) {
      const { data, error } = await client(context).rpc(
        "loomic_get_current_image_proposal",
        {
          p_session: context.session_id,
          p_canvas: context.canvas_id,
          p_run: context.run_id,
        },
      );
      if (error) throw new Error("读取当前图片需求失败，请稍后重试。");
      return data ? parseStoredProposal(data) : null;
    },
    async propose(
      context: ImageProposalContext,
      input: ImageGenerateInput,
      details: Record<string, unknown>,
    ) {
      const { data, error } = await client(context).rpc(
        "loomic_propose_image",
        {
          p_session: context.session_id,
          p_canvas: context.canvas_id,
          p_run: context.run_id,
          p_input: imageProposalInputSchema.parse(input),
          p_details: details,
        },
      );
      if (error) throw new Error("保存图片方案失败，未开始生成。请稍后重试。");
      return {
        confirmationId: data.id,
        canvasId: context.canvas_id,
        kind: "image_generation",
        details: data.details,
        expiresAt: data.expires_at,
      };
    },
    async decide(
      context: ImageProposalContext,
      id: string,
      decision: "confirm" | "cancel",
    ) {
      // Exact-proposal decisions bypass the current-requirement guard by design,
      // so they must not be reachable from an authenticated client. Use the
      // service-role RPC with the authenticated actor id instead.
      if (!getAdminClient) throw new Error("方案确认服务不可用，请稍后重试。");
      const { data, error } = await getAdminClient().rpc(
        "loomic_decide_image_service",
        {
          p_id: id,
          p_user: context.user_id,
          p_session: context.session_id,
          p_canvas: context.canvas_id,
          p_run: context.run_id,
          p_decision: decision,
        },
      );
      if (error)
        throw new Error(
          "方案已失效、已更新或不属于本对话，请重新读取最新方案再确认。",
        );
      return parseStoredProposal(data);
    },
    async decideCurrent(
      context: ImageProposalContext,
      id: string,
      decision: "confirm" | "cancel",
    ) {
      const { data, error } = await client(context).rpc(
        "loomic_decide_current_image",
        {
          p_id: id,
          p_session: context.session_id,
          p_canvas: context.canvas_id,
          p_run: context.run_id,
          p_decision: decision,
        },
      );
      if (error)
        throw new Error(
          "确认时无法校验当前图片需求，旧方案未提交。请稍后重试。",
        );
      return data ? parseStoredProposal(data) : null;
    },
    async job(context: ImageProposalContext, id: string) {
      const { data, error } = await client(context)
        .from("background_jobs")
        .select("id,status,error_code,error_message,attempt_count,max_attempts,result,payload")
        .eq("id", id)
        .eq("created_by", context.user_id)
        .eq("session_id", context.session_id)
        .eq("canvas_id", context.canvas_id)
        .maybeSingle();
      if (error)
        throw new Error("读取图片任务失败，请重试确认；不会重复创建任务。");
      return data;
    },
    async retryDefiniteFailure(context: ImageProposalContext, id: string) {
      const { data, error } = await client(context).rpc(
        "loomic_retry_definite_image_failure",
        {
          p_id: id,
          p_session: context.session_id,
          p_canvas: context.canvas_id,
          p_run: context.run_id,
        },
      );
      if (error) throw new Error("无法安全创建图片重试任务；旧任务未被改写，也没有重复扣费。");
      return data ? parseStoredProposal(data) : null;
    },
  };
}
export type ImageProposalStore = ReturnType<typeof createImageProposalStore>;
