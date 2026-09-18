import { z } from "zod";
import sharp from "sharp";
import { isNativeGptImageModel, planApproximateNativeImageSize } from "@loomic/shared";
import { createAgentTool, runContextOf, toolAbortSignalOf } from "./tools/tool-run-context.js";

import {
  captureImageProposalSources,
  resolveCanvasImageProposalSources,
} from "./image-proposal-sources.js";
import { imageGenerationModelConstraintSchema } from "./image-generation-contracts.js";
import { resolveImageGenerationModelProposal } from "./image-model-resolution.js";
import { imageAspectRatiosEqual, validateNativeImageAspectRatio } from "./image-ratio-intent.js";
import { validateImageGenerationRequestLimits } from "../generation/image-request-limits.js";
import type { AvailableModel } from "../generation/providers/registry.js";
import type {
  MastraImageJobContext,
  MastraImageJobInput,
  MastraImageJobResult,
  MastraImageJobSubmitter as MastraImageJobSubmitterContract,
} from "./mastra-image-jobs.js";
import { MastraImagePreflightError } from "./mastra-image-jobs.js";
import type {
  MastraExplicitImageSourceResolver,
  MastraImageSourceGrounder,
  MastraImageSourceGroundingContext,
  MastraImageSourceGroundingProposal,
  MastraImageSourceGroundingResult,
} from "./mastra-image-source-grounding.js";
import { MASTRA_IMAGE_SOURCE_MAX_INPUTS } from "./mastra-image-source-grounding.js";
import { bindNativeImageRatioUsage, nativeImageRatioArgs, resolveNativeImageRatio } from "./mastra-image-ratio-state.js";
import { mastraImageExecutionPolicy, mastraImageRunLimitReceipt, validateMastraImageExecution, validateMastraImageResolutionSupport } from "./mastra-image-execution-policy.js";
import { mastraImageSubmissionKey } from "./mastra-image-jobs.js";
import { SESSION_REFUSED_OUTPUTS_KEY, SESSION_UNFINISHED_MAX_ITEMS, type SessionRefusedOutput } from "./session-design-context.js";

export type {
  MastraExplicitImageSourceResolver,
  MastraImageSourceGrounder,
  MastraImageSourceGroundingProposal,
  MastraImageSourceGroundingResult,
} from "./mastra-image-source-grounding.js";

type NativeImageSubmission = MastraImageJobInput;

/** References auto-attached for a loaded promo Skill when the model skipped
 * the workspace library lookup. Small enough to stay inside source limits. */
const AUTO_LIBRARY_REFERENCE_COUNT = 2;
type NativeImageSubmitResult = MastraImageJobResult;

/** Map only unique catalog aliases; manual UI selection always stays primary. */
function resolveNativeImageModelProposal(
  args: Record<string, unknown>,
  models: readonly AvailableModel[],
  constraint: Parameters<typeof resolveImageGenerationModelProposal>[2],
): ReturnType<typeof resolveImageGenerationModelProposal> {
  const proposed = typeof args.model === "string" ? args.model.trim() : "";
  const manualSpecified = constraint?.manualModelIds !== undefined;
  // Prefer the adapter's explicit frame-size contract for Auto. This is a
  // capability preference, not a blacklist of other published gateways; an
  // explicit model choice (UI, mention or tool proposal) is never replaced.
  if ((!proposed || proposed.toLowerCase() === "auto") && !manualSpecified && !constraint?.mentionedModelIds?.length) {
    const ratio = typeof args.aspectRatio === "string" ? args.aspectRatio.split(":").map(Number) : [];
    const needsControlledFrame = ratio.length === 2 && ratio[0] !== ratio[1];
    const needsSource = Array.isArray(args.inputImages) && args.inputImages.length > 0;
    if (needsControlledFrame || needsSource) {
      const native = models.find(item => item.upstreamModelId === "gpt-image-2");
      if (native) return resolveImageGenerationModelProposal({ ...args, model: native.id }, models, constraint);
    }
  }
  if (proposed && !manualSpecified && proposed.toLowerCase() !== "auto" && !models.some(model => model.id === proposed)) {
    const identifier = proposed.toLocaleLowerCase();
    const aliases = models.filter(model =>
      (model.upstreamModelId ?? "").toLocaleLowerCase() === identifier
      || model.displayName.toLocaleLowerCase() === identifier);
    if (aliases.length !== 1) return aliases.length
      ? { ok: false, code: "image_model_identifier_ambiguous",
        error: "该图片模型名称对应多个当前工作区模型，未提交生成；请从当前目录选择明确模型。" }
      : { ok: false, code: "image_model_identifier_unavailable",
        error: "该图片模型不在当前工作区目录中，未提交生成；请从当前目录选择模型或使用 Auto。" };
    return resolveImageGenerationModelProposal({ ...args, model: aliases[0]!.id }, models, constraint);
  }
  return resolveImageGenerationModelProposal(args, models, constraint);
}

export type MastraImageSubmitContext = MastraImageJobContext & {
  signal: AbortSignal;
};

