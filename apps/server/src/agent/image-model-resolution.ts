/**
 * Authoritative image-model proposal resolution.
 *
 * Owns the server-only decision of which model a reviewed image tool call may
 * actually use: the current authenticated catalog plus the current-turn
 * preference/@mention constraint always outrank a model ID echoed from
 * conversation history.
 *
 * Why it was split out of the retired legacy image-generation tool module: the
 * Mastra runtime (`mastra-image-tool.ts`) calls this on every native submission,
 * while the deleted legacy proposal tool was its only other caller. It is pure —
 * it never reads the catalog itself.
 */
import type { AvailableModel } from "../generation/providers/registry.js";
import type {
  ImageGenerationModelConstraint,
  ImageGenerationModelResolution,
} from "./image-generation-contracts.js";

const DEFAULT_MODEL = "gpt-image-2-all";
const BACKGROUND_REMOVAL_MODEL = "gpt-image-2";

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
