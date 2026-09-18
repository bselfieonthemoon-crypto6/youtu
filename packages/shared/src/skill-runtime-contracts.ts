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

/**
 * Upper bound for `whenToUse`. The text is model-facing selection metadata that
 * is reprinted in EVERY turn's always-on Skill catalog, so it is deliberately
 * short: 400 characters is roughly twice the longest existing package
 * description — enough for one "use this when …" sentence plus a short
 * "do not use it when …" clause, while keeping the worst case per line
 * (400 CJK characters ≈ 1200 UTF-8 bytes) bounded.
 */
export const SKILL_WHEN_TO_USE_MAX_CHARS = 400;

/** Dependency declarations describe a workflow, never grant execution authority.
 *
 * STRICT, including this outer object: a Skill package is the unit users add, so a
 * typo in its `metadata.loomic` block (`whentouse`, `outputKind`, `capability`)
 * must fail loudly at parse time instead of being silently stripped — silently
 * stripping it looks exactly like the field being absent, and the package then
 * behaves as if its author never declared it. */
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
  /**
   * Model-facing selection text: the situation in the user's own terms that
   * makes this guide apply ("use this when …"), optionally with the contrasting
   * case ("do not use it when …") that stops two guides from competing. It is
   * what the always-on catalog shows so the model can select a Skill itself.
   * Selection metadata only, exactly like `routing` and `capabilities`: it
   * grants no tool, model, ratio, budget or execution authority, and it never
   * loads the Skill body (that still requires use_skill/compose_skills).
   */
  whenToUse: z.string().trim().min(1).max(SKILL_WHEN_TO_USE_MAX_CHARS).optional(),
  /**
   * Selection vocabulary for this package, used by `matchedSkillHints`.
   *
   * These keywords no longer select anything by themselves: the runtime reports every
   * package the user's own words point at as a CANDIDATE, and the model decides which
   * guide to read from the always-on catalog. The candidate set is what the routing
   * notice shows the user, and a candidate the model never reads is logged in
   * `[skill-dispatch-outcome]` — which is how a package whose keywords are wrong or
   * whose `whenToUse` text does not describe its situations gets found and fixed.
   *
   * Matching is on word boundaries for ASCII keywords (a singular keyword also
   * accepts one trailing `s`), so a package declaring `cover` cannot be surfaced by
   * "recover"; CJK keywords are matched as substrings, where there is no boundary.
   */
  routing: z.object({
    keywords: z.array(z.string().min(1).max(60)).min(1).max(30),
    priority: z.number().int().min(0).max(1000),
    /**
     * `primary` (the default) marks a package as a deliverable; `helper` marks a
     * modifier of one (workflow / reference / prompt guides). The tier decides how
     * the candidate is reported — helpers are listed separately in the notice, because
     * they modify a deliverable rather than being one — and it keeps a helper from
     * becoming the session's remembered deliverable. It no longer decides any
     * competition: nothing competes, since the runtime ranks nothing.
     */
    tier: z.enum(["primary", "helper"]).optional(),
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
}).strict();
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
