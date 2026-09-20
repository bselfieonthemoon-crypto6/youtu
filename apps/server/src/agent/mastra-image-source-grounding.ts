import { createHash } from "node:crypto";

import { Agent } from "@mastra/core/agent";
import { z } from "zod";

import type { ImageAttachment } from "@loomic/shared";
import { GPT_IMAGE_2_REQUEST_LIMITS } from "../generation/image-request-limits.js";
import { resolveAgentImageAttachment } from "./attachment-resolver.js";
import { verifyMastraHistoricalUpload, type MastraHistoricalUpload } from "./mastra-history-attachments.js";
import { buildCanvasSceneIndex } from "./canvas-scene-index.js";
import type { MastraImageDesignTargetInput } from "./mastra-image-jobs.js";
import type { MastraImageJobScopeQuery } from "./mastra-image-status-tools.js";
import type { RelatedImageCandidate } from "./related-image-context.js";

const uuid = z.string().uuid();
/** The Mastra source path must not reject fewer references than the native
 * project adapter can durably submit. Model-specific validation still runs
 * again immediately before provider submission. */
export const MASTRA_IMAGE_SOURCE_MAX_INPUTS = GPT_IMAGE_2_REQUEST_LIMITS.maxInputImages;
const provenanceSchema = z.enum([
  "current_attachment",
  "historical_attachment",
  "selected_canvas_image",
  "live_canvas_image",
  "recent_succeeded_job",
  // A published workspace material from the design resource library, chosen by
  // the server-side library picker (never asserted by the model).
  "design_resource",
]);

export type MastraImageSourceGroundingProposal = {
  title: string;
  prompt: string;
  operation: "generate";
  model?: string;
  aspectRatio?: string;
  quality?: "standard" | "hd" | "ultra";
  outputFormat?: "png" | "jpg" | "webp";
  target?: MastraImageDesignTargetInput;
};

export type MastraImageSourceCandidate = {
  candidateKey: string;
  assetId: string;
  provenance: readonly z.infer<typeof provenanceSchema>[];
  elementId?: string | undefined;
  jobId?: string | undefined;
  messageId?: string | undefined;
  title?: string | undefined;
  promptExcerpt?: string | undefined;
  createdAt?: string | undefined;
};

export type MastraImageSourceUserEvidence = {
  sourceId: string;
  text: string;
  provenance: "current_user" | "recent_user";
};

export type MastraImageSourceGroundingResult =
  | { decision: "independent"; authorizationGranted: false }
  | { decision: "bind"; usage: "edit" | "reference"; sourceAssetIds: string[]; inputImages: string[]; authorizationGranted: false }
  | { decision: "recoverable"; code: "source_grounding_ambiguous" | "source_grounding_unavailable" | "source_historical_upload_unavailable";
      summary: string; authorizationGranted: false };

/**
 * The user-facing role of one reference image attached to a task.
 *
 * The server has exactly ONE verdict about how a source is used — the
 * grounding reviewer's `usage: "edit" | "reference"` — and this vocabulary is
 * its honest projection, not a second concept:
 *
 * - `edit_target` is the exact statement `usage: "edit"` (the source itself is
 *   changed).
 * - `style_reference` / `content_reference` are the two meanings of
 *   `usage: "reference"` (borrow the look vs. borrow the subject matter).
 * - `undetermined` is `usage: "reference"` where nothing on the server
 *   distinguishes those two meanings: the reviewer answers only
 *   edit-vs-reference, the tool's `sourceUsage` argument only says
 *   `"reference"`, and neither carries a style/content signal. Reporting a
 *   style or content label here would invent an answer the server never
 *   reached. The reviewer's own prose says "visually related", which spans both.
 * - `ignored` is a source counted by the request that the server did NOT put in
 *   the task's input images (the promo library replaced it, or server grounding
 *   superseded it). It is never asserted for a source that was used.
 */
export type MastraImageSourceRole =
  | "edit_target"
  | "style_reference"
  | "content_reference"
  | "undetermined"
  | "ignored";

/** Every role value, so callers and tests enumerate the same vocabulary. */
export const MASTRA_IMAGE_SOURCE_ROLES: readonly MastraImageSourceRole[] = Object.freeze([
  "edit_target", "style_reference", "content_reference", "undetermined", "ignored",
]);

/**
 * How a reference's role was decided. `user` means the request itself stated
 * the role (the submission's own `sourceUsage`); `inferred` means the server
 * derived it (the grounding reviewer, the server-side library picker, or the
 * library reference appender). A user-stated role is never relabelled as
 * inferred, and vice versa.
 */
export type MastraImageSourceOrigin = "user" | "inferred";

