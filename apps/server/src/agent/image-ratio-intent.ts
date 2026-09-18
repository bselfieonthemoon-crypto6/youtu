/**
 * Image aspect-ratio intent and frame normalization.
 *
 * Owns the pure aspect-ratio surface: reading a ratio/size out of the current
 * user text, deciding whether an approximate (nearest legal) frame was
 * authorized, normalizing the reviewed tool arguments against the current UI
 * preference, and mapping a real board shape to the nearest provider ratio.
 *
 * Why it was split out of the retired legacy image-generation tool module: both
 * the Mastra runtime (`mastra-image-tool.ts`, `mastra-image-ratio-state.ts`) and
 * the legacy proposal tool consumed exactly these pure helpers, so they must
 * outlive the deleted tool machinery. Nothing here performs IO, billing or
 * authorization on its own — the callers own those fences.
 */
import { isNativeGptImageModel, resolveNativeImageSize } from "@loomic/shared";

import type { AvailableModel } from "../generation/providers/registry.js";
import type { ImageGenerateInput } from "./image-generation-contracts.js";

const SUPPORTED_DESIGN_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
] as const;

const EXPLICIT_IMAGE_ASPECT_RATIOS = new Set<string>(
  SUPPORTED_DESIGN_ASPECT_RATIOS,
);

/** Only values from the authenticated request preference may override a proposal. */
export function explicitImageGenerationAspectRatio(
  value: unknown,
): string | undefined {
  return typeof value === "string" &&
    value !== "auto" &&
    EXPLICIT_IMAGE_ASPECT_RATIOS.has(value)
    ? value
    : undefined;
}

/**
 * Read a ratio the user wrote in the current request. This deliberately only
 * recognizes unambiguous numeric ratios/dimensions: an LLM's old tool call is
 * not user authority, while a request such as "1920 x 1080" is.
 */
export function imageAspectRatioTextIntent(value: unknown): {
  aspectRatio?: string;
  ambiguous: boolean;
} {
  if (typeof value !== "string") return { ambiguous: false };
  // A time elsewhere in the request must not suppress a later image ratio.
  const text = value.replace(/\u00d7/g, "x")
    .replace(/(?:时间|time|上午|下午|晚上)\s*\d{1,2}\s*[:：]\s*\d{2}/gi, "");
  const rawCandidates = [
    ...text.matchAll(/(?:^|[^\d])\s*(\d{2,5})\s*(?:x|\*)\s*(\d{2,5})(?:\s*(?:px|pixels?|像素))?(?!\d)/gi),
    // Do not interpret part of a grid ratio such as 1:2:1 as an image ratio.
    ...text.matchAll(/(?<![\d:：])(\d{1,5})\s*[:：]\s*(\d{1,5})(?!\s*[:：]\s*\d)/g),
  ];
  let hasNegatedCandidate = false;
  const replacements: string[] = [];
  const candidates = rawCandidates.flatMap((match) => {
    const ratio = `${Number(match[1])}:${Number(match[2])}`;
    if (parseAspectRatio(ratio) === undefined) return [];
    const groupOffset = match[0].indexOf(match[1] ?? "");
    const ratioStart = (match.index ?? 0) + Math.max(0, groupOffset);
    const prefix = text.slice(Math.max(0, ratioStart - 12), ratioStart);
    if (/(?:改(?:成|为|到)|换(?:成|为)|调整(?:成|为)|变(?:成|为)|改用|而用|\bto)\s*$/i.test(prefix)
      && !/(?:不要|别|不)[^，。；,;]{0,8}(?:改|换|调整|变)/.test(prefix)) replacements.push(ratio);
    if (/(?:不要|不(?:要|是|用)|避免|非|without|no)\s*$/i.test(prefix)) {
      hasNegatedCandidate = true;
      return [];
    }
    return [ratio];
  });
  const distinct = candidates.filter((candidate, index) =>
    candidates.slice(0, index).every((prior) => !imageAspectRatiosEqual(prior, candidate)),
  );
  const aspectRatio = distinct[0];
  const replacement = replacements.at(-1);
  if (replacement && replacements.every(item => imageAspectRatiosEqual(item, replacement)))
    return { aspectRatio: replacement, ambiguous: false };
  return !hasNegatedCandidate && distinct.length === 1 && aspectRatio
    ? { aspectRatio, ambiguous: false }
    : { ambiguous: hasNegatedCandidate || distinct.length > 1 };
}

