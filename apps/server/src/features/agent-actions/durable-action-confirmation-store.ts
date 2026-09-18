import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";

export const durableActionSchema = z.object({
  confirmationId: z.string().uuid(),
  kind: z.literal("design_mutation"),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  canvasId: z.string().uuid(),
  taskId: z.string().uuid(),
  taskRevision: z.number().int().positive(),
  originRunId: z.string().uuid(),
  toolExecutionId: z.string().uuid(),
  workflowStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  details: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "executing", "applied", "canceled"]),
  claimToken: z.string().uuid().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  completionDone: z.boolean(),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type DurableActionConfirmation = z.infer<typeof durableActionSchema>;

const claimSchema = z.discriminatedUnion("state", [
  z.object({ state: z.enum(["not_found", "canceled", "expired", "stale", "executing"]) }).strict(),
  z.object({ state: z.enum(["claimed", "applied"]), action: durableActionSchema }).strict(),
]);
const recoverySchema = z.array(durableActionSchema).max(10);
export type DurableActionClaim = z.infer<typeof claimSchema>;

export type DurableActionConfirmationStore = ReturnType<typeof createDurableActionConfirmationStore>;

export function createDurableActionConfirmationStore(
  getAdminClient: () => AdminSupabaseClient,
) {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await (getAdminClient().rpc as any)(name, args);
    if (error) throw new Error(error.message || "agent_confirmation_persistence_failed");
    return data;
  }
  return {
    async create(input: Omit<DurableActionConfirmation,
      "status" | "claimToken" | "result" | "completionDone" | "confirmedAt">) {
      return durableActionSchema.parse(await rpc("loomic_create_agent_action_confirmation", {
        p_confirmation: input.confirmationId,
        p_kind: input.kind,
        p_user: input.userId,
        p_workspace: input.workspaceId,
        p_session: input.sessionId,
        p_canvas: input.canvasId,
        p_task: input.taskId,
        p_task_revision: input.taskRevision,
        p_origin_run: input.originRunId,
        p_tool_execution: input.toolExecutionId,
        p_workflow_step: input.workflowStepId,
        p_details: input.details,
        p_payload: input.payload,
        p_expires_at: input.expiresAt,
      }));
    },
    async claim(confirmationId: string, userId: string, canvasId: string) {
      return claimSchema.parse(await rpc("loomic_claim_agent_action_confirmation", {
        p_confirmation: confirmationId, p_user: userId, p_canvas: canvasId,
      }));
    },
    async listRecoveryPending(userId: string, sessionId: string) {
      return recoverySchema.parse(await rpc("loomic_list_agent_action_confirmation_recovery", {
        p_user: userId, p_session: sessionId, p_limit: 10,
      }));
    },
    async finishApplied(confirmationId: string, claimToken: string, result: Record<string, unknown>) {
      return await rpc("loomic_finish_agent_action_confirmation", {
        p_confirmation: confirmationId, p_token: claimToken, p_result: result,
      }) === true;
    },
    async release(confirmationId: string, claimToken: string) {
      return await rpc("loomic_release_agent_action_confirmation", {
        p_confirmation: confirmationId, p_token: claimToken,
      }) === true;
    },
    async complete(confirmationId: string) {
      return await rpc("loomic_complete_agent_action_confirmation", {
        p_confirmation: confirmationId,
      }) === true;
    },
    async cancel(confirmationId: string, userId: string, canvasId: string) {
      return await rpc("loomic_cancel_agent_action_confirmation", {
        p_confirmation: confirmationId, p_user: userId, p_canvas: canvasId,
      }) === true;
    },
  };
}