/** One reference's role as structured task data — never prose to interpret. */
export type MastraImageSourceReference = {
  assetId: string;
  role: MastraImageSourceRole;
  /** Derived from {@link MastraImageSourceRole}: false only for `undetermined`. */
  certain: boolean;
  source: MastraImageSourceOrigin;
};

/** True only when the role is a definite statement, never for `undetermined`. */
export function isCertainMastraImageSourceRole(role: MastraImageSourceRole): boolean {
  return role !== "undetermined";
}

/** The one honest projection of the reviewer's `usage` verdict onto a role. */
export function mastraImageSourceRoleFromUsage(usage: "edit" | "reference"): MastraImageSourceRole {
  return usage === "edit" ? "edit_target" : "undetermined";
}

export function createMastraImageSourceReference(input: {
  assetId: string;
  usage: "edit" | "reference";
  source: MastraImageSourceOrigin;
}): MastraImageSourceReference {
  const role = mastraImageSourceRoleFromUsage(input.usage);
  return { assetId: input.assetId, role, certain: isCertainMastraImageSourceRole(role), source: input.source };
}

/** A reference the request carried but the server did not use for this job. */
export function createIgnoredMastraImageSourceReference(input: {
  assetId: string;
  source: MastraImageSourceOrigin;
}): MastraImageSourceReference {
  return { assetId: input.assetId, role: "ignored", certain: true, source: input.source };
}

const sourceReferenceRoleSchema = z.enum(["edit_target", "style_reference", "content_reference", "undetermined", "ignored"]);
const sourceReferenceSchema = z.object({
  assetId: uuid,
  role: sourceReferenceRoleSchema,
  certain: z.boolean(),
  source: z.enum(["user", "inferred"]),
}).strict();

/**
 * Validate a persisted `source_references` payload. A job with no references has
 * no such field, so absence and `[]` both parse to `undefined` — an empty array
 * must never be persisted or reported as if it claimed roles. The cap allows the
 * submitted carriers plus `ignored` references beside them.
 */
export function parseMastraImageSourceReferences(value: unknown): MastraImageSourceReference[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0
    || value.length > MASTRA_IMAGE_SOURCE_MAX_INPUTS * 2) return undefined;
  const parsed = z.array(sourceReferenceSchema).safeParse(value);
  if (!parsed.success) return undefined;
  if (new Set(parsed.data.map(reference => reference.assetId)).size !== parsed.data.length) return undefined;
  // `certain` is derived from `role`, so a persisted row that disagrees with the
  // derivation is corrupt data, not an alternative reading.
  if (parsed.data.some(reference => reference.certain !== isCertainMastraImageSourceRole(reference.role))) return undefined;
  return parsed.data;
}

export type MastraImageSourceGroundingContext = {
  userId: string;
  accessToken: string;
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  runId: string;
  activeDesignId?: string;
  signal: AbortSignal;
};

export type MastraImageSourceGrounder = (input: {
  context: MastraImageSourceGroundingContext;
  proposal: MastraImageSourceGroundingProposal;
}) => Promise<MastraImageSourceGroundingResult>;

export type MastraExplicitImageSourceResolver = (input: {
  context: MastraImageSourceGroundingContext;
  sourceAssetIds: readonly string[];
}) => Promise<{ sourceAssetIds: string[]; inputImages: string[] }>;

const candidateSchema = z.object({
  candidateKey: z.string().regex(/^source-[1-9][0-9]{0,2}$/),
  assetId: uuid,
  provenance: z.array(provenanceSchema).min(1).max(6),
  elementId: z.string().min(1).max(200).optional(),
  jobId: uuid.optional(),
  messageId: uuid.optional(),
  title: z.string().min(1).max(160).optional(),
  promptExcerpt: z.string().min(1).max(500).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const evidenceSchema = z.object({
  sourceId: z.string().min(1).max(200),
  // A one-character "quote" trivially satisfies a substring check; require a
  // minimally meaningful contiguous excerpt.
  quote: z.string().min(2).max(2_000),
}).strict();

export const mastraImageSourceReviewSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("independent"),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reasonCode: z.enum(["explicit_independent", "no_referenced_source"]),
  }).strict(),
  z.object({
    decision: z.literal("bind"),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    candidateKeys: z.array(z.string()).min(1).max(MASTRA_IMAGE_SOURCE_MAX_INPUTS),
    usage: z.enum(["edit", "reference"]),
    evidence: evidenceSchema,
    reasonCode: z.enum(["current_attachment", "selected_canvas", "recent_result", "named_source"]),
  }).strict(),
  z.object({
    decision: z.literal("ambiguous"),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    candidateKeys: z.array(z.string()).max(3),
    reasonCode: z.enum(["multiple_matches", "insufficient_context"]),
  }).strict(),
]);

