import { z } from "zod";
import type { ImageProposalContext } from "../../features/agent-actions/image-proposal-store.js";
import { createAgentTool, runContextOf } from "./tool-run-context.js";

import { randomUUID } from "node:crypto";
import type { ImageEditRouting } from "../image-edit-routing.js";
import { captureImageProposalSources, resolveCanvasImageProposalSources, type ImageProposalSource } from "../image-proposal-sources.js";

import { type DesignJobTarget, designJobTargetSchema, type ImageForegroundPolicy, isNativeGptImageModel, resolveNativeImageSize } from "@loomic/shared";
import { foregroundPolicyDisclosure } from "../../features/images/foreground-policy.js";

import type { DestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import type { ImageProposalStore } from "../../features/agent-actions/image-proposal-store.js";
import { generateImage } from "../../generation/image-generation.js";
import { validateImageGenerationRequestLimits } from "../../generation/image-request-limits.js";
import {
  type AvailableModel,
  getAvailableImageModels,
  resolveImageProviderName,
} from "../../generation/providers/registry.js";

const DEFAULT_MODEL = "gpt-image-2-all";
const BACKGROUND_REMOVAL_MODEL = "gpt-image-2";

export function validateNativeImageAspectRatio(input: Pick<ImageGenerateInput, "model" | "operation" | "aspectRatio" | "resolution">, models?: readonly AvailableModel[]):
  Pick<ImageGenerateResult, "error" | "summary"> | null {
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

export const imageGenerationModelConstraintSchema = z.object({
  manualModelIds: z.array(z.string().min(1)).max(100).optional(),
  mentionedModelIds: z.array(z.string().min(1)).max(100).optional(),
}).strict();
export type ImageGenerationModelConstraint = z.infer<typeof imageGenerationModelConstraintSchema>;

function validateImageGenerationModelConstraint(
  model: string,
  constraint: ImageGenerationModelConstraint | undefined,
): Pick<ImageGenerateResult, "error" | "summary"> | null {
  if (constraint?.manualModelIds?.length && !constraint.manualModelIds.includes(model)) return {
    error: "image_model_preference_mismatch",
    summary: "所选图片模型不在用户本轮手动选择的模型范围内，未创建或提交生成任务。",
  };
  if (constraint?.mentionedModelIds?.length && !constraint.mentionedModelIds.includes(model)) return {
    error: "image_model_mention_mismatch",
    summary: "所选图片模型与用户本轮明确 @ 的模型不一致，未创建或提交生成任务。",
  };
  return null;
}

export type ImageGenerationModelResolution =
  | { ok: true; args: Record<string, unknown>; model: string; repaired: boolean }
  | { ok: false; code: string; error: string };

/**
 * Resolve a model-shaped tool argument against the current authenticated
 * catalog and current-turn preference constraint. Historical tool calls are
 * useful conversation context, but their model IDs are never authority.
 */
export function resolveImageGenerationModelProposal(
  args: Record<string, unknown>,
  models: readonly AvailableModel[],
  constraint?: ImageGenerationModelConstraint,
): ImageGenerationModelResolution {
  const normalizedArgs = { ...args };
  // `reference` has meaning only when at least one concrete source is bound.
  // A model can echo this flag from old context on a plain text-to-image turn;
  // remove only that structurally empty hint. Real reference requirements are
  // still checked against current user evidence by the intent gate.
  if (
    normalizedArgs.sourceUsage === "reference" &&
    Array.isArray(normalizedArgs.inputImages) &&
    normalizedArgs.inputImages.length === 0
  ) {
    delete normalizedArgs.sourceUsage;
    delete normalizedArgs.inputImages;
  } else if (
    normalizedArgs.sourceUsage === "reference" &&
    normalizedArgs.inputImages === undefined
  ) {
    delete normalizedArgs.sourceUsage;
  }
  const uniqueModels = [...new Map(models.map((model) => [model.id, model])).values()];
  if (!uniqueModels.length) return {
    ok: false,
    code: "image_model_catalog_unavailable",
    error: "当前工作区没有可用的图片模型，未保存方案或开始生成。",
  };

  const manualSpecified = constraint?.manualModelIds !== undefined;
  const manual = new Set(constraint?.manualModelIds ?? []);
  const mentioned = new Set(constraint?.mentionedModelIds ?? []);
  if (manualSpecified && !manual.size) return {
    ok: false,
    code: "image_model_preference_empty",
    error: "图片模型处于手动模式，但本轮没有选择任何模型；未自动改用其他模型，也未保存或生成图片。请先选择一个当前可用模型。",
  };
  const manualAvailable = manualSpecified
    ? uniqueModels.filter((model) => manual.has(model.id))
    : uniqueModels;
  if (manualSpecified && !manualAvailable.length) return {
    ok: false,
    code: "image_model_preference_unavailable",
    error: "用户本轮手动选择的图片模型当前不可用，未改用其他模型，也未保存或生成图片。请重新选择当前目录中的模型。",
  };
  const mentionedAvailable = mentioned.size
    ? uniqueModels.filter((model) => mentioned.has(model.id))
    : uniqueModels;
  if (mentioned.size && !mentionedAvailable.length) return {
    ok: false,
    code: "image_model_mention_unavailable",
    error: "用户本轮明确指定的图片模型当前不可用，未改用其他模型，也未保存或生成图片。请重新选择当前目录中的模型。",
  };

  let candidates = uniqueModels.filter((model) =>
    (!manualSpecified || manual.has(model.id)) &&
    (!mentioned.size || mentioned.has(model.id)));
  if (!candidates.length) return {
    ok: false,
    code: "image_model_constraint_conflict",
    error: "本轮手动选择与明确指定的图片模型没有共同候选，未保存方案或开始生成。请保留一个一致的当前模型选择。",
  };

  // Background removal has a narrower, server-known compatibility contract.
  // Do not repair it to an ordinary generation-only model.
  if (normalizedArgs.operation === "remove_background") {
    candidates = candidates.filter((model) =>
      (model.upstreamModelId ?? model.id) === BACKGROUND_REMOVAL_MODEL);
    if (!candidates.length) return {
      ok: false,
      code: "background_removal_model_required",
      error: "当前允许的图片模型中没有可用于去除背景的 gpt-image-2，未改换操作或模型，也未保存或生成图片。",
    };
  }

  const proposed = typeof normalizedArgs.model === "string" ? normalizedArgs.model.trim() : "";
  const autoSelection = !proposed || proposed.toLowerCase() === "auto";
  let selected = autoSelection
    ? candidates.find((model) => model.id === DEFAULT_MODEL) ?? candidates[0]!
    : candidates.find((model) => model.id === proposed);
  // The current authenticated UI / @mention constraint is newer authority
  // than a model-shaped argument echoed from conversation history. Only
  // repair to it when the constraint resolves to one unambiguous candidate;
  // without such current-turn authority, an unknown explicit ID fails closed.
  if (!selected && !autoSelection && candidates.length === 1
    && (manualSpecified || mentioned.size > 0)) selected = candidates[0];
  if (!selected) return {
    ok: false,
    code: "image_model_identifier_unavailable",
    error: "该图片模型不在当前工作区目录中，未改用默认模型，也未保存或生成图片。请从当前目录选择模型或使用 Auto。",
  };
  return {
    ok: true,
    args: { ...normalizedArgs, model: selected.id },
    model: selected.id,
    repaired: autoSelection && selected.id !== proposed,
  };
}

/**
 * Build the zod schema dynamically from the models available in the registry.
 * Falls back to a plain string field when no providers are registered.
 */
function buildImageGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Model to use. Available:\n${models.map((m) => `- ${m.id}${m.upstreamModelId ? ` (upstream: ${m.upstreamModelId})` : ""}: ${m.displayName} — ${m.description}`).join("\n")}\nremove_background requires upstream gpt-image-2 exactly; gpt-image-2-all/vip are not substitutes.`
    : "Model identifier (no providers currently registered)";

  // Keep parsing recoverable: the model may echo a stale ID from conversation
  // history. The current run's catalog and user preference resolve this field
  // before the intent gate and again inside the tool as defense in depth.
  const modelField = z.string().min(1).default(defaultModel).describe(modelDescription);

  return z
    .object({
      operation: z.enum(["generate", "remove_background"]).default("generate").describe(
        "generate creates/edits images. remove_background removes the background of exactly one existing source image through the gpt-image-2 API; requires PNG and user confirmation. API editing can alter subject details, so it is not pixel-exact segmentation. Never change a requested remove_background into generate when validation or model availability fails; report the failure instead.",
      ),
      title: z
        .string()
        .min(1)
        .describe(
          "Short descriptive title for the generated image, used as metadata so the image content is understood without re-analysis",
        ),
      prompt: z.string().min(1).describe("Detailed image generation prompt. For remove_background this describes the proposal; the server uses a fixed background-only edit instruction preserving all foreground objects, not semantic selection of a particular subject."),
      model: modelField,
      aspectRatio: z
        .string()
        .optional()
        .describe(
          "Aspect ratio (e.g. 1:1, 16:9, 9:16, 4:3, 3:4, 4:5, 5:4, 2:3, 3:2). Omit for sourceUsage=edit unless the user explicitly requests resizing; otherwise provider defaults to 1:1. Native GPT Image models require a ratio between 1:3 and 3:1 and never silently crop, stretch, or clamp an unsupported ratio.",
        ),
      // No schema default: an omitted quality must stay distinguishable from an
      // explicit "standard". Background removal forces hd at execution, and a
      // default would make an omitted value look like a chosen non-hd tier and
      // reject a legitimate cutout. Ordinary generation still treats undefined
      // as standard (provider low; billing defaults to standard).
      quality: z
        .enum(["standard", "hd", "ultra"])
        .optional()
        .describe(
          "Provider rendering quality, independent of pixel resolution: standard maps to low, hd to medium, ultra to high. A user request for low means standard, not an unsupported value.",
        ),
      resolution: z.enum(["1k", "2k", "4k"]).optional().default("1k")
        .describe("Native output pixel tier. Defaults to 1k; 2k and 4k affect billing independently of quality."),
      outputFormat: z
        .enum(["png", "jpg", "webp"])
        .optional()
        .describe(
          "Output image format. PNG for transparency, JPG for photos, WebP for web.",
        ),
      inputImages: z
        .array(z.string())
        .optional()
        .describe(
          "Authenticated reference asset IDs from the current turn or current canvas. For an explicitly named existing canvas image, read its assetId with inspect_canvas and pass that ID; never invent a URL or reuse a historical signed URL. Google models accept up to 14, Flux models accept 1. Imagen 4 and Recraft V3 are text-only.",
        ),
      sourceUsage: z
        .enum(["edit", "reference"])
        .optional()
        .describe(
          "How inputImages are used. edit means transform the current source image; reference means use it only as style/content guidance. For edit, omit aspectRatio to preserve the authenticated source ratio, or set aspectRatio only when the user explicitly requests resizing.",
        ),
      aspectRatioIntent: z
        .enum(["preserve_source", "resize"])
        .optional()
        .describe(
          "For sourceUsage=edit: preserve_source (default) keeps the authenticated original ratio even if an accidental aspectRatio is supplied; resize is allowed only when the user explicitly requested a new ratio and requires aspectRatio.",
        ),
      placementX: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas left edge. Omit whenever target is supplied.",
        ),
      placementY: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas top edge. Omit whenever target is supplied.",
        ),
      placementWidth: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas display width. Omit whenever target is supplied; execution defaults to 512 when needed.",
        ),
      placementHeight: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas display height. Omit whenever target is supplied; execution defaults to 512 when needed.",
        ),
      target: z
        .object({
          kind: z.literal("design"),
          design_id: z.string().uuid(),
          expected_revision: z.number().int().min(0),
          idempotency_key: z.string().uuid(),
          placement: z
            .object({
              layer_index: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .describe(
                  "Zero-based insertion index, 0 is back. Clamped to current layer count on delivery; omitted appends on top. Ignored for replacement, which preserves layer order.",
                ),
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().positive().optional(),
              height: z.number().positive().optional(),
              replace_object_id: z.string().uuid().optional(),
              fit: z.enum(["contain", "cover", "fill", "original"]).optional(),
              role: z
                .enum([
                  "background",
                  "title",
                  "subtitle",
                  "logo",
                  "product",
                  "decoration",
                ])
                .optional()
                .describe(
                  "Classify the image purpose: background ONLY for a background image; logo/product/decoration/title/subtitle for other layers. Design non-background images (including omitted role) are automatically background-removed before insertion. Do not issue another removal job.",
                ),
            })
            .strict(),
        })
        .strict()
        .optional()
        .describe(
          "Insert into an exact native design revision. Use inspect_design first.",
        ),
    })
    .superRefine((value, context) => {
      if (
        value.target &&
        (value.placementX !== undefined ||
          value.placementY !== undefined ||
          value.placementWidth !== undefined ||
          value.placementHeight !== undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "target placement and legacy canvas placement cannot be combined",
          path: ["target"],
        });
      }
      if (value.aspectRatioIntent === "resize" && (value.sourceUsage !== "edit" || value.aspectRatio === undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom,
          message: "aspectRatioIntent=resize requires sourceUsage=edit and an explicit aspectRatio",
          path: ["aspectRatioIntent"] });
      }
      if (value.aspectRatioIntent === "preserve_source" && value.sourceUsage !== "edit") {
        context.addIssue({ code: z.ZodIssueCode.custom,
          message: "aspectRatioIntent=preserve_source requires sourceUsage=edit",
          path: ["aspectRatioIntent"] });
      }
    });
}

export type ImageGenerateInput = {
  /** Internal, never accepted from the model's tool schema. */
  proposalId?: string;
  /** Server-only identity binding for frozen references; absent from model schema. */
  inputImageSources?: ImageProposalSource[];
  /** Server-only model choice authority frozen with the proposal. */
  modelConstraint?: ImageGenerationModelConstraint;
  /** Server-only execution/price quote for native-design foreground delivery. */
  foregroundPolicy?: ImageForegroundPolicy;
  operation?: "generate" | "remove_background";
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: string;
  resolution?: "1k" | "2k" | "4k";
  outputFormat?: string;
  inputImages?: string[];
  sourceUsage?: "edit" | "reference";
  aspectRatioIntent?: "preserve_source" | "resize";
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  target?: DesignJobTarget;
};

type ImageGenerateResult = {
  visualStatus?: "unverified";
  status?: "awaiting_confirmation" | "processing" | "succeeded" | "failed";
  summary: string;
  title?: string;
  elementId?: string;
  imageUrl?: string;
  assetId?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  jobId?: string;
  jobType?: "image_generation";
  billing?: GenerationBillingSummary;
  placement?: { x: number; y: number; width: number; height: number };
  confirmation?: Record<string, unknown>;
  design_id?: string;
  object_id?: string;
  revision?: number;
  finalization_status?: "completed" | "needs_attention" | "failed";
  preview_status?: "queued" | "failed" | "unavailable";
  confirmedProposal?: { id: string; title: string; aspectRatio: string };
};

export type GenerationBillingSummary = {
  estimate: number;
  charged: number;
  balanceAfter: number;
  currency: "credits";
};

/**
 * Optional function to persist a generated image to OSS.
 * Accepts the ephemeral URL and returns a persistent signed URL.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

/**
 * Submit an image generation job and wait for it to complete.
 * Returns the final result: signed_url on success, error on failure.
 */
export type SubmitImageJobFn = (input: {
  background?: "transparent" | "opaque" | "auto";
  proposalId?: string;
  /** Server-only recovery mode. Missing jobs must never be recreated. */
  replayOnly?: boolean;
  operation?: "generate" | "remove_background";
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  resolution?: "1k" | "2k" | "4k";
  outputFormat?: string;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  target?: DesignJobTarget;
  foregroundPolicy?: ImageForegroundPolicy;
}) => Promise<{
  status?: "processing" | "succeeded";
  jobId: string;
  elementId?: string;
  imageUrl?: string;
  assetId?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
  errorCode?: string;
  /** Eligibility for explicit recovery, never permission to retry automatically. */
  retryEligible?: boolean;
  billing?: GenerationBillingSummary;
  /** Server-authoritative persisted image submission receipt. */
  creditsCost?: number;
  pricingVersion?: string;
  actualQuality?: "Low" | "Medium" | "High";
  actualResolution?: "1K" | "2K" | "4K";
  design_id?: string;
  object_id?: string;
  revision?: number;
  finalization_status?: "completed" | "needs_attention" | "failed";
  preview_status?: "queued" | "failed" | "unavailable";
}>;

/** Do not degrade cutout requests into text-to-image or a different model. */
function validateBackgroundRemoval(
  input: ImageGenerateInput,
  models?: readonly AvailableModel[],
): Pick<ImageGenerateResult, "error" | "summary"> | null {
  if (input.operation !== "remove_background") return null;
  const selected = models?.find((model) => model.id === input.model);
  const upstream = models ? selected?.upstreamModelId ?? selected?.id : input.model;
  if (upstream !== BACKGROUND_REMOVAL_MODEL) return {
    error: "background_removal_model_required",
    summary: "去除背景只支持当前可用的 gpt-image-2（不带 all/vip）。请选用其工作区模型 ID；未创建任务，也不会自动替换模型。",
  };
  if (input.outputFormat !== undefined && input.outputFormat !== "png") return {
    error: "background_removal_png_required",
    summary: "去除背景必须输出带透明通道的 PNG，请将 outputFormat 设为 png；未创建任务。",
  };
  if (input.quality !== undefined && input.quality !== "hd") return {
    error: "background_removal_quality_required",
    summary: "当前去除背景执行器固定使用 hd 质量，请使用 hd；未创建任务或更改计费档位。",
  };
  const references = input.inputImages ?? [];
  if (references.length !== 1 || !isResolvedSourceImage(references[0]!)) return {
    error: "background_removal_source_required",
    summary: "去除背景需要且只能使用一张已解析的原图，不能传节点 ID、未解析附件或空图片；未创建任务。",
  };
  return null;
}

function isResolvedSourceImage(reference: string): boolean {
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/]+={0,2}$/.test(reference)) return true;
  try {
    const parsed = new URL(reference);
    return /^(https?:)$/.test(parsed.protocol) && !!parsed.hostname && !/\s/.test(reference);
  } catch {
    return false;
  }
}

export async function runImageGenerate(
  input: ImageGenerateInput,
  persistImage?: PersistImageFn,
  submitImageJob?: SubmitImageJobFn,
  attachmentMap?: Record<string, string>,
  availableModels?: readonly AvailableModel[],
  recovery?: { replayOnly: true },
): Promise<ImageGenerateResult> {
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_image] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  if (recovery?.replayOnly && (!submitImageJob || !input.proposalId)) return {
    error: "image_replay_unavailable",
    summary: "已有任务恢复服务不可用；没有重新生成或扣费。",
  };
  const modelConstraintViolation = validateImageGenerationModelConstraint(input.model, input.modelConstraint);
  if (modelConstraintViolation) return modelConstraintViolation;

  if (input.foregroundPolicy && input.outputFormat !== "png") return {
    error: "foreground_format_mismatch",
    summary: "已确认的透明前景方案必须冻结为 PNG 输出；当前方案格式不一致，未提交生成。请重新创建方案。",
  };

  if (input.target && !submitImageJob) {
    return {
      summary:
        "Image generation was not started because native design delivery is unavailable.",
      error: "design_target_delivery_unavailable",
    };
  }

  // Resolve assetId references in inputImages to base64 data URIs
  if (input.inputImages?.length && attachmentMap) {
    input = {
      ...input,
      inputImages: input.inputImages.map((ref) => attachmentMap[ref] ?? ref),
    };
  }

  if (input.operation === "remove_background" && !recovery?.replayOnly) {
    const invalid = validateBackgroundRemoval(input, availableModels);
    if (invalid) return invalid;
    if (!submitImageJob) return {
      error: "background_removal_delivery_unavailable",
      summary: "去除背景的持久化任务服务不可用，未调用 API，也不会退化为普通生图。",
    };
    input = { ...input, outputFormat: "png", quality: "hd" };
  }

  // Reference inputs are part of the user's approved proposal. Never silently
  // drop an unresolved one and turn an edit/reference request into a different
  // request with fewer (or no) source images.
  if (input.inputImages?.length) {
    const validImages = input.inputImages.filter(
      (img) =>
        img.startsWith("http://") ||
        img.startsWith("https://") ||
        img.startsWith("data:"),
    );
    if (validImages.length !== input.inputImages.length) {
      lap("filtered_invalid_refs", {
        before: input.inputImages.length,
        after: validImages.length,
        dropped: input.inputImages.filter(
          (img) =>
            !img.startsWith("http://") &&
            !img.startsWith("https://") &&
            !img.startsWith("data:"),
        ),
      });
      return {
        error: "invalid_reference_image",
        summary: "存在未解析的参考图，系统不会删除它后继续生成。请重新选择或解析每一张参考图；未提交任务或扣费。",
      };
    }
  }

  const upstreamModelId = availableModels?.find((model) => model.id === input.model)?.upstreamModelId;
  const limitViolation = validateImageGenerationRequestLimits({
    model: input.model,
    prompt: input.prompt,
    ...(upstreamModelId ? { upstreamModelId } : {}),
    ...(input.inputImages ? { inputImages: input.inputImages } : {}),
  });
  if (limitViolation) {
    return { error: limitViolation.code, summary: limitViolation.message };
  }
  if (!recovery?.replayOnly) {
    const invalidRatio = validateNativeImageAspectRatio(input, availableModels);
    if (invalidRatio) return invalidRatio;
  }

  // Job mode: submit to PGMQ and wait for worker to complete
  if (submitImageJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitImageJob({
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        ...(recovery?.replayOnly ? { replayOnly: true } : {}),
        operation: input.operation ?? "generate",
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        aspectRatio: input.aspectRatio ?? "1:1",
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
        ...(input.placementX != null ? { placementX: input.placementX } : {}),
        ...(input.placementY != null ? { placementY: input.placementY } : {}),
        ...(input.placementWidth != null
          ? { placementWidth: input.placementWidth }
          : {}),
        ...(input.placementHeight != null
          ? { placementHeight: input.placementHeight }
          : {}),
        ...(input.target
          ? { target: designJobTargetSchema.parse(input.target) }
          : {}),
        ...(input.foregroundPolicy ? { foregroundPolicy: input.foregroundPolicy } : {}),
      });

      if (jobResult.status === "processing") {
        return {
          status: "processing",
          jobId: jobResult.jobId,
          jobType: "image_generation",
          summary:
            "任务已提交，正在排队或生成。结果将自动保存并放入指定位置，请勿重复生成。",
        };
      }
      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        return {
          summary: input.operation === "remove_background"
            ? `去除背景任务已停止：${jobResult.error}。原图保留，未自动重试，也未创建替代任务。可查看该任务的失败详情；如需新的尝试，请明确要求沿用原方案重新生成，新任务仍需产品确认。`
            : `图片生成任务已停止：${jobResult.error}。未自动重试，也未创建替代任务，系统不会自行更换模型。可查看该任务的失败详情；如需新的尝试，请明确要求沿用原方案重新生成，新任务仍需产品确认。`,
          status: "failed",
          error: jobResult.error,
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "image_generation" as const,
          ...(jobResult.billing ? { billing: jobResult.billing } : {}),
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: ImageGenerateResult = {
        visualStatus: "unverified",
        ...(jobResult.status === "succeeded" ? { status: "succeeded" as const } : {}),
        summary: `图片已生成（${jobResult.width ?? 0}×${jobResult.height ?? 0}），可以继续提出修改。`,
        title: input.title,
        jobId: jobResult.jobId,
        jobType: "image_generation" as const,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        imageUrl: jobResult.imageUrl ?? "",
        ...(jobResult.assetId ? { assetId: jobResult.assetId } : {}),
        mimeType: jobResult.mimeType ?? "image/png",
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
        ...(jobResult.billing ? { billing: jobResult.billing } : {}),
        ...(jobResult.design_id ? { design_id: jobResult.design_id } : {}),
        ...(jobResult.object_id ? { object_id: jobResult.object_id } : {}),
        ...(jobResult.revision !== undefined
          ? { revision: jobResult.revision }
          : {}),
        ...(jobResult.finalization_status
          ? { finalization_status: jobResult.finalization_status }
          : {}),
        ...(jobResult.preview_status
          ? { preview_status: jobResult.preview_status }
          : {}),
      };
      if (input.placementX != null && input.placementY != null) {
        result.placement = {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 512,
          height: input.placementHeight ?? 512,
        };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: input.operation === "remove_background"
          ? `去除背景失败：${message}。原图保留，未自动换模型或重试付费任务。`
          : `Image generation failed with model ${input.model}: ${message}. Consider trying a different model or simplifying the prompt.`,
        error: message,
      };
    }
  }

  // Direct generation: resolve provider from model ID via registry
  try {
    lap("direct_generate_start", { model: input.model });
    const providerName = resolveImageProviderName(input.model);
    const result = await generateImage(providerName, {
      prompt: input.prompt,
      model: input.model,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.quality ? { quality: input.quality as any } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.outputFormat
        ? { outputFormat: input.outputFormat as any }
        : {}),
      ...(input.inputImages?.length ? { inputImages: input.inputImages } : {}),
    });
    lap("direct_generate_done", { width: result.width, height: result.height });

    let imageUrl = result.url;
    if (persistImage) {
      try {
        imageUrl = await persistImage(
          result.url,
          result.mimeType,
          input.prompt,
        );
        lap("persist_image_done");
      } catch {
        // Fall back to ephemeral URL if upload fails
      }
    }

    const directResult: ImageGenerateResult = {
      summary: `Generated image (${result.width}x${result.height}) via ${input.model}`,
      title: input.title,
      imageUrl,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
    };
    if (input.placementX != null && input.placementY != null) {
      directResult.placement = {
        x: input.placementX,
        y: input.placementY,
        width: input.placementWidth ?? 512,
        height: input.placementHeight ?? 512,
      };
    }
    return directResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Image generation failed: ${message}`,
      error: message,
    };
  }
}

