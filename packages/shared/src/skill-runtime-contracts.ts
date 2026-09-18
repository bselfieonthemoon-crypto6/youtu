import { z } from "zod";

export const skillModelRoleSchema = z.enum(["planner", "vision", "image"]);

export const SKILL_COMPOSITION_ROLES = ["domain", "workflow", "reference", "prompt", "constraint"] as const;
export const SKILL_COMPOSITION_STAGES = ["design", "reference", "prompt", "review", "delivery"] as const;
export const skillCompositionMetadataSchema = z.object({
  role: z.enum(SKILL_COMPOSITION_ROLES),
  stages: z.array(z.enum(SKILL_COMPOSITION_STAGES)).min(1).max(SKILL_COMPOSITION_STAGES.length)
    .refine(stages => new Set(stages).size === stages.length, "Composition stages must be unique."),
}).strict();
export type SkillCompositionMetadata = z.infer<typeof skillCompositionMetadataSchema>;
export type SkillCompositionRole = SkillCompositionMetadata["role"];
export type SkillCompositionStage = SkillCompositionMetadata["stages"][number];

/** Dependency declarations describe a workflow, never grant execution authority. */
export const skillRuntimeMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  execution: z.enum(["native", "image", "hybrid", "guidance"]),
  intents: z.array(z.string().min(1).max(100)).max(30),
  outputKinds: z.array(z.string().min(1).max(100)).max(20),
  requiredTools: z.array(z.string().min(1).max(100)).max(30),
  optionalTools: z.array(z.string().min(1).max(100)).max(30),
  // Capability hints only: a package cannot declare user intent or grant authority.
  composition: skillCompositionMetadataSchema.optional(),
  // Server-recognized capabilities (for example "nonstandard-ratio"). The runtime
  // never hardcodes a Skill slug; it acts on declared capabilities instead.
  capabilities: z.array(z.string().min(1).max(60)).max(20).optional(),
  /** The runtime attaches published workspace library references for this Skill. */
  attachWorkspaceLibrary: z.boolean().optional(),
  /** Deliverable keywords used to auto-select this Skill as the primary one. */
  routing: z.object({
    keywords: z.array(z.string().min(1).max(60)).min(1).max(30),
    priority: z.number().int().min(0).max(1000),
  }).strict().optional(),
  models: z.array(z.object({
    role: skillModelRoleSchema,
    required: z.boolean(),
    preferredIds: z.array(z.string().min(1).max(200)).max(20),
    exactIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  })).max(10),
  limitations: z.array(z.string().min(1).max(1500)).max(30),
  examples: z.array(z.string().min(1).max(1500)).max(20),
  sources: z.array(z.object({
    title: z.string().min(1).max(200),
    url: z.string().url().refine(value => /^https?:\/\//.test(value), "Expected an HTTP(S) source"),
    license: z.string().max(200).optional(),
    relation: z.enum(["inspired-by", "adapted-from"]),
  })).max(20),
});
export type SkillRuntimeMetadata = z.infer<typeof skillRuntimeMetadataSchema>;

export const skillReadinessSchema = z.object({
  status: z.enum(["ready", "limited", "unavailable"]),
  reasons: z.array(z.string()),
  models: z.array(z.object({
    role: skillModelRoleSchema,
    modelId: z.string(),
    upstreamModelId: z.string(),
  })),
});
export type SkillReadiness = z.infer<typeof skillReadinessSchema>;

export function readSkillRuntimeMetadata(metadata: unknown): SkillRuntimeMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = skillRuntimeMetadataSchema.safeParse((metadata as Record<string, unknown>).loomic);
  return parsed.success ? parsed.data : null;
}