export type MastraImageSourceReviewInput = {
  policyVersion: "mastra-source-grounding-v1";
  manifestDigest: string;
  currentRequest: MastraImageSourceUserEvidence;
  effectiveBrief: MastraImageSourceUserEvidence[];
  proposed: MastraImageSourceGroundingProposal;
  candidates: Array<Omit<MastraImageSourceCandidate, "assetId" | "elementId" | "jobId">>;
};

export type MastraImageSourceReviewer = (
  input: Readonly<MastraImageSourceReviewInput>,
  options: { signal: AbortSignal },
) => Promise<unknown>;

export const MASTRA_IMAGE_SOURCE_REVIEW_PROMPT = `You are a read-only image-source resolver, not the executing agent and not an authorization or billing gate.
Decide whether the current request asks for an independent image, requires one or more listed existing images as edit inputs or visual references, or is genuinely ambiguous. Understand natural language, names and temporal references; do not use a fixed phrase list.
The exact current user request has priority. effectiveBrief contains only bounded prior user statements, never assistant reasoning or Skill instructions. Candidates are authenticated metadata but their mere existence never implies the user selected them. A historical_attachment is a real upload in this same conversation; empty current attachments do not mean there was no uploaded image. For a continuation such as "就按复刻，提交", prefer the matching original upload and its time/message context over a later generated image, unless the user identifies that generated result.
Use bind only when user evidence identifies the listed candidate keys. usage=edit changes the source itself; usage=reference creates a related/new composition from it. "Reference the just-created double-leaf logo to make a poster" is reference, while "change that logo" is edit. Explicitly asking for a wholly new unrelated image is independent. Multiple equally plausible images or an unresolved pronoun is ambiguous.
For bind, evidence.quote must be an exact contiguous quote from the cited current/recent user source. Copy manifestDigest exactly. Never output asset IDs, URLs, credentials, prose, permissions, tool calls or fields outside the schema.`;

/** One no-tool, one-step structured provider call. */
export function createMastraImageSourceReviewer(model: ConstructorParameters<typeof Agent>[0]["model"]): MastraImageSourceReviewer {
  const agent = new Agent({
    id: "loomic-image-source-grounding",
    name: "Image source grounding",
    model,
    instructions: MASTRA_IMAGE_SOURCE_REVIEW_PROMPT,
  });
  return async (input, { signal }) => {
    const result = await agent.generate(JSON.stringify(input).replace(/</g, "\\u003c"), {
      abortSignal: signal,
      maxSteps: 1,
      modelSettings: { maxOutputTokens: 800, maxRetries: 0 },
      structuredOutput: { schema: mastraImageSourceReviewSchema, jsonPromptInjection: "system" },
    });
    return result.object;
  };
}

