import { z } from "zod";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

export const imageProposalTurnRelationSchema = z.enum(["preserve", "invalidate", "unknown"]);
export type ImageProposalTurnRelation = z.infer<typeof imageProposalTurnRelationSchema>;

const relationContextSchema = z.object({
  proposalId: z.string().uuid(),
  proposalInput: z.record(z.string(), z.unknown()),
  requirement: z.object({ id: z.string().uuid(), content: z.string() }).strict(),
  turns: z.array(z.object({ id: z.string().uuid(), content: z.string(),
    precedingAssistant: z.string().optional() }).strict()).max(16),
  hasMore: z.boolean(),
}).strict();

export type ImageProposalRelationContext = z.infer<typeof relationContextSchema>;

export type ImageProposalRelationReviewer = (
  context: Readonly<ImageProposalRelationContext>,
  options: { signal: AbortSignal },
) => Promise<Array<{ messageId: string; relation: ImageProposalTurnRelation }>>;

const contextualConfirmationReviewSchema = z.object({
  proposalId: z.string().uuid(),
  messages: z.array(z.object({
    id: z.string().uuid(), role: z.enum(["user", "assistant"]), content: z.string(),
  }).strict()).max(24),
  proposal: z.object({
    title: z.string().optional(), prompt: z.string().optional(), aspectRatio: z.string().optional(),
    operation: z.string().optional(), outputFormat: z.string().optional(), inputImageCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type ContextualImageConfirmationReview = z.infer<typeof contextualConfirmationReviewSchema>;
export type ContextualImageConfirmationReviewer = (
  context: Readonly<ContextualImageConfirmationReview>,
  options: { signal: AbortSignal },
) => Promise<{ decision: "invite" | "not_invite" | "unknown"; assistantMessageId?: string }>;

export const semanticImageGenerationDecisionSchema = z.enum([
  "confirm_existing", "confirm_current_run", "not_confirm", "unknown",
]);
export type SemanticImageGenerationDecision = z.infer<typeof semanticImageGenerationDecisionSchema>;
const semanticImageGenerationReviewSchema = z.object({
  currentMessage: z.object({ id: z.string().uuid(), content: z.string() }).strict(),
  proposal: z.object({
    id: z.string().uuid(), status: z.string(), title: z.string().optional(), prompt: z.string().optional(),
    aspectRatio: z.string().optional(), operation: z.string().optional(), outputFormat: z.string().optional(),
    inputImageCount: z.number().int().nonnegative(), jobStatus: z.string().nullable().optional(),
    hasTrustedInvitation: z.boolean(),
  }).strict(),
  recentDialogue: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict()).max(16),
}).strict();
export type SemanticImageGenerationReview = z.infer<typeof semanticImageGenerationReviewSchema>;
export type SemanticImageGenerationReviewer = (
  context: Readonly<SemanticImageGenerationReview>,
  options: { signal: AbortSignal },
) => Promise<{ decision: SemanticImageGenerationDecision }>;

/** Server-only semantic continuity for a pending image proposal. It never
 * authorizes billing: paid confirmation remains in loomic_decide_current_image. */
export function createImageProposalRelationService(getAdminClient: () => AdminSupabaseClient) {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await (getAdminClient().rpc as any)(name, args);
    if (error) throw new Error(/image_proposal_relation_[a-z_]+/.exec(error.message ?? "")?.[0]
      ?? "image_proposal_relation_unavailable");
    return data;
  }

  return {
    async reconcile(input: {
      userId: string;
      sessionId: string;
      canvasId: string;
      runId: string;
      signal: AbortSignal;
      reviewer: ImageProposalRelationReviewer;
    }): Promise<"none" | "recorded" | "unknown"> {
      let recorded = false;
      // Old sessions may have more than one bounded batch. Two batches keep a
      // confirmation turn bounded; any remainder stays unresolved and denied.
      for (let batch = 0; batch < 2; batch += 1) {
        const raw = await rpc("loomic_get_image_proposal_relation_context", {
          p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId, p_run: input.runId,
        });
        if (raw === null) {
          console.info("[image-proposal-relation] stage", { stage: "context", available: false, batch, recorded });
          return recorded ? "recorded" : "none";
        }
        const context = relationContextSchema.parse(raw);
        console.info("[image-proposal-relation] stage", {
          stage: "context", available: true, batch, turns: context.turns.length,
          hasMore: context.hasMore, recorded,
        });
        if (!context.turns.length) return recorded ? "recorded" : "none";
        // Requirement/assistant prose is supplemental and projected by the
        // reviewer. User turns are the mutation evidence: never truncate them.
        if (context.turns.some(turn => turn.content.length > 16_000)) return "unknown";
        const reviewCharacters = Math.min(context.requirement.content.length, 2_000) + context.turns.reduce((sum, turn) =>
          sum + turn.content.length + Math.min(turn.precedingAssistant?.length ?? 0, 4_000), 0);
        // Never truncate a possibly modifying clause. Oversized evidence remains
        // unresolved and therefore cannot make the proposal confirmable.
        if (reviewCharacters > 24_000) return "unknown";
        const reviewed = await input.reviewer(context, { signal: input.signal });
        console.info("[image-proposal-relation] stage", {
          stage: "review", batch, decisions: reviewed.reduce<Record<string, number>>((counts, item) => {
            counts[item.relation] = (counts[item.relation] ?? 0) + 1;
            return counts;
          }, {}),
        });
        const expected = new Set(context.turns.map(turn => turn.id));
        if (reviewed.length !== context.turns.length || reviewed.some(item => !expected.delete(item.messageId)) || expected.size)
          return "unknown";
        const relations = reviewed.filter(item => item.relation !== "unknown");
        if (!relations.length) return "unknown";
        await rpc("loomic_record_image_proposal_turn_relations", {
          p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId, p_run: input.runId,
          p_proposal: context.proposalId,
          p_relations: relations.map(item => ({ message_id: item.messageId, relation: item.relation })),
        });
        console.info("[image-proposal-relation] stage", { stage: "record", batch, result: "recorded",
          relations: relations.length });
        recorded = true;
        if (relations.length !== reviewed.length || !context.hasMore) return relations.length === reviewed.length ? "recorded" : "unknown";
      }
      return "unknown";
    },
    async bindContextualConfirmation(input: { userId: string; sessionId: string; canvasId: string; runId: string;
      signal: AbortSignal; reviewer: ContextualImageConfirmationReviewer }) {
      const raw = await rpc("loomic_get_contextual_image_confirmation_review", {
        p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId, p_run: input.runId,
      });
      if (raw === null) return null;
      const context = contextualConfirmationReviewSchema.parse(raw);
      // Do not truncate recent dialogue into a different speech act.
      if (context.messages.some(message => message.content.length > 12_000) ||
          context.messages.reduce((sum, message) => sum + message.content.length, 0) > 24_000) return null;
      const reviewed = await input.reviewer(context, { signal: input.signal });
      const anchor = reviewed.assistantMessageId;
      if (reviewed.decision !== "invite" || !anchor ||
          !context.messages.some(message => message.id === anchor && message.role === "assistant")) return null;
      const value = await rpc("loomic_bind_reviewed_contextual_image_confirmation", {
        p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId, p_run: input.runId,
        p_proposal: context.proposalId, p_assistant_message: anchor,
      });
      return typeof value === "string" ? value : null;
    },
    async reviewSemanticConfirmation(input: { userId: string; sessionId: string; canvasId: string; runId: string;
      signal: AbortSignal; reviewer: SemanticImageGenerationReviewer }): Promise<
        | { decision: "confirm_existing"; confirmationId: string }
        | { decision: "confirm_current_run" }
        | null
      > {
      const raw = await rpc("loomic_get_semantic_image_confirmation_review", {
        p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId, p_run: input.runId,
      });
      if (raw === null) {
        console.info("[image-semantic-confirmation] stage", { stage: "context", available: false });
        return null;
      }
      const context = semanticImageGenerationReviewSchema.parse(raw);
      console.info("[image-semantic-confirmation] stage", {
        stage: "context", available: true, proposalStatus: context.proposal.status,
        jobStatus: context.proposal.jobStatus ?? null, recentMessages: context.recentDialogue.length,
        recentCharacters: context.recentDialogue.reduce((sum, message) => sum + message.content.length, 0),
        currentCharacters: context.currentMessage.content.length,
      });
      // Never truncate a clause into a different authorization speech act.
      if (context.currentMessage.content.length > 8_000 ||
          context.recentDialogue.some(message => message.content.length > 4_000) ||
          context.recentDialogue.reduce((sum, message) => sum + message.content.length, 0) > 16_000)
        return null;
      const reviewed = await input.reviewer(context, { signal: input.signal });
      const decision = semanticImageGenerationDecisionSchema.parse(reviewed.decision);
      console.info("[image-semantic-confirmation] stage", { stage: "review", decision });
      if (decision !== "confirm_existing" && decision !== "confirm_current_run") return null;
      if (decision === "confirm_current_run") return { decision };
      const value = await rpc("loomic_bind_reviewed_semantic_image_confirmation", {
        p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId, p_run: input.runId,
        p_proposal: context.proposal.id,
      });
      console.info("[image-semantic-confirmation] stage", {
        stage: "bind", decision, result: typeof value === "string" ? "bound" : "rejected",
      });
      return typeof value === "string" ? { decision, confirmationId: value } : null;
    },
    async bindSemanticCurrentRunProposal(input: { userId: string; sessionId: string; canvasId: string;
      runId: string; proposalId: string; signal: AbortSignal; reviewer: SemanticImageGenerationReviewer }): Promise<string | null> {
      const raw = await rpc("loomic_get_semantic_current_run_image_confirmation_review", {
        p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId,
        p_run: input.runId, p_proposal: input.proposalId,
      });
      if (raw === null) return null;
      const context = semanticImageGenerationReviewSchema.parse(raw);
      if (context.currentMessage.content.length > 8_000 ||
          context.recentDialogue.some(message => message.content.length > 4_000) ||
          context.recentDialogue.reduce((sum, message) => sum + message.content.length, 0) > 16_000)
        return null;
      const reviewed = await input.reviewer(context, { signal: input.signal });
      if (semanticImageGenerationDecisionSchema.parse(reviewed.decision) !== "confirm_current_run") return null;
      const value = await rpc("loomic_bind_reviewed_semantic_current_run_image_confirmation", {
        p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId,
        p_run: input.runId, p_proposal: input.proposalId,
      });
      return typeof value === "string" ? value : null;
    },
  };
}

export type ImageProposalRelationService = ReturnType<typeof createImageProposalRelationService>;
