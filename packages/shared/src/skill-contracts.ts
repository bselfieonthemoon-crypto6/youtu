import { z } from "zod";
import { skillReadinessSchema } from "./skill-runtime-contracts.js";

// === Enums ===

export const skillCategorySchema = z.enum([
  "design",
  "generation",
  "code",
  "data",
  "writing",
  "custom",
]);
export type SkillCategory = z.infer<typeof skillCategorySchema>;

export const skillSourceSchema = z.enum(["system", "community", "user"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

// === Entity Schemas ===

export const skillListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  category: skillCategorySchema,
  iconName: z.string().nullable(),
  source: skillSourceSchema,
  isFeatured: z.boolean(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  // Populated when listing for a workspace:
  installed: z.boolean().optional(),
  enabled: z.boolean().optional(),
  installedAt: z.string().datetime({ offset: true }).optional(),
  readiness: skillReadinessSchema.optional(),
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

// === Skill File Entry ===

export const skillFileEntrySchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  content: z.string(),
  mimeType: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>;

export const skillDetailSchema = skillListItemSchema.extend({
  license: z.string().nullable(),
  skillContent: z.string(),
  createdBy: z.string().nullable(),
  sourceUrl: z.string().nullable().optional(),
  packageName: z.string().nullable().optional(),
  files: z.array(skillFileEntrySchema).optional(),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

// === Request Schemas ===

export const SKILL_PACKAGE_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 2 * 1024 * 1024,
  maxContentBytes: 256 * 1024,
  maxPackageBytes: 8 * 1024 * 1024,
} as const;

/**
 * Image reference files are stored as base64 `content` with an `image/*`
 * mime type. They are delivered for preview/reference; the agent's text-only
 * skill snapshot must skip them rather than feed raw base64 to a model.
 */
export function isImageSkillMimeType(mimeType: string): boolean {
  return /^image\/(?:png|jpeg|webp|gif)$/i.test(mimeType);
}

/** Canonical, portable relative paths only; never normalize away traversal. */
export function isSafeSkillFilePath(value: string): boolean {
  if (value.length > 500 || !/^(scripts|references|assets)\//.test(value)) return false;
  if (/[\\:%?#\x00-\x1f\x7f]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

const textBytes = (value: string) => {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
};
const boundedText = (maxBytes: number) => z.string().refine(
  (value) => !value.includes("\0") && textBytes(value) <= maxBytes,
  `Text must not contain NUL and must fit within ${maxBytes} UTF-8 bytes.`,
);
const skillBodySchema = boundedText(SKILL_PACKAGE_LIMITS.maxContentBytes)
  .refine((value) => value.trim().length > 0, "Skill instructions must not be empty.");
export const skillPackageFileSchema = z.object({
  filePath: z.string().refine(isSafeSkillFilePath, "Use a safe relative path under scripts/, references/, or assets/."),
  content: boundedText(SKILL_PACKAGE_LIMITS.maxFileBytes),
  mimeType: z.string().min(1).max(100).regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/).optional(),
}).strict();
const packageFilesSchema = z.array(skillPackageFileSchema).max(SKILL_PACKAGE_LIMITS.maxFiles);
function validatePackageBudget(value: { skillContent?: string | undefined; files?: Array<{ filePath: string; content: string }> | undefined }, ctx: z.RefinementCtx) {
  const paths = new Set<string>();
  let bytes = textBytes(value.skillContent ?? "");
  for (const [index, file] of (value.files ?? []).entries()) {
    const key = file.filePath.toLowerCase();
    if (paths.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", index, "filePath"], message: "Duplicate file path (case-insensitive)." });
    paths.add(key);
    bytes += textBytes(file.content);
  }
  if (bytes > SKILL_PACKAGE_LIMITS.maxPackageBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "Skill package exceeds the 8 MiB total text budget." });
}

export const skillCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  category: skillCategorySchema,
  skillContent: skillBodySchema,
  iconName: z.string().max(100).optional(),
  files: packageFilesSchema.optional(),
}).strict().superRefine(validatePackageBudget);
export type SkillCreateRequest = z.infer<typeof skillCreateRequestSchema>;

export const skillUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  category: skillCategorySchema.optional(),
  skillContent: skillBodySchema.optional(),
  iconName: z.string().max(100).optional(),
  // Omitted: preserve all files. Present: replace the complete file set.
  files: packageFilesSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No fields to update.")
  .superRefine(validatePackageBudget);
export type SkillUpdateRequest = z.infer<typeof skillUpdateRequestSchema>;

export const workspaceSkillToggleRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();
export type WorkspaceSkillToggleRequest = z.infer<
  typeof workspaceSkillToggleRequestSchema
>;

export const skillImportRequestSchema = z.object({
  url: z.string().url().max(2000).regex(/^https:\/\/[^/?#@]+(?:[/?#]|$)/i, "Import requires an HTTPS URL without credentials."),
}).strict();
export const workspaceSkillInstallRequestSchema = z.object({ skillId: z.string().uuid() }).strict();
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;

// === Response Schemas ===

export const skillListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
});
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;

export const skillDetailResponseSchema = z.object({
  skill: skillDetailSchema,
});
export type SkillDetailResponse = z.infer<typeof skillDetailResponseSchema>;

export const workspaceSkillListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
});
export type WorkspaceSkillListResponse = z.infer<
  typeof workspaceSkillListResponseSchema
>;

export const skillFilesResponseSchema = z.object({
  files: z.array(skillFileEntrySchema),
});
export type SkillFilesResponse = z.infer<typeof skillFilesResponseSchema>;

// === Marketplace Schemas ===

export const marketplaceSkillSchema = z.object({
  packageName: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  downloads: z.number(),
  keywords: z.array(z.string()),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
});
export type MarketplaceSkill = z.infer<typeof marketplaceSkillSchema>;

export const marketplaceSearchResponseSchema = z.object({
  skills: z.array(marketplaceSkillSchema),
  total: z.number(),
});
export type MarketplaceSearchResponse = z.infer<typeof marketplaceSearchResponseSchema>;

export const marketplaceDetailSchema = marketplaceSkillSchema.extend({
  readme: z.string(),
  versions: z.array(z.string()),
  tarballUrl: z.string(),
});
export type MarketplaceDetail = z.infer<typeof marketplaceDetailSchema>;

export const marketplaceInstallRequestSchema = z.object({
  packageName: z.string().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
}).strict();
export type MarketplaceInstallRequest = z.infer<typeof marketplaceInstallRequestSchema>;