/** The durable submitter owns idempotency and unknown-result recovery. */
export type MastraImageJobSubmitter = MastraImageJobSubmitterContract;

const newImageSchema = z.object({
  operation: z.literal("generate").default("generate"),
  title: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().trim().min(1).max(300).optional()
    .describe("Omit in Auto mode so the server chooses from the current published catalog. Supply only a model explicitly selected by the user."),
  aspectRatio: z.string().trim().min(1).max(40).optional(),
  aspectRatioIntent: z.enum(["preserve_source", "resize", "approximate"]).optional()
    .describe("For edits default to preserving the source frame. Set resize when the user requests reframing/resizing or selecting this output's ratio from a multi-ratio request. Set approximate only after this run's nonstandard-image-size Skill was loaded and the user currently allowed a near ratio; for a target wider than 3:1, propose 3:1 (or 1:3 for a taller target) and disclose the gap. Explicit UI ratio overrides this hint."),
  // Billing and the provider request use the same ordinary-generation
  // default when the model does not choose one explicitly.
  quality: z.enum(["standard", "hd", "ultra"]).optional().default("standard")
    .describe("Default MUST be standard (Low). Use hd (Medium) or ultra (High) only when the user explicitly requests that quality tier. A request for 2K/4K, detailed artwork, or reference recreation does not authorize higher quality. Never label hd as High."),
  resolution: z.enum(["1k", "2k", "4k"]).optional().default("1k")
    .describe("Native output pixel tier. Defaults to 1k; use 2k or 4k only when requested. This changes billing independently of quality."),
  outputFormat: z.enum(["png", "jpg", "webp"]).optional(),
  background: z.enum(["transparent", "opaque", "auto"]).optional().describe("Set transparent when the user requests a transparent background (透明底/透明背景), including edits. This requests native transparency in this single generation, not a second background-removal job. Transparent output uses PNG."),
  // Ignore incidental model-added metadata, but never silently discard a
  // requested source, native-board target or server-owned execution setting.
  target: z.never().optional(),
  inputImages: z.never().optional(),
  sourceAssetId: z.never().optional(),
  sourceAssetIds: z.never().optional(),
  sourceUsage: z.never().optional(),
  foregroundPolicy: z.never().optional(),
  proposalId: z.never().optional(),
  replayOnly: z.never().optional(),
}).strip();

const editImageSchema = newImageSchema.extend({
  operation: z.enum(["generate", "remove_background"]).default("generate"),
  sourceAssetIds: z.array(z.string().uuid()).min(1).max(MASTRA_IMAGE_SOURCE_MAX_INPUTS),
  sourceUsage: z.enum(["edit", "reference"]).default("edit"),
}).strip().superRefine((value, ctx) => {
  if (value.operation === "remove_background" && value.sourceAssetIds.length !== 1)
    ctx.addIssue({ code: "custom", path: ["sourceAssetIds"], message: "remove_background requires exactly one source" });
});

/** Keep server-owned source/intent metadata separate from public tool fields. */
function parseNativeImageProposal(
  schema: typeof newImageSchema | typeof editImageSchema,
  args: Record<string, unknown>,
  explicitSources?: { sourceAssetIds: string[]; sourceUsage: "edit" | "reference" },
) {
  const { aspectRatioIntent: _aspectRatioIntent, inputImages: _inputImages, sourceUsage: _sourceUsage,
    sourceAssetId: _sourceAssetId, sourceAssetIds: _sourceAssetIds, ...publicArgs } = args;
  return schema.parse({ ...publicArgs, ...explicitSources });
}

export type MastraImageToolDependencies = {
  createUserClient: (accessToken: string) => any;
  submitter: MastraImageJobSubmitter;
  availableImageModels: readonly AvailableModel[];
  /** Frozen original user message from the authenticated runtime, never a model prompt/history. */
  currentUserMessage?: { runId: string; text: string };
  /** Optional runtime-owned resolver for a trusted current-turn source candidate. */
  groundSources?: MastraImageSourceGrounder;
  /**
   * Resolves explicit edit IDs which are not current-turn attachments. The
   * runtime owns its frozen manifest/RLS/lineage checks; this tool only accepts
   * the resulting ordered data-image carriers.
   */
  resolveExplicitSources?: MastraExplicitImageSourceResolver;
  /**
   * Runtime-owned: server-random published workspace library references used
   * when a loaded promo Skill did not pick references itself. Returns already
   * materialized, RLS/lineage-authorized data-image carriers.
   */
  autoLibrarySources?: (input: { context: MastraImageSourceGroundingContext; count: number }) =>
    Promise<{ sourceAssetIds: string[]; inputImages: string[] }>;
};

type UnknownSubmissionReceipt = { status: "unknown"; error: string; summary: string };
type MastraImageToolState = { unknownReceipt?: UnknownSubmissionReceipt; accepted: Set<string>; inFlight: number; pending?: Promise<void> };

/** Run-context keys this native submit tool reads. */
type NativeImageRunContext = {
  user_id?: unknown; access_token?: unknown; workspace_id?: unknown;
  session_id?: unknown; canvas_id?: unknown; run_id?: unknown;
  active_design_id?: unknown;
};

