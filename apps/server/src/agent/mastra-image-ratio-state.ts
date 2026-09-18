import {
  approximateImageSizeAuthorized,
  explicitImageGenerationAspectRatio,
  imageAspectRatioTextIntent,
  imageAspectRatiosEqual,
  isStandardAspectRatio,
  normalizeImageGenerationAspectRatioProposal,
  ratioMatchesAnyOf,
} from "./image-ratio-intent.js";

export type NativeImageUsage = "independent" | "edit" | "reference";
type Frame = { aspectRatio?: string; intent: "preserve_source" | "resize";
  ratioSource: "explicit_ui" | "user_request" | "inferred_default" };

/** Current request choices survive source binding; model hints never authorize an edit. */
export type ResolvedNativeImageRatio = {
  usage: NativeImageUsage;
  frame: Frame;
  independentFrame: Frame;
  sourceFrame: Frame;
  approximation: { skillLoaded: boolean; authorized: boolean; applied: boolean; targetRatio?: string };
};

function validRatio(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(":").map(Number);
  return parts.length === 2 && parts.every(part => Number.isFinite(part) && part > 0);
}

/** Exclude dimensions describing the source rather than the requested output. */
function outputRatioText(value: unknown): string {
  if (typeof value !== "string") return "";
  const numeric = "(?:\\d{1,5}\\s*[:：]\\s*\\d{1,5}|\\d{2,5}\\s*[x×*]\\s*\\d{2,5})";
  return value
    .replace(new RegExp(`(?:这个|这(?:一)?张|那(?:一)?张|原(?:始)?图|源图|现有图片|\\bthis|\\bexisting|\\boriginal|\\bsource)\\s*(?:(?:图(?:片)?|image|photo)\\s*)?(?:是|的|为|的?比例(?:是|为)?|is)?\\s*${numeric}(?:\\s*(?:的)?(?:图(?:片)?|image|photo))?`, "gi"), "源图")
    .replace(new RegExp(`\\bthe\\s+${numeric}\\s+(?:image|photo)`, "gi"), "源图")
    .replace(new RegExp(`(?:把|将)\\s*${numeric}\\s*(?:的)?图(?:片)?`, "gi"), "源图")
    .replace(new RegExp(`${numeric}\\s*(?:的)?(?:源图|原图|source image|original image)`, "gi"), "源图");
}

function hasOutputFrameRequest(text: string): boolean {
  // A numeric output specification is sufficient. A bare model resize hint is not.
  return /(?:改(?:成|为|到)|换(?:成|为)|调整|变(?:成|为)|改用|尺寸|比例|输出|生成|做(?:成|一张)|制作|裁切|裁剪|扩图|扩展|横幅|竖版|横版|resize|reframe|crop|outpaint|output|generate|make|convert|aspect\s*ratio|dimensions?|size|(?:change|turn)[^,;]{0,40}\bto\s*\d)/i.test(text)
    && !/(?:比例不变|尺寸不变|保持.{0,6}(?:比例|尺寸)|保留.{0,6}(?:比例|尺寸)|不要.{0,8}(?:改|换|调整).{0,4}(?:比例|尺寸)|keep.{0,15}(?:ratio|dimensions?|size)|preserve.{0,15}(?:ratio|dimensions?|size))/i.test(text);
}

