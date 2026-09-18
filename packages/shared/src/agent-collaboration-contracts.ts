import { z } from "zod";
import { workspaceModelIdPattern } from "./uuid.js";

export const designExpertRoleSchema = z.enum([
  "reference_analysis", "design_planning", "design_review",
]);
export type DesignExpertRole = z.infer<typeof designExpertRoleSchema>;

const modelRef = z.string().regex(workspaceModelIdPattern)
  .transform(value => value.toLowerCase()).nullable();
// Updates are partial between settings sections, not within this value object.
// Missing fields must never turn into defaults and erase stored role selections.
export const agentCollaborationSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  maxParallel: z.number().int().min(1).max(3),
  maxTasksPerRun: z.number().int().min(1).max(8),
  timeoutMs: z.number().int().min(10_000).max(120_000),
  roleModels: z.object({ reference_analysis: modelRef, design_planning: modelRef, design_review: modelRef }).strict(),
}).strict();
export const agentCollaborationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxParallel: z.number().int().min(1).max(3).default(2),
  maxTasksPerRun: z.number().int().min(1).max(8).default(6),
  timeoutMs: z.number().int().min(10_000).max(120_000).default(90_000),
  roleModels: z.object({
    reference_analysis: modelRef.default(null),
    design_planning: modelRef.default(null),
    design_review: modelRef.default(null),
  }).strict().default({}),
}).strict();
export type AgentCollaborationSettings = z.infer<typeof agentCollaborationSettingsSchema>;

/** A fresh value per call: callers must not mutate a process-wide default. */
export function defaultAgentCollaborationSettings(): AgentCollaborationSettings {
  return agentCollaborationSettingsSchema.parse({});
}