function contextFromToolContext(context: unknown): MastraImageSubmitContext | null {
  const configurable = runContextOf(context) as NativeImageRunContext;
  const values = {
    userId: configurable.user_id,
    accessToken: configurable.access_token,
    workspaceId: configurable.workspace_id,
    sessionId: configurable.session_id,
    canvasId: configurable.canvas_id,
    runId: configurable.run_id,
  };
  const signal = toolAbortSignalOf(context);
  if (!Object.values(values).every(value => typeof value === "string" && value.length > 0)
    || !signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") return null;
  const activeDesignId = configurable.active_design_id;
  return { ...(values as Omit<MastraImageSubmitContext, "signal" | "activeDesignId">), signal,
    ...(typeof activeDesignId === "string" && activeDesignId.length > 0 ? { activeDesignId } : {}) };
}

/**
 * A receipt for a request this tool refused BEFORE any submission attempt: the
 * submitter was never called for it, so nothing was created and nothing was
 * charged.
 *
 * This marker exists so the product can tell a refusal from a failed generation
 * without reading Chinese prose, and it is display/progress state only. It never
 * grants execution, billing or authorization authority, and it is never recorded
 * as a design write. Post-submission outcomes — including the proven no-write
 * `MastraImagePreflightError` raised INSIDE the submitter, and every unknown
 * transport outcome — deliberately carry no marker, because an attempt was made.
 */
type MastraImageRefusal = { status: "failed"; error: string; summary: string; refused: true };

/** The single place a pre-submission refusal receipt is built. */
function refusal(error: string, summary: string): MastraImageRefusal {
  return { status: "failed", error, summary, refused: true };
}

/**
 * Mark an existing refusal-shaped receipt built by a policy/validation module as
 * pre-submission, preserving its own fields (for example the run-limit `limit`).
 * Only `refused` is added; no existing field or `status` value changes.
 */
function asRefusal<T extends { status: "failed"; error: string; summary: string }>(receipt: T): T & { refused: true } {
  return { ...receipt, refused: true };
}

/**
 * Remember one output this run refused, so a later "继续" turn can be told what
 * is still missing. The model never sees previous tool results, so this run
 * context record — persisted at run end by `mastra-runtime.ts` — is the only way
 * the refusal can survive into the next turn.
 *
 * Bounded and deduplicated by title, earliest first, so three refusals of a
 * four-page carousel record three distinct pages rather than copies. This is
 * progress/method state: it does not set the design-write marker, does not
 * create or replay a job, and does not authorize anything — the next turn's
 * submission still passes every gate on its own.
 */
function recordRefusedOutput(configurable: Record<string, unknown>, entry: SessionRefusedOutput): void {
  const title = entry.title.trim().slice(0, 200);
  if (!title) return;
  const existing = Array.isArray(configurable[SESSION_REFUSED_OUTPUTS_KEY])
    ? configurable[SESSION_REFUSED_OUTPUTS_KEY] as unknown[] : [];
  const key = title.toLocaleLowerCase();
  const alreadyRecorded = existing.some(item => item && typeof item === "object"
    && typeof (item as { title?: unknown }).title === "string"
    && ((item as { title: string }).title.trim().toLocaleLowerCase() === key));
  if (alreadyRecorded) return;
  const sourceAssetIds = (entry.sourceAssetIds ?? []).filter(value => typeof value === "string").slice(0, 16);
  const next = [...existing, { title, prompt: entry.prompt?.slice(0, 400) ?? "",
    operation: entry.operation ?? "generate",
    ...(entry.aspectRatio ? { aspectRatio: entry.aspectRatio } : {}), sourceAssetIds }];
  // Keep the earliest MAX entries: a refused carousel is ordered 2,3,4…, so the
  // first missing pages are the ones a continuation must produce first.
  configurable[SESSION_REFUSED_OUTPUTS_KEY] = next.length > SESSION_UNFINISHED_MAX_ITEMS
    ? next.slice(0, SESSION_UNFINISHED_MAX_ITEMS) : next;
}

/**
 * Direct Mastra image submission. It intentionally has no proposal, approval
 * phrase, reviewer or retry path: runtime supplies the authenticated current
 * user authorization, while this tool binds only live owned sources and lets
 * the durable submitter deduplicate the exact normalized request.
 */
function createMastraImageSubmissionTool(input: MastraImageToolDependencies, mode: "new" | "edit", state: MastraImageToolState) {
  // Per-run tool instance: once transport outcome is unknown, changing wording
  // must not create a second potentially chargeable request in this turn.
  // Native board placement is a manual editor action, not an Agent argument.
  const schema = mode === "new" ? newImageSchema : editImageSchema;
  return createAgentTool({
    id: mode === "new" ? "generate_image" : "edit_image",
    description: mode === "new"
      ? "Submit one new image to the infinite canvas. The server may bind authenticated implicit reference sources from the current conversation; never pass source arguments here. Use edit_image for explicit sourceAssetIds when modifying or visually referencing an existing result. Board placement is manual; never pass target or create a board. The server chooses a current available model when omitted. processing means queued/running, not completed."
      : `Deliver the result to the infinite canvas, never directly into a native board. Submit one image derived from 1–${MASTRA_IMAGE_SOURCE_MAX_INPUTS} explicit authenticated sourceAssetIds. Use sourceUsage=edit to transform the sources, or reference for a visually related new image. remove_background accepts exactly one source. Obtain IDs from current attachments, authenticated historical uploads in this session, inspect results, or recent image-job receipts; never invent IDs or use URLs. processing means queued/running, not completed.`,
    inputSchema: schema,
    execute: async (raw, context) => {
    if (state.unknownReceipt) return state.unknownReceipt;
    const submitContext = contextFromToolContext(context);
    if (!submitContext) return refusal("image_context_unavailable",
      "当前图片任务缺少经过认证的运行上下文，未提交生成。");
    if (submitContext.signal.aborted) return refusal("image_submission_canceled",
      "本轮已取消，未提交图片生成。");
    const configurable = runContextOf(context);
    const currentUserText = input.currentUserMessage?.runId === submitContext.runId ? input.currentUserMessage.text : undefined;
    const executionViolation = validateMastraImageExecution(raw, currentUserText);
    if (executionViolation) return refusal(executionViolation.code, executionViolation.summary);
    const constraint = imageGenerationModelConstraintSchema.safeParse(configurable.image_generation_model_constraint);
    if (configurable.image_generation_model_constraint !== undefined && !constraint.success)
      return refusal("image_model_constraint_invalid", "无法校验本轮图片模型选择，未提交生成。");
    let sourceAssetIds = mode === "edit" ? (raw as z.infer<typeof editImageSchema>).sourceAssetIds : [];
    const sourceUsage = mode === "edit" ? (raw as z.infer<typeof editImageSchema>).sourceUsage : undefined;
    const proposal = sourceAssetIds.length ? { ...raw, inputImages: sourceAssetIds, sourceUsage } : raw;
    const seriesSizes = Array.isArray(configurable.session_series_sizes)
      ? configurable.session_series_sizes.filter((value): value is string => typeof value === "string") : undefined;
    const initialRatio = resolveNativeImageRatio({ args: proposal as Record<string, unknown>,
      preference: configurable.image_generation_aspect_ratio, userPrompt: configurable.user_prompt,
      usage: sourceUsage ?? "independent",
      // The non-standard-size method counts as available when EITHER the model
      // loaded it via use_skill, OR the runtime deterministically enabled it
      // because the user's own turn stated a non-standard / out-of-range size.
      // Ratio AUTHORIZATION remains a separate gate inside resolveNativeImageRatio.
      skillLoaded: configurable.nonstandard_size_skill_loaded_run_id === submitContext.runId
        || configurable.nonstandard_size_skill_enabled_run_id === submitContext.runId,
      ...(seriesSizes?.length ? { seriesSizes } : {}) });
    if (!initialRatio.ok) return refusal(initialRatio.code, initialRatio.error);
    let ratioState = initialRatio.state;
    let model = resolveNativeImageModelProposal(nativeImageRatioArgs(proposal as Record<string, unknown>, ratioState), input.availableImageModels,
      constraint.success ? constraint.data : undefined);
    if (!model.ok) return refusal(model.code, model.error);
    // Model resolution only changes the catalog ID and empty reference hints;
    // the initial ratio and its verified intent already remain authoritative.
    let proposalArgs = model.args;
    let normalized = parseNativeImageProposal(schema, proposalArgs,
      sourceAssetIds.length && sourceUsage ? { sourceAssetIds, sourceUsage } : undefined);
    let groundedInputImages: string[] | undefined;
    const hasUserAttachments = Object.keys(
      (configurable.user_attachment_map as Record<string, string> | undefined) ?? {}).length > 0;
    // A loaded promo Skill (for example game-promo-visuals) requires consulting
    // the workspace material library. Weak models skip the read-only tool, so
    // the runtime deterministically supplies random published library
    // references for a create with no user attachment and no model source.
    // Explicit user attachments still win; a lookup failure never blocks.
    if (mode === "new" && !hasUserAttachments && sourceAssetIds.length === 0
      && configurable.promo_library_auto_run_id === submitContext.runId && input.autoLibrarySources) {
      try {
        const auto = await input.autoLibrarySources({ context: submitContext, count: AUTO_LIBRARY_REFERENCE_COUNT });
        const wellFormed = auto.sourceAssetIds.length > 0
          && auto.sourceAssetIds.length === auto.inputImages.length
          && auto.sourceAssetIds.length <= MASTRA_IMAGE_SOURCE_MAX_INPUTS
          && auto.sourceAssetIds.every(value => z.string().uuid().safeParse(value).success)
          && auto.inputImages.every(value => typeof value === "string" && value.startsWith("data:image/"));
        if (wellFormed) {
          sourceAssetIds = auto.sourceAssetIds;
          groundedInputImages = auto.inputImages;
          ratioState = bindNativeImageRatioUsage(ratioState, "reference");
          model = resolveNativeImageModelProposal({ ...nativeImageRatioArgs(proposalArgs, ratioState), model: raw.model,
            inputImages: sourceAssetIds, sourceUsage: "reference" } as Record<string, unknown>,
          input.availableImageModels, constraint.success ? constraint.data : undefined);
          if (!model.ok) return refusal(model.code, model.error);
          proposalArgs = model.args;
          normalized = parseNativeImageProposal(schema, proposalArgs);
        }
      } catch {
        // Library unavailability must not block the user's generation.
      }
    }
    // Restore ok-narrowing after the optional try/catch assignment.
    if (!model.ok) return refusal(model.code, model.error);
    if (mode === "new" && input.groundSources && !groundedInputImages && sourceAssetIds.length === 0) {
      let grounding: MastraImageSourceGroundingResult;
      try {
        grounding = await input.groundSources({ context: submitContext, proposal: {
          operation: "generate", title: normalized.title, prompt: normalized.prompt, model: model.model,
          ...(typeof proposalArgs.aspectRatio === "string" ? { aspectRatio: proposalArgs.aspectRatio } : {}),
          quality: normalized.quality, ...(normalized.outputFormat ? { outputFormat: normalized.outputFormat } : {}),
        } });
      } catch {
        return refusal("source_grounding_unavailable",
          "当前候选参考来源暂时无法核验，未提交图片生成；请稍后重试或明确指定参考图。");
      }
      if (grounding.decision === "recoverable")
        return refusal(grounding.code, grounding.summary);
      if (grounding.decision === "bind") {
        // The runtime materializes every source after RLS/lineage checks. Keep
        // a structural fence here so a faulty integration cannot inject a URL.
        if (grounding.sourceAssetIds.length < 1 || grounding.sourceAssetIds.length > MASTRA_IMAGE_SOURCE_MAX_INPUTS
          || grounding.sourceAssetIds.length !== grounding.inputImages.length
          || !grounding.sourceAssetIds.every(value => z.string().uuid().safeParse(value).success)
          || !grounding.inputImages.every(value => typeof value === "string" && value.startsWith("data:")))
          return refusal("source_grounding_unavailable", "参考图来源核验结果不完整，未提交图片生成。");
        sourceAssetIds = grounding.sourceAssetIds;
        groundedInputImages = grounding.inputImages;
        // Grounding changes an independent proposal into one with real input
        // images. Re-run the catalog/manual constraint resolver against that
        // source-bound proposal before durable submission.
        // Keep user/model-proposed selection separate from the first Auto
        // resolution: newly discovered sources must be allowed to reselect.
        ratioState = bindNativeImageRatioUsage(ratioState, grounding.usage);
        model = resolveNativeImageModelProposal({ ...nativeImageRatioArgs(proposalArgs, ratioState), model: raw.model, inputImages: sourceAssetIds,
          sourceUsage: grounding.usage } as Record<string, unknown>, input.availableImageModels,
        constraint.success ? constraint.data : undefined);
        if (!model.ok) return refusal(model.code, model.error);
        proposalArgs = model.args;
        normalized = parseNativeImageProposal(schema, proposalArgs);
      }
    }
    // A loaded promo Skill (for example game-promo-visuals) requires consulting
    // the workspace material library. Weak models skip the read-only tool, so
    // the runtime deterministically supplies random published library
    // references for an otherwise-independent create. Explicit sources always
    // win, and a lookup failure never blocks an otherwise valid generation.
    if (mode === "new" && !groundedInputImages && sourceAssetIds.length === 0
      && configurable.promo_library_auto_run_id === submitContext.runId && input.autoLibrarySources) {
      try {
        const auto = await input.autoLibrarySources({ context: submitContext, count: AUTO_LIBRARY_REFERENCE_COUNT });
        const wellFormed = auto.sourceAssetIds.length > 0
          && auto.sourceAssetIds.length === auto.inputImages.length
          && auto.sourceAssetIds.length <= MASTRA_IMAGE_SOURCE_MAX_INPUTS
          && auto.sourceAssetIds.every(value => z.string().uuid().safeParse(value).success)
          && auto.inputImages.every(value => typeof value === "string" && value.startsWith("data:image/"));
        if (wellFormed) {
          sourceAssetIds = auto.sourceAssetIds;
          groundedInputImages = auto.inputImages;
          ratioState = bindNativeImageRatioUsage(ratioState, "reference");
          model = resolveNativeImageModelProposal({ ...nativeImageRatioArgs(proposalArgs, ratioState), model: raw.model,
            inputImages: sourceAssetIds, sourceUsage: "reference" } as Record<string, unknown>,
          input.availableImageModels, constraint.success ? constraint.data : undefined);
          if (!model.ok) return refusal(model.code, model.error);
          proposalArgs = model.args;
          normalized = parseNativeImageProposal(schema, proposalArgs);
        }
      } catch {
        // Library unavailability must not block the user's generation.
      }
    }
    // A reference-style edit (a new image derived from sources) under a loaded
    // promo Skill also receives workspace library references, on top of the
    // model's own sources. Strict edits and background removal are untouched.
    const appendedLibraryCarriers: Record<string, string> = {};
    if (mode === "edit" && sourceUsage === "reference" && configurable.promo_library_auto_run_id === submitContext.runId
      && input.autoLibrarySources) {
      const remaining = MASTRA_IMAGE_SOURCE_MAX_INPUTS - sourceAssetIds.length;
      if (remaining > 0) {
        try {
          const auto = await input.autoLibrarySources({ context: submitContext, count: Math.min(AUTO_LIBRARY_REFERENCE_COUNT, remaining) });
          const known = new Set(sourceAssetIds);
          const additions = auto.sourceAssetIds
            .map((assetId, index) => ({ assetId, image: auto.inputImages[index] }))
            .filter(entry => !known.has(entry.assetId) && typeof entry.image === "string" && entry.image.startsWith("data:image/"))
            .slice(0, remaining);
          for (const entry of additions) {
            sourceAssetIds.push(entry.assetId);
            appendedLibraryCarriers[entry.assetId] = entry.image as string;
          }
        } catch {
          // A library lookup failure must not block the edit.
        }
      }
    }
    // Restore the ok-narrowing after the optional try/catch assignment.
    if (!model.ok) return refusal(model.code, model.error);
    let attachmentMap = configurable.user_attachment_map as Record<string, string> | undefined;
    if (Object.keys(appendedLibraryCarriers).length)
      attachmentMap = { ...(attachmentMap ?? {}), ...appendedLibraryCarriers };
    let unresolved = groundedInputImages ? [] : sourceAssetIds.filter(reference =>
      !captureImageProposalSources([reference], attachmentMap));
    // Native-design outputs are not necessarily top-level canvas elements. The
    // runtime resolver is the only authority allowed to materialize these IDs;
    // retain the older live-canvas resolver below as a fallback for its scope.
    if (mode === "edit" && sourceAssetIds.length && input.resolveExplicitSources) {
      try {
        // Validate the complete source set even when an ID is already present
        // in the current attachment map. Otherwise a stale inherited image can
        // bypass the canvas-selection constraint without reaching the resolver.
        const explicit = await input.resolveExplicitSources({ context: submitContext, sourceAssetIds });
        const wellFormed = explicit.sourceAssetIds.length === sourceAssetIds.length
          && explicit.inputImages.length === sourceAssetIds.length
          && explicit.sourceAssetIds.every((assetId, index) => assetId === sourceAssetIds[index]
            && z.string().uuid().safeParse(assetId).success)
          && explicit.inputImages.every(reference => typeof reference === "string" && reference.startsWith("data:image/"));
        if (wellFormed) {
          attachmentMap = {
            ...(attachmentMap ?? {}),
            ...Object.fromEntries(explicit.sourceAssetIds.map((assetId, index) => [assetId, explicit.inputImages[index]!])),
          };
          unresolved = unresolved.filter(assetId => !explicit.sourceAssetIds.includes(assetId));
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        if (reason === "explicit_source_conflicts_with_canvas_selection")
          return refusal("source_selection_conflict",
            "本次改图来源与发送时选中的画布图片不一致；未提交生成。请重新选择图片后再试。");
        if (reason === "historical_upload_removed_or_out_of_scope")
          return refusal("source_historical_upload_unavailable",
            "先前的上传记录已删除或不属于当前会话；未提交生成。请重新上传或选择仍在当前会话中的参考图。");
        if (reason === "historical_upload_asset_out_of_scope" || reason === "historical_upload_asset_missing")
          return refusal("source_historical_upload_unavailable",
            "先前上传的图片资产已删除或不属于当前工作区；未提交生成。请重新上传该图片。");
        if (reason === "historical_upload_download_failed" || reason === "historical_upload_history_unavailable")
          return refusal("source_historical_upload_unavailable",
            "先前上传的图片暂时无法核验或读取；未提交生成。请稍后重试。");
        // Keep the legacy resolver available for authenticated live canvas
        // assets. It cannot grant access to a non-canvas source by itself.
      }
    }
    if (unresolved.length) {
      try {
        const resolved = await resolveCanvasImageProposalSources({
          client: input.createUserClient(submitContext.accessToken), canvasId: submitContext.canvasId, references: unresolved,
        });
        if (Object.keys(resolved).length !== new Set(unresolved).size) throw new Error("canvas_reference_not_found");
        attachmentMap = { ...(attachmentMap ?? {}), ...resolved };
      } catch {
        return refusal("invalid_reference_image",
          "参考图必须是本轮认证附件或当前画布的存活 assetId；不能传任意 URL、历史链接或未绑定来源。未提交生成。");
      }
    }
    const sources = groundedInputImages ? undefined : captureImageProposalSources(sourceAssetIds, attachmentMap);
    if (!groundedInputImages && sourceAssetIds.length && (!sources || sources.length !== sourceAssetIds.length))
      return refusal("invalid_reference_image", "参考图来源无法绑定到当前认证资产，未提交生成。");
    const resolvedInputImages = sources?.map(source => attachmentMap?.[source.assetId]);
    if (resolvedInputImages && !resolvedInputImages.every((reference): reference is string => typeof reference === "string"))
      return refusal("invalid_reference_image", "参考图来源无法绑定到当前认证资产，未提交生成。");
    const inputImages = groundedInputImages ?? resolvedInputImages as string[] | undefined;
    // Read the authenticated source carrier, never a model-supplied dimension
    // or remote URL. Omitted edit framing must preserve the actual image.
    let outputAspectRatio = ratioState.frame.aspectRatio;
    if (inputImages?.length && ratioState.frame.intent === "preserve_source") {
      try {
        const carrier = inputImages[0]!;
        if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(carrier)) throw new Error("invalid_carrier");
        const metadata = await sharp(Buffer.from(carrier.slice(carrier.indexOf(",") + 1), "base64")).metadata();
        const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
        const width = rotated ? metadata.height : metadata.width;
        const height = rotated ? metadata.width : metadata.height;
        if (!width || !height) throw new Error("dimensions_unavailable");
        outputAspectRatio = `${width}:${height}`;
        ratioState = { ...ratioState, frame: { ...ratioState.frame, aspectRatio: outputAspectRatio } };
      } catch {
        return refusal("source_dimensions_unavailable",
          "源图尺寸暂时无法读取，未提交生成；可以重试或指定输出比例。");
      }
    }
    // The legacy job path validates against the selected frozen upstream ID
    // after resolving references. Do the same here, after grounding has made
    // an otherwise-independent request source-bound.
    const selectedModel = input.availableImageModels.find(candidate => candidate.id === model.model);
    const resolutionSupportViolation = validateMastraImageResolutionSupport(selectedModel?.upstreamModelId ?? model.model, normalized.resolution);
    if (resolutionSupportViolation) return refusal(resolutionSupportViolation.code, resolutionSupportViolation.summary);
    const limitViolation = validateImageGenerationRequestLimits({ model: model.model, prompt: normalized.prompt,
      ...(selectedModel?.upstreamModelId ? { upstreamModelId: selectedModel.upstreamModelId } : {}),
      ...(inputImages?.length ? { inputImages } : {}) });
    if (limitViolation) {
      // A request rejected by the server-side request limits is one specific
      // output this run could not deliver, so it is recorded for the next
      // continuation turn. Progress state only: no design write, no submission.
      recordRefusedOutput(configurable, { title: normalized.title, prompt: normalized.prompt,
        operation: normalized.operation, ...(outputAspectRatio ? { aspectRatio: outputAspectRatio } : {}),
        sourceAssetIds: [...sourceAssetIds] });
      return refusal(limitViolation.code, limitViolation.message);
    }
    const submission: NativeImageSubmission = {
      operation: normalized.operation,
      title: normalized.title,
      prompt: normalized.prompt,
      model: model.model,
      aspectRatio: outputAspectRatio ?? "1:1",
      quality: normalized.quality,
      resolution: normalized.resolution,
      ...(normalized.background ? { background: normalized.background } : {}),
      ...(normalized.outputFormat ? { outputFormat: normalized.outputFormat } : {}),
      ...(normalized.background === "transparent" ? { outputFormat: "png" } : {}),
      ...(inputImages?.length ? { inputImages } : {}),
    };
    // Record the frame this run actually resolved. The session series persists a
    // size to authorize later renders in the same series, so it must record the
    // real output rather than a regex reading of the prompt.
    configurable.session_submitted_aspect_ratio = submission.aspectRatio;
    const invalidNativeRatio = validateNativeImageAspectRatio(submission, input.availableImageModels);
    if (invalidNativeRatio) {
      if (ratioState.approximation.authorized) return asRefusal({
        status: "failed" as const,
        error: ratioState.approximation.skillLoaded
          ? "image_native_approximate_ratio_plan_required" : "image_nonstandard_size_skill_required",
        summary: ratioState.approximation.skillLoaded
          ? `原生比例 ${submission.aspectRatio} 超出可提交范围，未提交或扣费。当前近似授权可使用最近支持的 3:1/1:3；请按已加载的 nonstandard-image-size Skill 重新提交合法比例并设 aspectRatioIntent=approximate，说明比例偏差，无需重复询问同一生成授权。`
          : `原生比例 ${submission.aspectRatio} 超出可提交范围，未提交或扣费。当前请求允许近似，但本轮尚无 nonstandard-image-size 的 use_skill loaded 回执；请先调用 list_skills 和 use_skill，读取正文后按合法近似比例重新提交，无需重复询问同一生成授权。`,
      });
      return asRefusal({ status: "failed" as const, ...invalidNativeRatio });
    }
    let approximateSizePlan: ReturnType<typeof planApproximateNativeImageSize> | undefined;
    if (ratioState.approximation.applied
      && isNativeGptImageModel(selectedModel?.upstreamModelId)) {
      const originalRatio = ratioState.approximation.targetRatio;
      const dimensions = originalRatio && /^(\d+):(\d+)$/.exec(originalRatio);
      if (dimensions && Number(dimensions[1]) > 16 && Number(dimensions[2]) > 16) {
        try {
          const plan = planApproximateNativeImageSize(Number(dimensions[1]), Number(dimensions[2]), submission.resolution);
          if (imageAspectRatiosEqual(submission.aspectRatio, plan.aspectRatio)) approximateSizePlan = plan;
        } catch { /* The ordinary strict ratio preflight remains authoritative. */ }
      }
    }
    const previousSubmission = state.pending;
    let releaseSubmission!: () => void;
    state.pending = new Promise<void>(resolve => { releaseSubmission = resolve; });
    await previousSubmission;
    try {
      if (state.unknownReceipt) return state.unknownReceipt;
      const key = mastraImageSubmissionKey(submitContext.runId, submission);
      const replay = state.accepted.has(key);
      const limit = mastraImageExecutionPolicy(currentUserText).limit;
      if (!replay && state.accepted.size + state.inFlight >= limit) {
        // The reported incident: the model planned more outputs than the run
        // budget allowed, the extra submissions were refused here, and the next
        // turn could not know which outputs were missing because it never sees
        // previous tool results. Record them for the continuation instruction.
        recordRefusedOutput(configurable, { title: submission.title, prompt: submission.prompt,
          ...(submission.operation ? { operation: submission.operation } : {}), aspectRatio: submission.aspectRatio,
          sourceAssetIds: [...sourceAssetIds] });
        return asRefusal(mastraImageRunLimitReceipt(limit));
      }
      if (!replay) state.inFlight++;
      let result: NativeImageSubmitResult;
      try {
        result = await input.submitter.submit(submitContext, submission);
        if (!replay) state.accepted.add(key);
      } finally {
        if (!replay) state.inFlight--;
      }
      return {
        ...result,
        status: result.error ? "failed" as const : result.status ?? "processing" as const,
        jobType: "image_generation" as const,
        ...(approximateSizePlan ? { approximateSizePlan } : {}),
        ...(sourceAssetIds.length ? { sourceAssetIds: groundedInputImages ? sourceAssetIds : sources?.map(source => source.assetId) } : {}),
        summary: (result.error
          ? "图片任务未完成；未自动重试或创建新任务。"
          : result.status === "succeeded"
            ? "图片任务已由服务端完成。"
            : "图片任务已提交或正在处理；请使用返回的 jobId 查询结果，不要重复提交。")
          + (approximateSizePlan && !result.error
            ? ` 原目标 ${approximateSizePlan.target.width}×${approximateSizePlan.target.height}，翻倍放大参照 ${approximateSizePlan.scaledTarget.width}×${approximateSizePlan.scaledTarget.height}；本次按 ${approximateSizePlan.aspectRatio} 请求原生尺寸 ${approximateSizePlan.nativeSize.width}×${approximateSizePlan.nativeSize.height}，计划比例偏差约 ${(approximateSizePlan.ratioError * 100).toFixed(1)}%。翻倍参照不是最终像素，实际输出尺寸仍须按任务结果核对。`
            : ""),
      };
    } catch (error) {
      if (error instanceof MastraImagePreflightError) {
        return { status: "failed" as const, error: error.code, summary: error.summary };
      }
      // A transport failure can happen after the durable submitter inserted its
      // idempotency record. Do not claim that nothing was created or retry.
      const diagnostic = error as { name?: string; code?: string; stack?: string };
      console.warn("[mastra-image-submit]", {
        name: diagnostic?.name, code: typeof diagnostic?.code === "string" && /^[a-z_]+$/.test(diagnostic.code) ? diagnostic.code : "unknown",
        // Stack frames locate our code without logging provider bodies, prompts or credentials.
        frames: diagnostic?.stack?.split("\n").slice(1, 4).map(line => line.replace(/https?:\/\/[^\s)]+/g, "[url]")),
      });
      state.unknownReceipt = { status: "unknown", error: "image_submission_unknown",
        summary: "图片提交状态未知，可能已创建持久任务；本轮不会再次提交。可以查询状态，查询暂未找到也不能证明没有提交。" };
      return state.unknownReceipt;
    } finally {
      releaseSubmission();
    }
    },
  });
}

/** New image with optional server-trusted grounding; explicit sources use edit_image. */
export function createMastraImageTool(input: MastraImageToolDependencies) {
  return createMastraImageSubmissionTool(input, "new", { accepted: new Set(), inFlight: 0 });
}

/** Explicit source-bound edit/reference request; never guesses the latest image. */
export function createMastraImageEditTool(input: MastraImageToolDependencies) {
  return createMastraImageSubmissionTool(input, "edit", { accepted: new Set(), inFlight: 0 });
}

/** Create both public tools with one per-run unknown-submission receipt. */
export function createMastraImageTools(input: MastraImageToolDependencies) {
  const state: MastraImageToolState = { accepted: new Set(), inFlight: 0 };
  return {
    generateImage: createMastraImageSubmissionTool(input, "new", state),
    editImage: createMastraImageSubmissionTool(input, "edit", state),
  };
}