export function explicitImageAspectRatioFromText(value: unknown): string | undefined {
  return imageAspectRatioTextIntent(value).aspectRatio;
}

/** True for the built-in preset ratios (1:1, 16:9, …), false for custom W:H. */
export function isStandardAspectRatio(value: unknown): boolean {
  return typeof value === "string"
    && SUPPORTED_DESIGN_ASPECT_RATIOS.some(preset => imageAspectRatiosEqual(preset, value));
}

/**
 * A ratio the user established earlier in the same series. Reusing it on a
 * continuation is not a substitution, so it authorizes the custom frame without
 * restating the size.
 */
export function ratioMatchesAnyOf(value: unknown, sizes: readonly string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalize = (ratio: string) => ratio.replace(/[x×*]/gi, ":");
  return Boolean(sizes?.some(size => imageAspectRatiosEqual(normalize(size), normalize(value))));
}

function stripNegatedPrecision(value: string): string {
  // "不用精确 / 不需要精确尺寸 / 无需原比例" negates the exact requirement, so it
  // expresses acceptance of a near size and must not trip the denial list.
  return value.replace(/(?:不用|不需要|无需|不必|不要求|不追求|不在乎|无所谓)\s*(?:精确|精准|精确尺寸|原比例|原尺寸)/g, " ");
}

/** True when the user explicitly demands exactness or forbids approximation. */
export function declinesApproximateImageSize(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const text = stripNegatedPrecision(value);
  return /(?:精确|精准|精确尺寸|原比例|原尺寸|不要近似|不要.{0,8}改(?:变)?比例|不使用非标准图片尺寸|不使用nonstandard-image-size|(?:不要|不允许|拒绝|禁止)(?:[^，。；,;]{0,8})(?:近似|差不多|偏差|改比例))/i.test(text);
}

/** Current user text alone may allow an approximation; a Skill receipt is checked separately. */
export function currentApproximateImageSizeAuthorization(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (declinesApproximateImageSize(value)) return false;
  const text = stripNegatedPrecision(value);
  // The Skill's own trigger is "差不多尺寸" or "接近比例", so near-ratio wording
  // such as "比例尽量接近" is an authorization, not a precise request.
  return /(?:差不多|尽量靠近|尽量接近|尽量贴近|尽可能接近|越接近越好|接近就行|接近就可以|接近比例|比例接近|允许.{0,6}偏差|差一点没关系|近似|大致|approximate|nonstandard-image-size|非标准图片尺寸)/i.test(text);
}

/**
 * A user who states an explicit pixel size/ratio outside the native 1:3–3:1
 * range has already told us the exact target; the server may use the nearest
 * legal canvas (with centered-band padding and a disclosed crop) without a
 * magic phrase.
 */
export function explicitOutOfRangePixelSize(value: unknown): boolean {
  const intent = imageAspectRatioTextIntent(value);
  if (!intent.aspectRatio) return false;
  const [widthPart, heightPart] = intent.aspectRatio.split(":");
  const width = Number(widthPart);
  const height = Number(heightPart);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return ratio > 3 || ratio < 1 / 3;
}

/**
 * Any explicit numeric size that is not one of the standard presets. Asking for
 * 358×176 (or any custom frame) is itself the choice of a non-standard ratio,
 * so the nonstandard-size flow applies without an extra acceptance phrase.
 * Standard presets such as 16:9 or 1:1 are not custom and do not authorize.
 */
export function explicitNonstandardRatio(value: unknown): boolean {
  const intent = imageAspectRatioTextIntent(value);
  if (!intent.aspectRatio) return false;
  if (explicitOutOfRangePixelSize(value)) return true;
  return !SUPPORTED_DESIGN_ASPECT_RATIOS.some(preset => imageAspectRatiosEqual(preset, intent.aspectRatio!));
}

