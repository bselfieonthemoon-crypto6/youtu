import { z } from "zod";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

const uuid = z.string().uuid();
export const agentContextScopeSchema = z.object({
  userId: uuid, workspaceId: uuid, sessionId: uuid, runId: uuid,
  taskId: uuid.nullable().optional(),
}).strict();
/** Constructed from authenticated runtime state, never from model arguments. */
export type AgentContextScope = z.infer<typeof agentContextScopeSchema>;
const coverageSchema = z.object({
  messageIds: z.array(uuid).max(2000).default([]),
  assetIds: z.array(uuid).max(200).default([]),
  omissions: z.array(z.string().max(2000)).max(100).default([]),
  sourceHash: z.string().max(128).optional(),
}).strict();
export const contextCommitSchema = z.object({
  expectedContextRevision: z.number().int().nonnegative(),
  sourceWatermark: z.string().min(1).max(128),
  summary: z.string().min(1).max(64000),
  coverage: coverageSchema,
  modelVersion: z.string().min(1).max(200),
  budgetPolicyVersion: z.string().min(1).max(200),
  publicPlan: z.unknown().optional(),
  budget: z.record(z.string(), z.unknown()).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ContextCommitInput = z.input<typeof contextCommitSchema>;
const snapshotSchema = z.object({
  id: uuid, contextRevision: z.number().int().nonnegative(), sourceWatermark: z.string(),
  taskChainId: uuid.nullable(), taskRevision: z.number().nullable(), designRevision: z.number().nullable(),
  summary: z.string(), coverage: coverageSchema, contentHash: z.string(),
  modelVersion: z.string(), budgetPolicyVersion: z.string(), createdAt: z.string(),
  publicPlan: z.unknown().optional(), budget: z.record(z.string(), z.unknown()).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});
export type AgentContextSnapshot = z.infer<typeof snapshotSchema>;
const captureSchema = z.object({
  contextRevision: z.number().int().nonnegative(), sourceWatermark: z.string(),
  historyEpoch: z.number().int().nonnegative(),
  taskChainId: uuid.nullable(), taskRevision: z.number().nullable(), designRevision: z.number().nullable(),
  snapshot: snapshotSchema.nullable(),
  executionStatePolicy: z.literal("reload_live_authority"),
});
export type AgentContextCapture = z.infer<typeof captureSchema>;
export const evidenceQuerySchema = z.object({
  messageIds: z.array(uuid).min(1).max(20).optional(),
  assetIds: z.array(uuid).min(1).max(20).optional(),
  cursor: z.object({ createdAt: z.string().datetime({ offset: true }), id: uuid }).strict().optional(),
  limit: z.number().int().min(1).max(20).default(8),
}).strict().refine(value => !(value.messageIds && value.cursor), "Use message IDs or a cursor, not both.");
export type ConversationEvidenceQuery = z.input<typeof evidenceQuerySchema>;
const evidenceResultSchema = z.object({
  messages: z.array(z.object({
    id: uuid, role: z.enum(["user", "assistant"]), content: z.string().nullable(), createdAt: z.string(),
    contentHash: z.string(), assetIds: z.array(uuid), unavailableReason: z.string().nullable(),
  })),
  attachments: z.array(z.object({ id: uuid, mimeType: z.string().nullable(), byteSize: z.number().nullable(), createdAt: z.string() })),
  missingMessageIds: z.array(uuid), missingAssetIds: z.array(uuid),
  nextCursor: z.object({ createdAt: z.string(), id: uuid }).nullable(),
  sourceWatermark: z.string(), contextRevision: z.number().int().nonnegative(),
  authority: z.literal("historical_evidence_only"),
});
export type ConversationEvidence = z.infer<typeof evidenceResultSchema>;
export type AgentContextService = {
  capture(scope: AgentContextScope): Promise<AgentContextCapture>;
  current(scope: AgentContextScope): Promise<AgentContextCapture>;
  commit(scope: AgentContextScope, input: ContextCommitInput): Promise<AgentContextSnapshot>;
  record(scope: AgentContextScope, input: ContextCommitInput): Promise<AgentContextSnapshot>;
  readEvidence(scope: AgentContextScope, query?: ConversationEvidenceQuery): Promise<ConversationEvidence>;
};

export class AgentContextError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 500) { super(code); this.name = "AgentContextError"; }
}

export function createAgentContextService(options: { getAdminClient: () => AdminSupabaseClient }): AgentContextService {
  async function rpc(name: string, scope: AgentContextScope, extra: Record<string, unknown> = {}) {
    const trusted = agentContextScopeSchema.parse(scope);
    const { data, error } = await (options.getAdminClient().rpc as any)(name, {
      p_user: trusted.userId, p_workspace: trusted.workspaceId, p_session: trusted.sessionId,
      p_run: trusted.runId, p_task: trusted.taskId ?? null, ...extra,
    });
    if (error) {
      // Never copy database error text: it can contain private source material.
      const code = /agent_context_[a-z_]+/.exec(error.message ?? "")?.[0] ?? "agent_context_persistence_failed";
      throw new AgentContextError(code, code.includes("forbidden") ? 403 : code.includes("invalid") ? 400
        : code.includes("conflict") || code.includes("superseded") || code.includes("missing") ? 409 : 500);
    }
    return data;
  }
  const capture = async (scope: AgentContextScope) => captureSchema.parse(await rpc("loomic_agent_context_capture", scope));
  const commit = async (scope: AgentContextScope, input: ContextCommitInput) => {
    const payload = contextCommitSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 256 * 1024) throw new AgentContextError("agent_context_payload_invalid", 400);
    return snapshotSchema.parse(await rpc("loomic_agent_context_commit", scope, { p_payload: payload }));
  };
  return {
    capture, current: capture, commit, record: commit,
    async readEvidence(scope, query = {}) {
      return evidenceResultSchema.parse(await rpc("loomic_agent_context_evidence", scope, { p_query: evidenceQuerySchema.parse(query) }));
    },
  };
}