export function createMastraImageSourceGrounder(input: {
  currentRequest: MastraImageSourceUserEvidence;
  effectiveBrief: MastraImageSourceUserEvidence[];
  candidates: MastraImageSourceCandidate[];
  reviewer: MastraImageSourceReviewer;
  materialize(selected: readonly MastraImageSourceCandidate[], options: {
    signal: AbortSignal;
    usage: "edit" | "reference";
  }): Promise<Array<{ assetId: string; inputImage: string }>>;
  /** A single image explicitly selected on the canvas for this request. */
  requiredSourceAssetId?: string;
  timeoutMs?: number;
}): MastraImageSourceGrounder {
  const candidates = freezeCandidates(input.candidates);
  const currentRequest = freezeEvidence(input.currentRequest, "current_user");
  const effectiveBrief = Object.freeze(input.effectiveBrief.slice(-6).map(item => freezeEvidence(item, "recent_user")));
  const manifestDigest = digest({ currentRequest, effectiveBrief, candidates });
  const reviewerCandidates = candidates.map(({ assetId: _assetId, elementId: _elementId, jobId: _jobId, ...candidate }) => candidate);
  const byKey = new Map(candidates.map(candidate => [candidate.candidateKey, candidate]));
  const requiredSourceAssetId = input.requiredSourceAssetId === undefined
    ? undefined : uuid.parse(input.requiredSourceAssetId);
  if (requiredSourceAssetId && !candidates.some(candidate => candidate.assetId === requiredSourceAssetId))
    throw new Error("required_source_not_in_manifest");
  const evidenceById = new Map([currentRequest, ...effectiveBrief].map(item => [item.sourceId, item.text]));
  // This grounder is created for one runtime request. Retain only a few
  // validated reviewer decisions, never materialized inputs or failures.
  const reviewerDecisionCache = new Map<string, MastraImageSourceReviewerDecision>();
  // A review that is still running is SHARED, not duplicated. A series submitted
  // as several calls in one model step reaches this grounder about 10ms apart;
  // without this map the second call would start its own review against the same
  // pre-run manifest and could reach a different verdict about the same request.
  // Both callers live in the same run, so the caller signal and its abort
  // behaviour are unchanged.
  const reviewerReviewInFlight = new Map<string, Promise<MastraImageSourceReviewerDecision | undefined>>();
  const timeoutMs = Math.min(15_000, Math.max(20, Math.floor(input.timeoutMs ?? 8_000)));

  return async ({ context, proposal }) => {
    if (!candidates.length) return { decision: "independent", authorizationGranted: false };
    // The reviewer answers exactly one question — does the CURRENT USER REQUEST
    // require one of the listed candidates — and that answer belongs to this
    // turn's frozen request + manifest, not to one proposal. The key therefore
    // deliberately excludes `proposal`: every later zero-source call in the SAME
    // run reuses the verdict the run already reached instead of re-litigating it
    // per call, which is how a same-step pair used to diverge into a mid-series
    // stall. A different run (or a different manifest) still reviews separately.
    const key = digest({ userId: context.userId, workspaceId: context.workspaceId, sessionId: context.sessionId,
      canvasId: context.canvasId, runId: context.runId, manifestDigest });
    let review = reviewerDecisionCache.get(key);
    if (review) {
      // Map insertion order provides a tiny LRU cache without retaining prior
      // runs or unbounded variants.
      reviewerDecisionCache.delete(key);
      reviewerDecisionCache.set(key, review);
    } else {
      // The check-and-set below is synchronous, so two concurrent calls can never
      // both create a review for the same key.
      let pending = reviewerReviewInFlight.get(key);
      if (!pending) {
        pending = resolveReviewerDecision({ context, proposal, manifestDigest, currentRequest, effectiveBrief,
          reviewerCandidates, byKey, evidenceById, reviewer: input.reviewer, timeoutMs })
          .then(decision => {
            // Only a validated decision becomes a reusable verdict. A failure,
            // timeout or unusable reviewer reply (`undefined`) is never retained,
            // so the next call still reaches the reviewer.
            if (decision) setBoundedReviewerDecision(reviewerDecisionCache, key, decision);
            return decision;
          })
          .finally(() => { reviewerReviewInFlight.delete(key); });
        reviewerReviewInFlight.set(key, pending);
      }
      review = await pending;
    }
    if (review?.decision === "bind" && requiredSourceAssetId && !review.selected.some(candidate =>
      candidate.assetId === requiredSourceAssetId)) return ambiguous();
    return resolveGrounding({ context, review, materialize: input.materialize });
  };
}

/**
 * Resolves model-supplied explicit IDs only when those IDs are already in the
 * runtime's frozen trusted manifest. Unlike the semantic grounder this never
 * invokes a model and never infers a source from prose.
 */
export function createMastraExplicitImageSourceResolver(input: {
  candidates: MastraImageSourceCandidate[];
  /** A single image explicitly selected on the canvas for this request. */
  requiredSourceAssetId?: string;
  /** Runtime-owned scoped lookup; never trusts a supplied ID by itself. */
  lookup?: (assetIds: readonly string[], context: MastraImageSourceGroundingContext) => Promise<MastraImageSourceCandidate[]>;
  materialize(selected: readonly MastraImageSourceCandidate[], options: {
    signal: AbortSignal;
    usage: "edit" | "reference";
  }): Promise<Array<{ assetId: string; inputImage: string }>>;
}): MastraExplicitImageSourceResolver {
  const candidates = freezeCandidates(input.candidates);
  const byAssetId = new Map(candidates.map(candidate => [candidate.assetId, candidate]));
  const requiredSourceAssetId = input.requiredSourceAssetId === undefined
    ? undefined : uuid.parse(input.requiredSourceAssetId);
  if (requiredSourceAssetId && !byAssetId.has(requiredSourceAssetId))
    throw new Error("required_source_not_in_manifest");
  return async ({ context, sourceAssetIds }) => {
    if (sourceAssetIds.length < 1 || sourceAssetIds.length > MASTRA_IMAGE_SOURCE_MAX_INPUTS ||
      new Set(sourceAssetIds).size !== sourceAssetIds.length) throw new Error("explicit_source_manifest_invalid");
    if (requiredSourceAssetId && !sourceAssetIds.includes(requiredSourceAssetId))
      throw new Error("explicit_source_conflicts_with_canvas_selection");
    const missing = sourceAssetIds.filter(assetId => !byAssetId.has(assetId));
    const fresh = missing.length && input.lookup ? await input.lookup(missing, context) : [];
    const freshById = new Map(fresh.map(candidate => [candidate.assetId, candidate]));
    const selected = sourceAssetIds.map(assetId => byAssetId.get(assetId) ?? freshById.get(assetId));
    if (selected.some(candidate => !candidate)) throw new Error("explicit_source_not_in_manifest");
    const materialized = await input.materialize(selected as readonly MastraImageSourceCandidate[], {
      signal: context.signal,
      usage: "edit",
    });
    if (materialized.length !== sourceAssetIds.length || materialized.some((source, index) =>
      source.assetId !== sourceAssetIds[index] || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(source.inputImage)))
      throw new Error("explicit_source_materialization_invalid");
    return { sourceAssetIds: [...sourceAssetIds], inputImages: materialized.map(source => source.inputImage) };
  };
}

