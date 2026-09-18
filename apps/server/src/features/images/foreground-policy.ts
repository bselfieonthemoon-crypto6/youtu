import { imageForegroundPolicySchema, type ImageForegroundPolicy } from "@loomic/shared";
import type { AvailableModel } from "../../generation/providers/registry.js";

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
type Input = { model: string; quality?: string | undefined; operation?: string | undefined; outputFormat?: string | undefined; target?: { kind: string; placement?: { role?: string | undefined; x?: number | undefined } | undefined } | null | undefined };
export function requiresTransparentForeground(input: Input): boolean {
  return (!input.operation || input.operation === "generate") && input.target?.kind === "design" && input.target.placement?.role !== "background";
}
export function foregroundUpstream(model: string, models: readonly AvailableModel[]): string {
  const entry = models.find(item => item.id === model);
  if (!entry) return fail("foreground_model_unavailable", "透明前景模型未在本工作区启用，请重新选择模型。");
  return entry.upstreamModelId ?? entry.id;
}

/** No provider call or authority creation: this quote is frozen in the user-confirmed proposal. */
export function prepareForegroundPolicy(input: Input, models: readonly AvailableModel[], price: (model: string, quality: "standard" | "hd" | "ultra") => number): ImageForegroundPolicy | undefined {
  if (!requiresTransparentForeground(input)) return;
  if (input.outputFormat && input.outputFormat !== "png") return fail("foreground_format_mismatch", "透明前景交付需要 PNG；请确认使用 PNG 后重新创建方案，未擅自改变输出格式。");
  const primaryUpstream = foregroundUpstream(input.model, models);
  const candidates = models.filter(item => (item.upstreamModelId ?? item.id) === "gpt-image-2");
  const native = primaryUpstream === "gpt-image-2";
  const selected = native ? input.model : candidates.length === 1 ? candidates[0]!.id : undefined;
  if (!selected) return fail("foreground_model_unavailable", "此画板前景需要 gpt-image-2 API 去背景，但未找到唯一可用的 gpt-image-2（不能使用 all/vip）。请管理员启用且仅保留一个对应的抠图模型配置后重新创建方案；未生成或扣费。");
  const quality = input.quality === "standard" || input.quality === "ultra" ? input.quality : "hd";
  const generationCredits = price(primaryUpstream, quality);
  const mattingCredits = native ? 0 : price("gpt-image-2", "hd");
  return imageForegroundPolicySchema.parse({ version: 1, mode: native ? "native_transparent" : "api_matting",
    generationModel: input.model, mattingModel: selected, generationCredits, mattingCredits,
    totalCredits: generationCredits + mattingCredits, pricingVersion: "credits-v1" });
}

export function validateForegroundPolicy(input: Input, policy: ImageForegroundPolicy | undefined, models: readonly AvailableModel[], price: (model: string, quality: "standard" | "hd" | "ultra") => number): ImageForegroundPolicy | undefined {
  if (!requiresTransparentForeground(input)) {
    if (policy) return fail("foreground_policy_mismatch", "当前操作不应附带额外抠图步骤，请重新创建方案。");
    return;
  }
  if (!policy) return fail("foreground_policy_required", "此旧方案没有确认透明前景处理方式与费用，请重新创建方案；未调用本地抠图或额外付费 API。");
  const parsed = imageForegroundPolicySchema.parse(policy);
  if (parsed.generationModel !== input.model || foregroundUpstream(parsed.mattingModel, models) !== "gpt-image-2")
    return fail("foreground_policy_mismatch", "前景处理模型与已确认方案不一致，请重新创建方案。");
  const expected = prepareForegroundPolicy(input, models.filter(model => (model.upstreamModelId ?? model.id) !== "gpt-image-2" || model.id === parsed.mattingModel || model.id === input.model), price);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(parsed))
    return fail("foreground_quote_changed", "透明前景处理步骤或费用已变化，请重新确认；未开始生成。");
  return parsed;
}

export function foregroundPolicyDisclosure(policy: ImageForegroundPolicy) {
  return { ...policy, providerCalls: policy.mode === "native_transparent" ? 1 : 2,
    summary: policy.mode === "native_transparent"
      ? `使用 ${policy.generationModel} 一次生成透明 PNG；${policy.totalCredits} 积分，不追加抠图调用。`
      : `先用 ${policy.generationModel} 生图，再用 ${policy.mattingModel}（gpt-image-2）API 去背景；两步共 ${policy.totalCredits} 积分。去背景可能改变主体细节。`,
    billingNote: "积分按平台配置计算；0 积分不代表供应商 API 免费。确认授权仅限本方案列出的步骤。" };
}
