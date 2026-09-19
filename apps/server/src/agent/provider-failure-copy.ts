/**
 * Chinese, user-facing wording for a failed provider job.
 *
 * `background_jobs.error_message` is written by the upstream channel and stays in
 * English ("504 Upstream model timed out. Try again later."). The execution
 * snapshot handed the model that raw string and nothing else, so a simulated user
 * asking for a billing breakdown was shown the English sentence verbatim.
 *
 * Every user-visible description must use this label. The raw message stays in
 * the row as diagnostic data (upstream request ids, `workspace:<uuid>`), never as
 * customer copy. Returns `undefined` for an unknown code so the caller can fall
 * back to a generic Chinese sentence instead of inventing a cause.
 */
export function providerFailureDescription(errorCode: string | null | undefined): string | undefined {
  switch (errorCode) {
    case "provider_rate_limited":
      return "图片渠道当前过载（429），重试多次仍未成功，本次没有生成图片";
    case "provider_rejected":
      return "可用的图片渠道明确拒绝了这次请求，本次没有生成图片";
    case "provider_unavailable":
      return "模型服务暂时不可用，本次没有生成";
    case "provider_quota_insufficient":
      return "模型服务额度不足，本次请求已停止，没有生成";
    case "image_generation_result_unknown":
      return "上游超时、结果未知；为避免重复调用和重复扣费，系统没有自动重试";
    case "local_repaint_geometry_mismatch":
    case "outpaint_geometry_mismatch":
      return "上游返回的画面尺寸与要求不一致，为避免拉伸和接缝，本次没有交付";
    case "safety_filter":
      return "内容被渠道的安全策略拦截，本次没有生成";
    case "invalid_input":
      return "请求参数不合法，本次没有提交生成";
    case "http_401":
    case "provider_snapshot_invalid":
    case "provider_snapshot_unavailable":
    case "provider_snapshot_not_found":
      return "渠道的凭据或配置无效，本次没有生成；需要管理员检查供应商配置";
    default:
      return undefined;
  }
}

/** The generic sentence to use when the code carries no specific meaning. */
export const GENERIC_PROVIDER_FAILURE_COPY = "本次生成失败，没有交付新产物";