type RecentSucceededImageJob = {
  id?: unknown;
  status?: unknown;
  result?: unknown;
  title?: unknown;
  prompt?: unknown;
  createdAt?: unknown;
  canvasId?: unknown;
  designId?: unknown;
};

/**
 * Creates a bounded, opaque-key manifest. Private asset, element and job IDs
 * stay server-side; only the returned candidate metadata projection reaches
 * the read-only reviewer.
 */
export function buildMastraImageSourceCandidates(input: {
  currentAttachments: readonly Pick<ImageAttachment, "assetId" | "name">[];
  historicalAttachments?: readonly MastraHistoricalUpload[];
  canvasCandidates: readonly RelatedImageCandidate[];
  recentJobs: readonly RecentSucceededImageJob[];
  /** Published workspace design-resource materials picked by the library tool. */
  libraryAssets?: readonly { assetId: string; name?: string }[];
  canvasId: string;
  liveDesignIds: ReadonlySet<string>;
}): MastraImageSourceCandidate[] {
  type CandidateMetadata = Partial<Omit<MastraImageSourceCandidate, "candidateKey" | "assetId" | "provenance">>;
  type Draft = Omit<MastraImageSourceCandidate, "candidateKey" | "provenance"> & {
    provenance: Array<z.infer<typeof provenanceSchema>>;
  };
  const byAsset = new Map<string, Draft>();
  const add = (assetId: unknown, provenance: z.infer<typeof provenanceSchema>, metadata: CandidateMetadata = {}) => {
    const parsed = uuid.safeParse(assetId);
    if (!parsed.success) return;
    const existing = byAsset.get(parsed.data);
    if (existing) {
      if (!existing.provenance.includes(provenance)) existing.provenance.push(provenance);
      for (const [key, value] of Object.entries(metadata)) {
        if (value !== undefined && (existing as any)[key] === undefined) (existing as any)[key] = value;
      }
      return;
    }
    byAsset.set(parsed.data, { assetId: parsed.data, provenance: [provenance], ...metadata });
  };

  for (const attachment of input.currentAttachments) {
    add(attachment.assetId, "current_attachment", {
      ...(typeof attachment.name === "string" && attachment.name.trim() ? { title: attachment.name.trim().slice(0, 160) } : {}),
    });
  }
  for (const upload of input.historicalAttachments ?? []) {
    add(upload.assetId, "historical_attachment", { messageId: upload.messageId,
      ...(upload.name ? { title: upload.name } : {}),
      ...(upload.promptExcerpt ? { promptExcerpt: upload.promptExcerpt } : {}),
      createdAt: upload.createdAt });
  }
  for (const candidate of input.canvasCandidates.filter(item => item.priority === "selected")) {
    add(candidate.assetId, "selected_canvas_image", canvasMetadata(candidate));
  }
  for (const job of input.recentJobs) {
    const result = objectRecord(job.result);
    const designId = uuid.safeParse(job.designId);
    const canvasId = uuid.safeParse(job.canvasId);
    const inScope = designId.success ? input.liveDesignIds.has(designId.data)
      : canvasId.success && canvasId.data === input.canvasId;
    if (job.status !== "succeeded" || !inScope) continue;
    const id = uuid.safeParse(job.id);
    if (!id.success) continue;
    add(result?.asset_id, "recent_succeeded_job", {
      jobId: id.data,
      ...(typeof job.title === "string" && job.title.trim() ? { title: job.title.trim().slice(0, 160) } : {}),
      ...(typeof job.prompt === "string" && job.prompt.trim() ? { promptExcerpt: job.prompt.trim().slice(0, 500) } : {}),
      ...(typeof job.createdAt === "string" && !Number.isNaN(Date.parse(job.createdAt)) ? { createdAt: new Date(job.createdAt).toISOString() } : {}),
    });
  }
  for (const candidate of input.canvasCandidates.filter(item => item.priority !== "selected")) {
    add(candidate.assetId, "live_canvas_image", canvasMetadata(candidate));
  }
  for (const asset of input.libraryAssets ?? []) {
    add(asset.assetId, "design_resource", {
      ...(typeof asset.name === "string" && asset.name.trim() ? { title: asset.name.trim().slice(0, 160) } : {}),
    });
  }
  // Explicitly selected canvas images must survive the manifest cap even when
  // many attachments/uploads precede them, otherwise the required source is
  // evicted and the grounder throws `required_source_not_in_manifest`.
  const ordered = [...byAsset.values()];
  const selected = ordered.filter(candidate => candidate.provenance.includes("selected_canvas_image"));
  const rest = ordered.filter(candidate => !candidate.provenance.includes("selected_canvas_image"));
  return [...selected, ...rest].slice(0, 20)
    .map((candidate, index) => ({ candidateKey: `source-${index + 1}`, ...candidate }));
}