export function resolveNativeImageRatio(input: {
  args: Record<string, unknown>; preference: unknown; userPrompt: unknown;
  usage: NativeImageUsage; skillLoaded: boolean;
  /** Custom sizes the user established earlier in the same series (continuation). */
  seriesSizes?: readonly string[];
}): { ok: true; state: ResolvedNativeImageRatio } | { ok: false; code: string; error: string } {
  const { args, usage } = input;
  const supplied = validRatio(args.aspectRatio) ? args.aspectRatio : undefined;
  const authorized = approximateImageSizeAuthorized(input.userPrompt)
    || ratioMatchesAnyOf(supplied, input.seriesSizes);
  if (args.aspectRatioIntent === "approximate" && !authorized) return {
    ok: false, code: "image_approximation_not_authorized",
    error: "本轮没有近似授权，不能把用户要求的比例改成其它比例。若目标比例超出 3:1/1:3，需要用户明确接受近似，或原话直接给出该像素尺寸（如 658×176）；未提交或扣费。",
  };
  const text = outputRatioText(input.userPrompt);
  const textIntent = imageAspectRatioTextIntent(text);
  const frameRequested = hasOutputFrameRequest(text);
  const semanticResize = args.aspectRatioIntent === "resize" && supplied && frameRequested
    && [...text.matchAll(/(\d{1,5})\s*[:：]\s*(\d{1,5})/g)]
      .some(match => imageAspectRatiosEqual(supplied, `${match[1]}:${match[2]}`));
  // Keep the normalizer's defaults and validation for independent/reference
  // output, while retaining the request authority separately from the frame.
  const normalized = normalizeImageGenerationAspectRatioProposal({ ...args,
    ...(semanticResize ? {} : { aspectRatioIntent: args.aspectRatioIntent === "approximate" ? "approximate" : undefined }),
  }, input.preference, text, { allowSemanticResize: true, allowLoadedSkillApproximation: input.skillLoaded,
    ...(input.seriesSizes ? { seriesSizes: input.seriesSizes } : {}) });
  if (!normalized.ok) return normalized;
  const uiRatio = explicitImageGenerationAspectRatio(input.preference);
  const targetRatio = textIntent.aspectRatio;
  // Any non-preset output ratio (from the current text or a remembered series
  // size) needs the nonstandard-size Skill loaded — even inside 1:3–3:1 — so its
  // sizing rules are actually followed instead of silently bypassed.
  const customFrameRequested = Boolean(!uiRatio && (
    (frameRequested && targetRatio && !isStandardAspectRatio(targetRatio))
    || (supplied && (frameRequested || ratioMatchesAnyOf(supplied, input.seriesSizes)) && !isStandardAspectRatio(supplied))
  ));
  if (customFrameRequested && !input.skillLoaded) return {
    ok: false, code: "image_nonstandard_size_skill_required",
    error: "本轮请求是非标准比例，需要先调用 list_skills 与 use_skill 读取 nonstandard-image-size 技能，再按其规则提交；未提交或扣费。",
  };
  const target = validRatio(targetRatio) ? Number(targetRatio.split(":")[0]) / Number(targetRatio.split(":")[1]) : undefined;
  const approximationApplied = !uiRatio && args.aspectRatioIntent === "approximate" && input.skillLoaded && authorized
    && supplied !== undefined && target !== undefined && targetRatio !== undefined
    && imageAspectRatiosEqual(supplied, target > 3 ? "3:1" : target < 1 / 3 ? "1:3" : targetRatio);
  const requestedRatio = args.operation === "remove_background" ? undefined : uiRatio ?? (approximationApplied ? supplied
    : frameRequested ? (semanticResize && textIntent.ambiguous ? supplied : targetRatio) : undefined);
  const independentFrame: Frame = {
    ...(typeof normalized.args.aspectRatio === "string" ? { aspectRatio: normalized.args.aspectRatio } : {}),
    intent: "resize",
    ratioSource: uiRatio ? "explicit_ui" : targetRatio || semanticResize ? "user_request" : "inferred_default",
  };
  const sourceFrame: Frame = requestedRatio
    ? { aspectRatio: requestedRatio, intent: "resize", ratioSource: uiRatio ? "explicit_ui" : "user_request" }
    : { intent: "preserve_source", ratioSource: "inferred_default" };
  return { ok: true, state: { usage, independentFrame, sourceFrame,
    frame: usage === "edit" ? sourceFrame : independentFrame,
    approximation: { skillLoaded: input.skillLoaded, authorized, applied: approximationApplied,
      ...(targetRatio ? { targetRatio } : {}) },
  } };
}

export function bindNativeImageRatioUsage(state: ResolvedNativeImageRatio, usage: NativeImageUsage): ResolvedNativeImageRatio {
  return { ...state, usage, frame: usage === "edit" ? state.sourceFrame : state.independentFrame };
}

export function nativeImageRatioArgs(args: Record<string, unknown>, state: ResolvedNativeImageRatio): Record<string, unknown> {
  const { aspectRatio: _ratio, aspectRatioIntent: _intent, ...other } = args;
  return { ...other, ...(state.frame.aspectRatio ? { aspectRatio: state.frame.aspectRatio } : {}),
    aspectRatioIntent: state.frame.intent,
    ...(state.usage === "independent" ? {} : { sourceUsage: state.usage }) };
}