/**
 * Phrase-based acceptance OR an explicit non-standard size/ratio. An explicit
 * demand for exactness still wins: stating 656×176 while forbidding
 * approximation must not silently authorize a substitution.
 */
export function approximateImageSizeAuthorized(value: unknown): boolean {
  return currentApproximateImageSizeAuthorization(value)
    || (explicitNonstandardRatio(value) && !declinesApproximateImageSize(value));
}

export type ImageAspectRatioNormalization =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; code: string; error: string };

/**
 * Pre-gate normalization for the current UI ratio. This is intentionally
 * pure: the durable tool repeats the checks before proposal creation, while
 * the intent gate sees the same authoritative arguments instead of stale LLM
 * values.
 */
export function normalizeImageGenerationAspectRatioProposal(
  args: Record<string, unknown>,
  preference: unknown,
  userPrompt: unknown,
  options: { allowSemanticResize?: boolean; allowLoadedSkillApproximation?: boolean; seriesSizes?: readonly string[] } = {},
): ImageAspectRatioNormalization {
  const { aspectRatio: _discardedAspectRatio, ...argsWithoutInvalidAspectRatio } = args;
  // Background removal has no output-frame choice; ratio text or a stale UI
  // selection must not turn it into a clarification failure.
  if (args.operation === "remove_background")
    return { ok: true, args: argsWithoutInvalidAspectRatio };
  const explicitAspectRatio = explicitImageGenerationAspectRatio(preference);
  if (explicitAspectRatio) return { ok: true, args: { ...args, aspectRatio: explicitAspectRatio,
    ...(args.sourceUsage === "edit" ? { aspectRatioIntent: "resize" } : {}) } };
  const textIntent = imageAspectRatioTextIntent(userPrompt);
  const suppliedApproximateRatio = typeof args.aspectRatio === "string"
    && args.aspectRatioIntent === "approximate"
    && options.allowLoadedSkillApproximation
    && (approximateImageSizeAuthorized(userPrompt) || ratioMatchesAnyOf(args.aspectRatio, options.seriesSizes))
    && parseAspectRatio(args.aspectRatio) !== undefined
    ? args.aspectRatio : undefined;
  const requestedRatio = textIntent.aspectRatio ? parseAspectRatio(textIntent.aspectRatio) : undefined;
  if (suppliedApproximateRatio && requestedRatio !== undefined
    && (requestedRatio > 3 || requestedRatio < 1 / 3)
    && imageAspectRatiosEqual(suppliedApproximateRatio, requestedRatio > 3 ? "3:1" : "1:3")) {
    // Keep the opt-in marker through multiple normalization passes. The edit
    // tool treats this verified frame change as resize only at source binding.
    return { ok: true, args: { ...args, aspectRatio: suppliedApproximateRatio } };
  }
  // Native conversational tools can explicitly resolve the frame of this one
  // output (e.g. two deliverables or a source ratio plus an output ratio).
  // Do not make a numeric text scan overrule that semantic selection.
  const semanticResize = options.allowSemanticResize && args.aspectRatioIntent === "resize"
    && typeof args.aspectRatio === "string" && parseAspectRatio(args.aspectRatio) !== undefined;
  if (textIntent.ambiguous && !semanticResize) return {
    ok: false,
    code: "image_aspect_ratio_ambiguous",
    error: "文字中出现多个不一致或否定的图片比例，请明确要使用哪一个比例。",
  };
  // `auto` is a UI preference sentinel, never a provider ratio. Nor should a
  // malformed/stale string block task defaults in the durable tool.
  const rawAspectRatio = args.aspectRatio;
  if (
    typeof rawAspectRatio === "string" &&
    rawAspectRatio !== "auto" &&
    parseAspectRatio(rawAspectRatio) === undefined &&
    !explicitAspectRatio &&
    !textIntent.aspectRatio
  ) return {
    ok: false,
    code: "image_aspect_ratio_invalid",
    error: `图片比例“${rawAspectRatio}”无效，请使用如 16:9、1080:1350 的数值比例，或选择自动。`,
  };
  const suppliedAspectRatio = typeof rawAspectRatio === "string" &&
    parseAspectRatio(rawAspectRatio) !== undefined
    ? rawAspectRatio
    : undefined;
  const sanitizedArgs = suppliedAspectRatio ? args : argsWithoutInvalidAspectRatio;
  let aspectRatio = explicitAspectRatio ?? textIntent.aspectRatio;
  if (
    !aspectRatio &&
    !suppliedAspectRatio &&
    !sanitizedArgs.target &&
    !Array.isArray(sanitizedArgs.inputImages) &&
    sanitizedArgs.sourceUsage !== "edit"
  ) {
    aspectRatio = defaultImageGenerationAspectRatio({
      title: typeof sanitizedArgs.title === "string" ? sanitizedArgs.title : "",
      userRequest: typeof userPrompt === "string" ? userPrompt : "",
    });
  }
  if (!aspectRatio) return { ok: true, args: sanitizedArgs };
  const isEdit = sanitizedArgs.sourceUsage === "edit";
  return {
    ok: true,
    args: {
      ...sanitizedArgs,
      aspectRatio,
      ...(isEdit ? { sourceUsage: "edit", aspectRatioIntent: "resize" } : {}),
    },
  };
}