/** Selects whole recent user messages only; it never truncates text into a false quote. */
export function buildMastraImageSourceEffectiveBrief(
  messages: readonly { id?: string; role: "user" | "assistant"; content: string }[],
  currentSourceId: string,
  maxBytes = 12_000,
): MastraImageSourceUserEvidence[] {
  const selected: MastraImageSourceUserEvidence[] = [];
  let bytes = 0;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || !message.id || message.id === currentSourceId || !message.content) continue;
    const item: MastraImageSourceUserEvidence = { sourceId: message.id, text: message.content, provenance: "recent_user" };
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    // Do not omit a newer correction and then retain the superseded older
    // instruction as if it were the effective brief. Keep a contiguous suffix.
    if (size > maxBytes - bytes) break;
    selected.unshift(item);
    bytes += size;
    if (selected.length === 6) break;
  }
  return selected;
}

export function createMastraImageSourceMaterializer(input: {
  client: any;
  attachmentMap: Readonly<Record<string, string>>;
  userId: string;
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  scopeImageJobs: MastraImageJobScopeQuery;
  supabaseUrl?: string;
  resolveAttachment?: typeof resolveAgentImageAttachment;
}) {
  const resolveAttachment = input.resolveAttachment ?? resolveAgentImageAttachment;
  return async (selected: readonly MastraImageSourceCandidate[], options: {
    signal: AbortSignal;
    usage: "edit" | "reference";
  }): Promise<Array<{ assetId: string; inputImage: string }>> => {
    options.signal.throwIfAborted();
    const freshCanvas = await input.client.from("canvases").select("id,content").eq("id", input.canvasId).single();
    if (freshCanvas.error || !freshCanvas.data) throw new Error("source_canvas_unavailable");
    const entries = buildCanvasSceneIndex(freshCanvas.data.content?.elements ?? []).entries;
    const liveAssets = new Set(entries.filter(entry => entry.logicalType === "image" && entry.assetId).map(entry => entry.assetId!));
    const liveDesignIds = new Set(entries.flatMap(entry => {
      const parsed = uuid.safeParse(entry.designId);
      return parsed.success ? [parsed.data] : [];
    }));

    // Each candidate's authorization is independent; resolve and materialize
    // them concurrently while preserving the selected order.
    return await Promise.all(selected.map(async candidate => {
      options.signal.throwIfAborted();
      const attached = candidate.provenance.includes("current_attachment") ? input.attachmentMap[candidate.assetId] : undefined;
      if (attached && /^data:image\/[a-z0-9.+-]+;base64,/i.test(attached))
        return { assetId: candidate.assetId, inputImage: attached };

      let authorized = false;
      if (candidate.provenance.includes("historical_attachment") && candidate.messageId) {
        await verifyMastraHistoricalUpload({ client: input.client, sessionId: input.sessionId,
          messageId: candidate.messageId, assetId: candidate.assetId });
        const asset = await input.client.from("asset_objects").select("id")
          .eq("id", candidate.assetId).eq("workspace_id", input.workspaceId)
          .is("deletion_pending_at", null).maybeSingle();
        if (asset.error || !asset.data) throw new Error("historical_upload_asset_out_of_scope");
        authorized = true;
      }
      authorized ||= (candidate.provenance.includes("selected_canvas_image") || candidate.provenance.includes("live_canvas_image"))
        && liveAssets.has(candidate.assetId);
      if (!authorized && candidate.provenance.includes("recent_succeeded_job") && candidate.jobId) {
        const found = await input.scopeImageJobs(input.client.from("background_jobs")
          .select("id,status,result,canvas_id,design_id")
          .eq("id", candidate.jobId)
          .eq("created_by", input.userId)
          .eq("workspace_id", input.workspaceId)
          .eq("session_id", input.sessionId)
          .eq("job_type", "image_generation")).maybeSingle();
        const result = objectRecord(found.data?.result);
        const jobDesignId = uuid.safeParse(found.data?.design_id);
        authorized = !found.error && found.data?.status === "succeeded" && result?.asset_id === candidate.assetId &&
          (jobDesignId.success ? liveDesignIds.has(jobDesignId.data) : found.data?.canvas_id === input.canvasId);
      }
      if (!authorized && candidate.provenance.includes("design_resource")) {
        // A server-picked library material: it must be a published, live,
        // workspace-scoped design resource whose stored asset is exactly this
        // assetId. The model can never assert this provenance itself.
        const resource = await input.client.from("design_resources")
          .select("id")
          .eq("asset_object_id", candidate.assetId)
          .eq("workspace_id", input.workspaceId)
          .eq("scope", "workspace")
          .eq("status", "published")
          .is("deleted_at", null)
          .limit(1);
        authorized = !resource.error && (resource.data?.length ?? 0) === 1;
      }
      if (!authorized) throw new Error("source_candidate_out_of_scope");
      let resolved: Awaited<ReturnType<typeof resolveAttachment>>;
      try {
        resolved = await resolveAttachment({
          client: input.client,
          attachment: { assetId: candidate.assetId, url: "", mimeType: "image/png" },
          canvasContent: freshCanvas.data.content,
          ...(input.supabaseUrl ? { supabaseUrl: input.supabaseUrl } : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        if (candidate.provenance.includes("historical_attachment") && reason === "attachment_not_found")
          throw new Error("historical_upload_asset_missing");
        if (candidate.provenance.includes("historical_attachment") && reason === "attachment_download_failed")
          throw new Error("historical_upload_download_failed");
        throw error;
      }
      return { assetId: candidate.assetId, inputImage: `data:${resolved.mimeType};base64,${resolved.buffer.toString("base64")}` };
    }));
  };
}

function canvasMetadata(candidate: RelatedImageCandidate): Partial<Omit<MastraImageSourceCandidate, "candidateKey" | "assetId" | "provenance">> {
  return {
    elementId: candidate.elementId,
    ...(candidate.title ? { title: candidate.title } : candidate.name ? { title: candidate.name } : {}),
  };
}

function objectRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

type MastraImageSourceReviewerDecision =
  | { decision: "independent" }
  | { decision: "ambiguous" }
  | { decision: "bind"; selected: readonly MastraImageSourceCandidate[]; usage: "edit" | "reference" };

async function resolveReviewerDecision(input: {
  context: MastraImageSourceGroundingContext;
  proposal: MastraImageSourceGroundingProposal;
  manifestDigest: string;
  currentRequest: MastraImageSourceUserEvidence;
  effectiveBrief: readonly MastraImageSourceUserEvidence[];
  reviewerCandidates: MastraImageSourceReviewInput["candidates"];
  byKey: ReadonlyMap<string, Readonly<MastraImageSourceCandidate>>;
  evidenceById: ReadonlyMap<string, string>;
  reviewer: MastraImageSourceReviewer;
  timeoutMs: number;
}): Promise<MastraImageSourceReviewerDecision | undefined> {
  try {
    const reviewInput: MastraImageSourceReviewInput = {
      policyVersion: "mastra-source-grounding-v1",
      manifestDigest: input.manifestDigest,
      currentRequest: input.currentRequest,
      effectiveBrief: [...input.effectiveBrief],
      proposed: structuredClone(input.proposal),
      candidates: structuredClone(input.reviewerCandidates),
    };
    if (Buffer.byteLength(JSON.stringify(reviewInput), "utf8") > 48_000) return undefined;
    const raw = await invokeWithTimeout(input.reviewer, reviewInput, input.context.signal, input.timeoutMs);
    const review = mastraImageSourceReviewSchema.parse(raw);
    if (review.manifestDigest !== input.manifestDigest) return undefined;
    if (review.decision === "independent") return { decision: "independent" };
    if (review.decision === "ambiguous") {
      if (review.candidateKeys.some(key => !input.byKey.has(key))) return undefined;
      return { decision: "ambiguous" };
    }
    const keys = [...new Set(review.candidateKeys)];
    if (keys.length !== review.candidateKeys.length) return undefined;
    const selected = keys.flatMap(key => {
      const candidate = input.byKey.get(key);
      return candidate ? [candidate] : [];
    });
    if (selected.length !== keys.length) return undefined;
    const evidence = input.evidenceById.get(review.evidence.sourceId);
    if (!evidence || !evidence.includes(review.evidence.quote)) return undefined;
    return { decision: "bind", selected, usage: review.usage };
  } catch (error) {
    if (input.context.signal.aborted) throw error;
    return undefined;
  }
}

async function resolveGrounding(input: {
  context: MastraImageSourceGroundingContext;
  review: MastraImageSourceReviewerDecision | undefined;
  materialize: Parameters<typeof createMastraImageSourceGrounder>[0]["materialize"];
}): Promise<MastraImageSourceGroundingResult> {
  try {
    const review = input.review;
    if (!review) return unavailable();
    if (review.decision === "independent") return { decision: "independent", authorizationGranted: false };
    if (review.decision === "ambiguous") return ambiguous();
    const materialized = await input.materialize(review.selected, { signal: input.context.signal, usage: review.usage });
    if (materialized.length !== review.selected.length || materialized.some((source, index) =>
      source.assetId !== review.selected[index]!.assetId || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(source.inputImage))) return unavailable();
    return {
      decision: "bind",
      usage: review.usage,
      sourceAssetIds: materialized.map(source => source.assetId),
      inputImages: materialized.map(source => source.inputImage),
      authorizationGranted: false,
    };
  } catch (error) {
    if (input.context.signal.aborted) throw error;
    if (input.review?.decision === "bind" && input.review.selected.some(candidate =>
      candidate.provenance.includes("historical_attachment"))) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "historical_upload_removed_or_out_of_scope")
        return historicalUnavailable("先前的上传记录已删除或不属于当前会话；未提交生成。请重新上传或选择仍在当前会话中的参考图。");
      if (reason === "historical_upload_asset_out_of_scope")
        return historicalUnavailable("先前上传的图片资产已删除或不属于当前工作区；未提交生成。请重新上传或选择本工作区的参考图。");
      if (reason === "historical_upload_asset_missing")
        return historicalUnavailable("先前上传的图片资产已不存在；未提交生成。请重新上传该图片。");
      if (reason === "historical_upload_download_failed")
        return historicalUnavailable("先前上传的图片暂时无法从存储读取；未提交生成。请稍后重试。");
      if (reason === "historical_upload_history_unavailable")
        return historicalUnavailable("暂时无法核验先前的上传记录；未提交生成。请稍后重试。");
    }
    return unavailable();
  }
}

function setBoundedReviewerDecision(
  cache: Map<string, MastraImageSourceReviewerDecision>,
  key: string,
  review: MastraImageSourceReviewerDecision,
) {
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(key, review);
}

async function invokeWithTimeout(
  reviewer: MastraImageSourceReviewer,
  input: MastraImageSourceReviewInput,
  callerSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort(callerSignal.reason);
    rejectAbort?.(callerSignal.reason instanceof Error ? callerSignal.reason : new Error("source_grounding_aborted"));
  };
  callerSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error("source_grounding_timeout");
    controller.abort(error);
    rejectAbort?.(error);
  }, timeoutMs);
  try {
    if (callerSignal.aborted) abort();
    return await Promise.race([reviewer(Object.freeze(input), { signal: controller.signal }), stopped]);
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", abort);
  }
}