export function createImageGenerateTool(deps?: {
  createUserClient?: (accessToken: string) => any;
  proposalStore?: ImageProposalStore;
  validateDesignTarget?: (
    target: NonNullable<ImageGenerateInput["target"]>,
    context: Record<string, any>,
  ) => Promise<void>;
  resolveDesignAspectRatio?: (
    target: NonNullable<ImageGenerateInput["target"]>,
    context: Record<string, any>,
  ) => Promise<string>;
  confirmationService?: DestructiveConfirmationService;
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  /** Override for testing — defaults to querying the provider registry. */
  availableModels?: AvailableModel[];
  prepareImagePipeline?: (
    input: ImageGenerateInput,
    context: Record<string, any>,
  ) => Promise<ImageGenerateInput>;
  /** Continue a newly frozen proposal through the normal confirmation tool. */
  continueConfirmedProposal?: (
    confirmationId: string,
    config: unknown,
  ) => Promise<ImageGenerateResult>;
  semanticCurrentRunImageConfirmation?: {
    runId: string;
    bindProposal: (proposalId: string) => Promise<string | null>;
  };
}) {
  const models = deps?.availableModels ?? getAvailableImageModels();

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";

  // A tool instance belongs to one run. The promise is published before the
  // first database await so concurrent/retried calls cannot freeze and submit
  // multiple proposals from one approval message. Once the confirmation tool
  // starts, its result (including an ambiguous failure) remains authoritative:
  // a retry must not spend the same approval on a new proposal.
  let explicitContinuation:
    | {
        key: string;
        promise: Promise<ImageGenerateResult>;
        confirmationStarted: boolean;
      }
    | undefined;
  const frozenProposalByRun = new Map<
    string,
    {
      inputKey: string;
      result: ImageGenerateResult;
      title: string;
      aspectRatio: string;
    }
  >();
  const proposalFreezeChainByRun = new Map<string, Promise<void>>();

  const canonicalInputKey = (input: ImageGenerateInput) => {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalize(nested)]),
        );
      return value;
    };
    return JSON.stringify(canonicalize(input));
  };

  const execute = async (
    input: ImageGenerateInput,
    runContext: Record<string, unknown>,
  ): Promise<ImageGenerateResult> => {
      const configurable = runContext as Record<string, any> & ImageProposalContext;
      let attachmentMap = configurable?.user_attachment_map as
        | Record<string, string>
        | undefined;
      const userId = configurable?.user_id;
      const canvasId = configurable?.canvas_id;
      const runId = configurable?.run_id;
      if (configurable?.image_confirmation != null) return {
        error: "image_confirmation_conflict",
        summary: "产品确认只绑定原有图片方案，不能转移到新方案；未创建或提交新的生成任务。",
      };
      const imageEdit = configurable?.image_edit_routing as ImageEditRouting | undefined;
      const parsedModelConstraint = imageGenerationModelConstraintSchema.safeParse(
        configurable?.image_generation_model_constraint,
      );
      if (configurable?.image_generation_model_constraint !== undefined && !parsedModelConstraint.success) return {
        error: "image_model_constraint_invalid",
        summary: "无法校验用户本轮选择的图片模型范围，未创建或提交生成任务。",
      };
      const modelConstraint = parsedModelConstraint.success
        ? parsedModelConstraint.data
        : undefined;
      if (models.length) {
        const resolution = resolveImageGenerationModelProposal(
          input as unknown as Record<string, unknown>,
          models,
          modelConstraint,
        );
        if (!resolution.ok) return {
          error: resolution.code,
          summary: resolution.error,
        };
        input = resolution.args as unknown as ImageGenerateInput;
      }
      const modelConstraintViolation = validateImageGenerationModelConstraint(input.model, modelConstraint);
      if (modelConstraintViolation) return modelConstraintViolation;
      if (
        !imageEdit && configurable?.active_design_id &&
        input.target?.design_id !== configurable.active_design_id
      ) {
        return {
          error: "active_design_target_required",
          summary: `当前编辑目标是画板 ${configurable.active_design_id}。请先 inspect_design，再携带该画板的 target 提交方案；未创建任务。`,
        };
      }
      const unresolvedCanvasReferences = (input.inputImages ?? []).filter(reference =>
        !captureImageProposalSources([reference], attachmentMap));
      if (unresolvedCanvasReferences.length) {
        try {
          if (!deps?.createUserClient || typeof configurable?.access_token !== "string" || typeof canvasId !== "string")
            throw new Error("canvas_reference_context_missing");
          const canvasSources = await resolveCanvasImageProposalSources({
            client: deps.createUserClient(configurable.access_token), canvasId,
            references: unresolvedCanvasReferences,
          });
          if (Object.keys(canvasSources).length !== new Set(unresolvedCanvasReferences).size)
            throw new Error("canvas_reference_not_found");
          attachmentMap = { ...(attachmentMap ?? {}), ...canvasSources };
        } catch {
          return { error: "invalid_reference_image",
            summary: "参考图必须是本轮附件或当前画布上经用户原话明确指代的真实图片；未创建方案。请先 inspect_canvas 读取对应 assetId，不要改用历史链接或纯文字替代。" };
        }
      }
      if (input.operation === "remove_background") {
        const resolved = {
          ...input,
          ...(input.inputImages ? { inputImages: input.inputImages.map((reference) => attachmentMap?.[reference] ?? reference) } : {}),
        };
        const invalid = validateBackgroundRemoval(resolved, models);
        if (invalid) return invalid;
        if (!deps?.submitImageJob) return {
          error: "background_removal_delivery_unavailable",
          summary: "去除背景的持久化任务服务不可用，未创建方案或调用 API。",
        };
        input = { ...input, outputFormat: "png", quality: "hd" };
      }
      if (imageEdit) {
        if (input.target) return {
          error: "image_edit_target_mismatch",
          summary: "本轮修改的是指定附件，不是设计画板。请移除 target，使用本轮附件生成独立图片；未创建任务，未修改画板。",
        };
        const source = attachmentMap?.[imageEdit.assetId];
        if (!source || !input.inputImages?.some((ref) => ref === imageEdit.assetId || ref === source)) return {
          error: "image_edit_source_required",
          summary: `本轮改图必须包含原图 ${imageEdit.assetId}，不能使用历史图片或退化为文生图；未创建任务。`,
        };
      }
      if (
        (!deps?.confirmationService && !deps?.proposalStore) ||
        typeof userId !== "string" ||
        typeof canvasId !== "string"
      ) {
        return {
          summary:
            "Image generation was not started because user confirmation is unavailable.",
          error: "confirmation_unavailable",
        };
      }

      // Only validated current-turn bindings above constrain the destination.
      // A design name in prose (including negations) is not target authority.
      if (input.target) {
        try {
          if (input.target.design_id === "00000000-0000-0000-0000-000000000000")
            throw new Error(
              "无效画板 ID，请先调用 list_designs、inspect_design 获取真实画板",
            );
          if (!deps.validateDesignTarget)
            throw new Error("画板校验服务不可用，未创建生成方案");
          await deps.validateDesignTarget(input.target, configurable);
        } catch (error) {
          return {
            error: "design_target_invalid",
            summary:
              error instanceof Error
                ? error.message
                : "请重新读取真实画板后生成方案",
          };
        }
      }
      const ratioNormalization = normalizeImageGenerationAspectRatioProposal(
        input as unknown as Record<string, unknown>,
        configurable?.image_generation_aspect_ratio,
        configurable?.user_prompt,
      );
      if (!ratioNormalization.ok) return {
        error: ratioNormalization.code,
        summary: ratioNormalization.error,
      };
      input = ratioNormalization.args as ImageGenerateInput;
      const explicitAspectRatio = explicitImageGenerationAspectRatio(
        configurable?.image_generation_aspect_ratio,
      );
      const textAspectRatioIntent = imageAspectRatioTextIntent(
        configurable?.user_prompt,
      );
      if (input.operation !== "remove_background" && !explicitAspectRatio && textAspectRatioIntent.ambiguous) {
        return {
          error: "image_aspect_ratio_ambiguous",
          summary: "文字中出现多个不一致的图片比例，未创建图片方案；请明确要使用哪一个比例。",
        };
      }
      const requestedAspectRatio = textAspectRatioIntent.aspectRatio;
      if (input.operation !== "remove_background" && explicitAspectRatio) {
        input = { ...input, aspectRatio: explicitAspectRatio };
        if (imageEdit || input.sourceUsage === "edit") {
          input = {
            ...input,
            sourceUsage: "edit",
            aspectRatioIntent: "resize",
          };
        }
      } else if (input.operation !== "remove_background" && requestedAspectRatio) {
        input = { ...input, aspectRatio: requestedAspectRatio };
        if (imageEdit || input.sourceUsage === "edit") {
          input = {
            ...input,
            sourceUsage: "edit",
            aspectRatioIntent: "resize",
          };
        }
      } else if (
        input.operation !== "remove_background" &&
        input.target &&
        deps?.resolveDesignAspectRatio
      ) {
        try {
          input = {
            ...input,
            aspectRatio: await deps.resolveDesignAspectRatio(
              input.target,
              configurable,
            ),
          };
        } catch (error) {
          return {
            error: "design_aspect_ratio_unavailable",
            summary:
              error instanceof Error
                ? error.message
                : "无法读取目标画板比例，未创建生成方案。",
          };
        }
      }
      // A short follow-up such as "可以" has no new task-shape authority. In
      // that case retain the reviewed tool ratio rather than reapplying a logo
      // default and erasing an earlier user-requested 16:9/9:16 constraint.
      const currentRequestHasTaskShape = /(?:\blogo\b|标志|徽标|商标|图标|\bbanner\b|横幅|横版封面|竖版|手机海报)/i
        .test(String(configurable?.user_prompt ?? ""));
      const taskDefaultAspectRatio = currentRequestHasTaskShape
        ? defaultImageGenerationAspectRatio({
          title: input.title,
          userRequest: String(configurable?.user_prompt ?? ""),
        })
        : undefined;
      // Defaults only fill a missing ratio. A supplied valid ratio may carry
      // prior user evidence that is not present in this turn's short prompt,
      // so the tool must not clobber it after the intent gate has approved it.
      if (
        input.operation !== "remove_background" &&
        !explicitAspectRatio &&
        !requestedAspectRatio &&
        !input.aspectRatio &&
        !input.target &&
        !input.inputImages?.length &&
        !(imageEdit || input.sourceUsage === "edit") &&
        taskDefaultAspectRatio
      ) {
        input = { ...input, aspectRatio: taskDefaultAspectRatio };
      }
      if (
        input.operation !== "remove_background" &&
        !input.aspectRatio &&
        !input.inputImages?.length
      ) {
        if (!taskDefaultAspectRatio) {
          return {
            error: "image_aspect_ratio_required",
            summary: "独立新图片尚未指定横竖比例。请说明用途或选择图片比例后再创建方案；未按默认 1:1 生成。",
          };
        }
        input = { ...input, aspectRatio: taskDefaultAspectRatio };
      }
      const pipelineBase = structuredClone(input);
      delete pipelineBase.foregroundPolicy;
      if (deps?.prepareImagePipeline) {
        try {
          const prepared = await deps.prepareImagePipeline(structuredClone(pipelineBase), configurable);
          const { foregroundPolicy, ...rest } = prepared;
          if (JSON.stringify(rest) !== JSON.stringify(pipelineBase)) throw new Error("图片流水线只能附加服务端处理策略，不能改写用户已选模型或生成参数。");
          input = { ...pipelineBase, ...(foregroundPolicy ? { foregroundPolicy } : {}) };
        } catch (error) {
          return { error: "image_pipeline_unavailable", summary: error instanceof Error ? error.message : "无法冻结图片处理方案，未创建或提交生成任务。" };
        }
      } else input = pipelineBase;
      if (input.foregroundPolicy) {
        if (input.outputFormat !== undefined && input.outputFormat !== "png") return {
          error: "foreground_format_mismatch",
          summary: "透明前景只能交付 PNG；未擅自修改已选格式，也未创建生成方案。请改为 PNG 后重试。",
        };
        input = { ...input, outputFormat: "png" };
      }
      const preserveEditRatio = (imageEdit || input.sourceUsage === "edit")
        && input.aspectRatioIntent !== "resize";
      const frozenInput = structuredClone({
        ...input,
        ...(preserveEditRatio && imageEdit?.aspectRatio
          ? { aspectRatio: imageEdit.aspectRatio }
          : {}),
        ...imageEdit?.placement,
        ...(input.target
          ? { target: designJobTargetSchema.parse(input.target) }
          : {}),
      });
      if (preserveEditRatio) delete frozenInput.aspectRatio;
      if (preserveEditRatio && imageEdit?.aspectRatio) frozenInput.aspectRatio = imageEdit.aspectRatio;
      const frozenAttachmentMap = attachmentMap
        ? structuredClone(attachmentMap)
        : undefined;
      // Never accept identity metadata supplied by the primary model or copied
      // from a previous proposal; derive it from this run's original map only.
      delete frozenInput.inputImageSources;
      delete frozenInput.modelConstraint;
      const inputImageSources = captureImageProposalSources(input.inputImages, frozenAttachmentMap);
      if (input.inputImages?.length && (!inputImageSources || inputImageSources.length !== input.inputImages.length)) return {
        error: "invalid_reference_image",
        summary: "参考图必须来自本轮已认证附件或当前画布上经意图核对的真实图片，不能使用任意 URL、历史链接或未绑定来源；未创建方案。",
      };
      if (inputImageSources) frozenInput.inputImageSources = inputImageSources;
      if (modelConstraint) frozenInput.modelConstraint = structuredClone(modelConstraint);

      if (preserveEditRatio && !imageEdit && inputImageSources?.length === 1) {
        const dimensions = configurable?.user_attachment_dimensions?.[inputImageSources[0]!.assetId] as
          | { width?: unknown; height?: unknown }
          | undefined;
        if (typeof dimensions?.width === "number" && Number.isFinite(dimensions.width) && dimensions.width > 0
          && typeof dimensions.height === "number" && Number.isFinite(dimensions.height) && dimensions.height > 0) {
          let a = Math.round(dimensions.width);
          let b = Math.round(dimensions.height);
          const width = a;
          const height = b;
          while (b) [a, b] = [b, a % b];
          frozenInput.aspectRatio = `${width / a}:${height / a}`;
        }
      }
      if (preserveEditRatio && !frozenInput.aspectRatio) return {
        error: "source_dimensions_unavailable",
        summary: "无法读取原图尺寸，因此不能可靠保持原比例；未创建方案。请重新选择原图后再试。",
      };
      const invalidNativeRatio = validateNativeImageAspectRatio(frozenInput, models);
      if (invalidNativeRatio) return invalidNativeRatio;
      if (deps.proposalStore) {
        // A revised/new proposal is a new operation, even if the model copied
        // the previous target verbatim. Retries use the persisted frozen key.
        if (frozenInput.target)
          frozenInput.target.idempotency_key = randomUUID();
        // A prior proposal is historical context, not permission to redirect a
        // new upload to its old artboard. Explicit input.target is still fully
        // validated above; proposing an independent result does not submit it.
        if (frozenInput.inputImages?.length) {
          frozenInput.inputImages = frozenInput.inputImages.map(
            (ref) => frozenAttachmentMap?.[ref] ?? ref,
          );
          if (
            frozenInput.inputImages.some(
              (ref) => !/^(https?:\/\/|data:image\/)/.test(ref),
            )
          )
            return {
              error: "invalid_reference_image",
              summary:
                "参考图尚未解析，不能丢弃参考图继续生成。请读取有效图片后重新提交方案。",
            };
        }
        // Legacy same-run proposal continuation is retired: no caller supplies
        // `continueConfirmedProposal`, so these remain closed.
        const mayContinueCurrentApproval = false;
        const mayContinueCombinedCurrentApproval = false;
        const mayContinueSemanticCurrentRunApproval =
          deps.continueConfirmedProposal &&
          deps.semanticCurrentRunImageConfirmation?.runId === configurable?.run_id &&
          configurable?.image_confirmation == null &&
          !frozenInput.foregroundPolicy;
        let changedExplicitRatioRequiresConfirmation = false;
        if (mayContinueCurrentApproval) {
          const existing = await deps.proposalStore.latestForCurrentRequirement(configurable);
          if (existing) {
            changedExplicitRatioRequiresConfirmation =
              explicitAspectRatio !== undefined &&
              existing.input.operation !== "remove_background" &&
              !imageAspectRatiosEqual(
                existing.input.aspectRatio ?? "1:1",
                explicitAspectRatio,
              );
            if (!changedExplicitRatioRequiresConfirmation) {
              if (explicitContinuation)
                explicitContinuation.confirmationStarted = true;
              return deps.continueConfirmedProposal!(existing.id, runContext);
            }
          }
        }
        const confirmation = await deps.proposalStore.propose(
          configurable,
          frozenInput,
          {
            title: frozenInput.title,
            operation: frozenInput.operation ?? "generate",
            description: frozenInput.prompt,
            model: frozenInput.model,
            aspectRatio: frozenInput.aspectRatio ?? "1:1",
            quality: frozenInput.quality ?? "standard",
            outputFormat: frozenInput.outputFormat ?? "png",
            referenceImageCount: frozenInput.inputImages?.length ?? 0,
            target: frozenInput.target ?? null,
            ...(frozenInput.foregroundPolicy ? { foregroundPolicy: foregroundPolicyDisclosure(frozenInput.foregroundPolicy) } : {}),
          },
        );
        // When the current user message is itself an explicit generation
        // approval but no prior durable proposal existed, the model still has
        // to materialize the already-described plan. Continue that exact,
        // newly frozen proposal through the normal confirmation tool instead
        // of asking for a redundant third turn. Product-bound confirmation is
        // never transferable to a proposal created after the click, and a new
        // foreground pipeline must first disclose its additional processing
        // and price.
        if (mayContinueCurrentApproval && !changedExplicitRatioRequiresConfirmation) {
          if (explicitContinuation) explicitContinuation.confirmationStarted = true;
          return deps.continueConfirmedProposal!(
            confirmation.confirmationId,
            runContext,
          );
        }
        if (mayContinueCombinedCurrentApproval) {
          if (explicitContinuation) explicitContinuation.confirmationStarted = true;
          return deps.continueConfirmedProposal!(confirmation.confirmationId, {
            ...runContext,
            combined_current_image_confirmation: {
              confirmationId: confirmation.confirmationId,
              runId: configurable.run_id,
            },
          });
        }
        if (mayContinueSemanticCurrentRunApproval) {
          let boundProposalId: string | null = null;
          try {
            boundProposalId = await deps.semanticCurrentRunImageConfirmation!.bindProposal(confirmation.confirmationId);
          } catch {
            // The proposal remains durable and retryable. A semantic review or
            // binding outage must not turn the whole conversation into a tool
            // failure or risk an unreviewed paid submission.
          }
          if (!boundProposalId || boundProposalId !== confirmation.confirmationId) return {
            status: "awaiting_confirmation",
            confirmation,
            error: "semantic_image_confirmation_unavailable",
            summary: "已按当前需求保存最新图片方案，但语义确认复核未完成；尚未提交生成或扣费。请再次确认生成。",
          };
          if (explicitContinuation) explicitContinuation.confirmationStarted = true;
          return deps.continueConfirmedProposal!(confirmation.confirmationId, {
            ...runContext,
            semantic_image_confirmation: {
              confirmationId: confirmation.confirmationId,
              decision: "confirm",
              runId: configurable.run_id,
              scope: "current_run",
            },
          });
        }
        return {
          status: "awaiting_confirmation",
          confirmation,
          summary:
            "方案已保存，尚未生成，也尚未把新图片放入画布。请说明方案；用户明确确认生成后才提交生图任务，不得说确认生成后仍不生成。修改需求必须重新创建方案。" +
            (!frozenInput.target && !frozenInput.foregroundPolicy && (frozenInput.operation ?? "generate") === "generate"
              ? "本方案是保留背景的独立画布图片，不包含自动去背景、分层或其他后处理；不得向用户承诺这些步骤。"
              : "仅说明 confirmation.details 中实际列出的处理，不得添加额外步骤。"),
        };
      }
      const confirmation = deps.confirmationService!.proposeAction({
        userId,
        canvasId,
        kind: "image_generation",
        ...(typeof runId === "string" ? { originRunId: runId } : {}),
        details: {
          title: frozenInput.title,
          operation: frozenInput.operation ?? "generate",
          description: frozenInput.prompt,
          model: frozenInput.model,
          aspectRatio: frozenInput.aspectRatio ?? "1:1",
          quality: frozenInput.quality ?? "standard",
          outputFormat: frozenInput.outputFormat ?? "png",
          referenceImageCount: frozenInput.inputImages?.length ?? 0,
          target: frozenInput.target ?? null,
          ...(frozenInput.foregroundPolicy ? { foregroundPolicy: foregroundPolicyDisclosure(frozenInput.foregroundPolicy) } : {}),
          placement:
            frozenInput.placementX != null && frozenInput.placementY != null
              ? {
                  x: frozenInput.placementX,
                  y: frozenInput.placementY,
                  width: frozenInput.placementWidth ?? 512,
                  height: frozenInput.placementHeight ?? 512,
                }
              : null,
        },
        execute: async () => {
          if (frozenInput.target) {
            try {
              await deps.validateDesignTarget!(
                frozenInput.target,
                configurable,
              );
            } catch (error) {
              return {
                error: "design_target_invalid",
                summary:
                  error instanceof Error
                    ? error.message
                    : "画板已改变，请重新读取后生成方案",
              };
            }
          }
          return runImageGenerate(
            structuredClone(frozenInput),
            deps.persistImage,
            deps.submitImageJob,
            frozenAttachmentMap
              ? structuredClone(frozenAttachmentMap)
              : undefined,
            models,
          );
        },
      });

      return {
        summary:
          "图片尚未开始生成。请用自然、详细的中文向用户复述准备生成的画面，并询问是否确认生成。",
        status: "awaiting_confirmation",
        confirmation,
      };
  };

  return createAgentTool({
    id: "generate_image",
    description: `Prepare exactly one complete image generation/editing proposal, or operation=remove_background on one existing image, for conversational user confirmation. Include title and prompt on the first call; edits must include the current authenticated inputImages, sourceUsage=edit, and the requested aspect-ratio intent. If validation or provider availability fails, only correct the named arguments for the same proposal: never silently change the user's operation, model, sources, or target. Background removal requires exact upstream gpt-image-2 (not all/vip), PNG, and a resolved original image; it can alter details and is not pixel-exact. Normally this tool only saves the proposal. If the current user message already explicitly approves generation and no older proposal exists, the server may continue the newly frozen unchanged plan through the same confirmation checks; a newly added foreground-processing price must still be disclosed first. Only one proposal may await confirmation in a session: for a requested series, propose the next item, then proceed to the next only after the current item is explicitly confirmed, delivered, and verified; a written plan is not a completed image. After an awaiting_confirmation result, explain the saved proposal in natural Chinese and ask whether the user confirms; do not show a parameter card and do not claim generation started. Available models: ${modelSummary}.`,
    inputSchema: buildImageGenerateSchema(models),
    execute: async (schemaInput, context) => {
      // The validated schema widens optional properties with `| undefined`,
      // which `exactOptionalPropertyTypes` does not accept on ImageGenerateInput.
      const input = schemaInput as ImageGenerateInput;
      const configurable = runContextOf(context) as Record<string, any>;
      // Legacy approval-phrase parsing is retired with the proposal
      // continuation path.
      const explicitApproval = false;
      const combinedCurrentApproval = false;
      const semanticCurrentRunApproval =
        deps?.semanticCurrentRunImageConfirmation?.runId === configurable?.run_id;
      const hasRunIdentity = [
        configurable?.user_id,
        configurable?.session_id,
        configurable?.run_id,
      ].every((value) => typeof value === "string" && value.length > 0);
      const continuationKey =
        deps?.continueConfirmedProposal &&
        (explicitApproval || combinedCurrentApproval || semanticCurrentRunApproval) &&
        hasRunIdentity
          ? `${configurable.user_id}:${configurable.session_id}:${configurable.run_id}`
          : null;
      if (!continuationKey) {
        const proposalFreezeKey =
          !explicitApproval &&
          configurable?.image_confirmation == null &&
          hasRunIdentity
            ? `${configurable.user_id}:${configurable.session_id}:${configurable.run_id}`
            : null;
        if (!proposalFreezeKey) return execute(input, configurable);

        const inputKey = canonicalInputKey(input);
        const previous =
          proposalFreezeChainByRun.get(proposalFreezeKey) ?? Promise.resolve();
        const invocation = previous.then(async () => {
          const frozen = frozenProposalByRun.get(proposalFreezeKey);
          if (frozen) {
            if (frozen.inputKey === inputKey) return frozen.result;
            return {
              error: "proposal_already_frozen_for_run",
              summary: `本轮已保存图片方案“${frozen.title}”（${frozen.aspectRatio}）并等待确认；未创建第二份方案。请以已保存方案为准。`,
              ...(frozen.result.confirmation
                ? { confirmation: frozen.result.confirmation }
                : {}),
            };
          }
          const result = await execute(input, configurable);
          // Validation/provider-availability failures occur before a durable
          // proposal exists and must leave the run free to correct arguments.
          if (result.status === "awaiting_confirmation" && result.confirmation) {
            frozenProposalByRun.set(proposalFreezeKey, {
              inputKey,
              result,
              title: input.title,
              aspectRatio: input.aspectRatio ?? "1:1",
            });
          }
          return result;
        });
        proposalFreezeChainByRun.set(
          proposalFreezeKey,
          invocation.then(
            () => undefined,
            () => undefined,
          ),
        );
        return invocation;
      }
      if (explicitContinuation?.key === continuationKey)
        return explicitContinuation.promise;

      const promise = execute(input, configurable).then(
        (result) => {
          if (
            result.error &&
            !result.confirmation &&
            !explicitContinuation?.confirmationStarted
          )
            explicitContinuation = undefined;
          return result;
        },
        (error) => {
          if (!explicitContinuation?.confirmationStarted)
            explicitContinuation = undefined;
          throw error;
        },
      );
      explicitContinuation = {
        key: continuationKey,
        promise,
        confirmationStarted: false,
      };
      return promise;
    },
  });
}
