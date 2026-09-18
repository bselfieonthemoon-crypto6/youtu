import { isNativeGptImageModel } from "@loomic/shared";

/** Current user text only. Prompts, history and model proposals cannot grant paid tiers. */
export const MASTRA_IMAGE_DEFAULT_RUN_LIMIT = 4;
export const MASTRA_IMAGE_HARD_RUN_LIMIT = 8;

export function mastraImageDefaultRunLimit(value: unknown = process.env.LOOMIC_IMAGE_RUN_LIMIT): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MASTRA_IMAGE_DEFAULT_RUN_LIMIT
    ? parsed : MASTRA_IMAGE_DEFAULT_RUN_LIMIT;
}

export function imageAuthorizationText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Quoted/copied instructions are evidence, not a current paid-tier selection.
  return value.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "")
    .replace(/[“「『][\s\S]*?[”」』]/g, "").replace(/"[^"\n]*"/g, "");
}

function authorized(text: string, tier: RegExp): boolean {
  const clauses = text.split(/[。！？!?;；\n]/);
  return clauses.some(original => {
    const clause = original.replace(/(?:[124]\s*k|high|medium|hd|ultra)\s*(?:参考图|原图|素材|reference|source)/gi, "");
    if (/(?:为什么|为何|检查|参数|讨论|解释|是否|吗|why\b|check\b|explain\b|whether\b)/i.test(clause)) return false;
    const occurrence = tier.exec(clause);
    if (!occurrence) return false;
    const prefix = clause.slice(0, occurrence.index);
    const suffix = clause.slice(occurrence.index + occurrence[0].length);
    // A negation blocks only when it governs this exact tier token, so an
    // unrelated "不要背景" in the same clause does not revoke a "2K" request.
    if (/(?:不要|不需要|不使用|别用|禁止|勿|无需|不升级|不允许|do\s+not|don['’]t|without|never)\s*[^,，]{0,8}$/i.test(prefix)
      || /^\s*[^,，]{0,8}(?:不要|不需要|别|禁止|勿|无需|不允许)/i.test(suffix)) return false;
    if (/high|ultra|medium|hd|质量|画质/i.test(occurrence[0])) {
      if (/^\s*(?:contrast|[- ]?sized?|3d|风格|style)/i.test(suffix)) return false;
      return /(?:quality|画质|质量)(?:档位)?\s*[:：=]?\s*$/i.test(prefix)
        || /(?:使用|选用|选择|用|use|select|choose)\s*$/i.test(prefix)
        || /^\s*$/.test(prefix) && /^(?:\s*(?:quality|画质|质量|档|[+＋,，/]|$))/i.test(suffix)
        || /^(?:\s*(?:quality|画质|质量))/.test(suffix) && /(?:生成|制作|输出|做|generate|create|make|produce|output|render)\s*[^,，]{0,24}$/i.test(prefix);
    }
    return /(?:生成|制作|输出|做|给我|使用|选用|选择|用|generate|create|make|produce|use|output|render)\s*[^,，]{0,24}$/i.test(prefix)
      || /(?:quality|resolution|画质|质量|分辨率)(?:档位)?\s*[:：=]\s*$/i.test(prefix)
      || /^\s*(?:(?:low|standard|high|medium|ultra|hd)\s*[+＋,，/]\s*)?$/i.test(prefix);
  });
}

export function mastraImageExecutionPolicy(currentUserText: unknown, configuredLimit?: unknown) {
  const text = imageAuthorizationText(currentUserText);
  const requestedCount = currentUserImageOutputCount(text);
  return {
    medium: authorized(text, /\b(?:medium|hd)\b|中(?:等|档)质量|中等画质/i),
    high: authorized(text, /\b(?:high|ultra)\b|高(?:等|档)?质量|高画质/i),
    resolution2k: authorized(text, /\b2\s*k\b/i),
    resolution4k: authorized(text, /\b4\s*k\b/i),
    requestedCount,
    limit: Math.min(requestedCount ?? mastraImageDefaultRunLimit(configuredLimit), MASTRA_IMAGE_HARD_RUN_LIMIT),
  };
}

export function currentUserImageOutputCount(text: string): number | undefined {
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const countPattern = /([0-9]{1,3}|[一二两三四五六七八九十])\s*(?:张|幅|个(?:图片|版本|方案)|images?\b|outputs?\b|pictures?\b)/gi;
  let total = 0;
  let found = false;
  for (const clause of text.split(/[。！？!?;；\n]/)) {
    if (/(?:不要|不需要|别|禁止|勿|无需|为什么|检查|讨论|解释|是否|吗|why\b|check\b|explain\b|do\s+not|don['’]t)/i.test(clause)) continue;
    const directive = /(?:生成|制作|输出|给我|做|generate|create|make|produce)/i.exec(clause);
    if (!directive) continue;
    const totalMatch = /(?:一共|总共|合计|共|总计|in\s+total|total(?:\s+of)?)\s*(?:生成|制作|输出|generate|create|make|produce)?\s*(?:exactly\s*)?([0-9]{1,3}|[一二两三四五六七八九十])\s*(?:张|幅|images?\b|outputs?\b|pictures?\b)/i.exec(clause);
    if (totalMatch) return cn[totalMatch[1]!] ?? Number(totalMatch[1]);
    const outputs = clause.slice(directive.index + directive[0].length);
    for (const match of outputs.matchAll(countPattern)) {
      const before = outputs.slice(0, match.index);
      const after = outputs.slice(match.index! + match[0].length);
      if (/^\s*(?:参考|原图|素材|上传|输入|reference|source|input)/i.test(after)
        || /(?:每张|包含|元素|参考|上传|input|reference|each)[^,，和及]{0,12}$/i.test(before)) continue;
      total += cn[match[1]!] ?? Number(match[1]);
      found = true;
    }
  }
  return found ? total : undefined;
}

export function validateMastraImageExecution(input: { operation?: string; quality?: string; resolution?: string }, currentUserText: unknown) {
  const policy = mastraImageExecutionPolicy(currentUserText);
  if (policy.requestedCount !== undefined && (policy.requestedCount < 1 || policy.requestedCount > MASTRA_IMAGE_HARD_RUN_LIMIT))
    return { code: "image_generation_requested_count_unsupported", summary: "本轮明确输出数量须为 1–8 张。未创建任务、未扣费；请调整数量。" };
  if (input.quality === "hd" && !policy.medium || input.quality === "ultra" && !policy.high)
    return { code: "image_quality_not_authorized", summary: "本轮用户原文未明确授权该质量档位。未创建任务、未扣费；2K/4K、透明背景或画面细节不代表更高质量授权。" };
  if (input.resolution === "2k" && !policy.resolution2k || input.resolution === "4k" && !policy.resolution4k)
    return { code: "image_resolution_not_authorized", summary: "本轮用户原文未明确授权该分辨率。未创建任务、未扣费；质量档位与 1K/2K/4K 分辨率分别授权。" };
  if (input.quality !== undefined && !["standard", "hd", "ultra"].includes(input.quality)
    || input.resolution !== undefined && !["1k", "2k", "4k"].includes(input.resolution))
    return { code: "image_execution_tier_invalid", summary: "图片质量或分辨率档位无效。未创建任务、未扣费。" };
  if (input.operation === "remove_background" && (input.quality !== "hd" || input.resolution !== undefined && input.resolution !== "1k"))
    return { code: "image_legacy_background_removal_contract_required", summary: "旧去背景执行器固定使用 Medium + 1K。未创建任务、未扣费；请对同一已授权源图使用 edit_image，operation=generate、background=transparent、outputFormat=png，按用户已授权的质量和分辨率输出，无需重复确认。" };
  return null;
}

export function mastraImageRunLimitReceipt(limit: number) {
  return { status: "failed" as const, error: "image_generation_run_limit", limit,
    summary: `本轮图片生成与编辑共用 ${limit} 张额度，已达到上限；未创建新任务、未扣费。请在新的用户请求中明确下一批输出。` };
}

/** Known OpenAI legacy preset/gateway branches do not forward pixel tiers. */
export function validateMastraImageResolutionSupport(model: string, resolution: string | undefined) {
  if (resolution && resolution !== "1k" && /^gpt-image-/i.test(model)
    && !isNativeGptImageModel(model))
    return { code: "image_resolution_not_supported", summary: "所选图片模型的当前执行器未传递该分辨率档位。未创建任务、未扣费；请使用支持该分辨率的模型，或明确改用 1K。" };
  return null;
}