function freezeCandidates(raw: MastraImageSourceCandidate[]) {
  const parsed = z.array(candidateSchema).max(20).parse(structuredClone(raw));
  if (new Set(parsed.map(item => item.candidateKey)).size !== parsed.length ||
      new Set(parsed.map(item => item.assetId)).size !== parsed.length) throw new Error("source_grounding_candidates_invalid");
  return Object.freeze(parsed.map(candidate => Object.freeze({
    ...candidate,
    provenance: Object.freeze([...new Set(candidate.provenance)]),
  })));
}

function freezeEvidence(raw: MastraImageSourceUserEvidence, provenance: MastraImageSourceUserEvidence["provenance"]) {
  return Object.freeze(z.object({ sourceId: z.string().min(1).max(200), text: z.string().min(1).max(20_000),
    provenance: z.literal(provenance) }).strict().parse(structuredClone(raw)));
}

function ambiguous(): MastraImageSourceGroundingResult {
  return { decision: "recoverable", code: "source_grounding_ambiguous", authorizationGranted: false,
    summary: "当前请求似乎需要既有图片，但无法唯一确定来源。请指出要参考或修改的图片；未提交生成。" };
}

function unavailable(): MastraImageSourceGroundingResult {
  return { decision: "recoverable", code: "source_grounding_unavailable", authorizationGranted: false,
    summary: "暂时无法可靠核对本次图片来源。请明确选择来源后重试；未提交生成。" };
}

function historicalUnavailable(summary: string): MastraImageSourceGroundingResult {
  return { decision: "recoverable", code: "source_historical_upload_unavailable",
    authorizationGranted: false, summary };
}

function digest(value: unknown) {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]))
      : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