/** A logo is the one independent-image task where a square is a safe default. */
export function defaultImageGenerationAspectRatio(input: Pick<ImageGenerateInput, "title"> & {
  userRequest?: string;
}): string | undefined {
  const task = `${input.userRequest ?? ""}\n${input.title}`;
  if (/(?:\bbanner\b|横幅|横版封面)/i.test(task)) return "16:9";
  if (/(?:竖版|手机海报)/i.test(task)) return "9:16";
  return /(?:\blogo\b|标志|徽标|商标|图标)/i.test(task) ? "1:1" : undefined;
}

function parseAspectRatio(value: string): number | undefined {
  const parts = value.split(":");
  if (parts.length !== 2) return undefined;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? width / height
    : undefined;
}

export function imageAspectRatiosEqual(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftValue = parseAspectRatio(left);
  const rightValue = parseAspectRatio(right);
  return leftValue !== undefined &&
    rightValue !== undefined &&
    Math.abs(leftValue - rightValue) <= 1e-9;
}

/** Map a real native board shape to the nearest ratio accepted across providers. */
export function supportedImageAspectRatioForDimensions(
  width: number,
  height: number,
): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("画板尺寸无效，无法确定图片比例。");
  const target = width / height;
  let best: (typeof SUPPORTED_DESIGN_ASPECT_RATIOS)[number] =
    SUPPORTED_DESIGN_ASPECT_RATIOS[0];
  let bestDifference = Math.abs(parseAspectRatio(best)! - target);
  for (const candidate of SUPPORTED_DESIGN_ASPECT_RATIOS.slice(1)) {
    const difference = Math.abs(parseAspectRatio(candidate)! - target);
    if (difference < bestDifference) {
      best = candidate;
      bestDifference = difference;
    }
  }
  return best;
}

/** Server-side preflight: a native GPT Image model must be able to honour the frame. */
export function validateNativeImageAspectRatio(input: Pick<ImageGenerateInput, "model" | "operation" | "aspectRatio" | "resolution">, models?: readonly AvailableModel[]):
  { error: string; summary: string } | null {
  if (input.operation === "remove_background") return null;
  const upstream = models?.find(model => model.id === input.model)?.upstreamModelId ?? input.model;
  if (!isNativeGptImageModel(upstream)) return null;
  const ratio = input.aspectRatio ?? "1:1";
  try {
    resolveNativeImageSize(ratio, input.resolution ?? "1k");
    return null;
  } catch {
    return {
      error: "image_native_aspect_ratio_unsupported",
      summary: `原生图片模型无法按 ${ratio} 生成：输出比例必须在 1:3 至 3:1 之间，且能对应原生尺寸。请明确选择支持的比例后重新创建方案；未创建或提交付费任务，也未擅自裁切、拉伸或改写比例。`,
    };
  }
}
