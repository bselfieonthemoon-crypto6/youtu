import { z } from "zod";

import { timestampSchema, userIdSchema } from "./contracts.js";
import { uuidPattern } from "./uuid.js";

/**
 * Skill images for the platform catalog.
 *
 * A preview is a row pointing at a platform-scope `asset_objects` entry, so the
 * bytes live in the existing `platform-assets` bucket. Drafts are visible only in
 * the console; published previews are what customers see, and they are served
 * through a server route because that bucket has no authenticated storage policy.
 */

export const adminSkillCatalogEntrySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().nullable(),
  category: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
  iconName: z.string().nullable(),
  /** The skill's own declared output kinds, straight from its metadata. */
  outputKinds: z.array(z.string()),
  enabledWorkspaces: z.number().int().nonnegative(),
  installCount: z.number().int().nonnegative(),
  previewCount: z.number().int().nonnegative(),
  publishedPreviewCount: z.number().int().nonnegative(),
  hasPublishedCover: z.boolean(),
});

export const adminSkillCatalogResponseSchema = z.object({
  skills: z.array(adminSkillCatalogEntrySchema),
});

export const adminSkillPreviewSchema = z.object({
  id: z.string().min(1),
  skillId: z.string().min(1),
  role: z.enum(["cover", "example"]),
  caption: z.string().nullable(),
  sortOrder: z.number().int().nonnegative(),
  status: z.enum(["draft", "published"]),
  assetObjectId: z.string().min(1),
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  createdBy: userIdSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Short-lived signed URL; null when signing failed rather than a broken image. */
  imageUrl: z.string().nullable(),
});

export const adminSkillPreviewListResponseSchema = z.object({
  previews: z.array(adminSkillPreviewSchema),
});

export const adminSkillPreviewReasonRequestSchema = z.object({
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminSkillPreviewOrderRequestSchema = z.object({
  orderedPreviewIds: z.array(z.string().regex(uuidPattern, "must be a UUID")).min(1).max(200),
  reason: z.string().trim().min(2).max(500),
}).strict();

/** What a signed-in customer may see: published previews only, no ids exposed. */
export const publishedSkillPreviewSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["cover", "example"]),
  caption: z.string().nullable(),
  imageUrl: z.string(),
});

export const publishedSkillPreviewsResponseSchema = z.object({
  previews: z.array(publishedSkillPreviewSchema),
});

export type AdminSkillCatalogEntry = z.infer<typeof adminSkillCatalogEntrySchema>;
export type AdminSkillCatalogResponse = z.infer<typeof adminSkillCatalogResponseSchema>;
export type AdminSkillPreview = z.infer<typeof adminSkillPreviewSchema>;
export type AdminSkillPreviewListResponse = z.infer<typeof adminSkillPreviewListResponseSchema>;
export type AdminSkillPreviewOrderRequest = z.infer<typeof adminSkillPreviewOrderRequestSchema>;
export type PublishedSkillPreview = z.infer<typeof publishedSkillPreviewSchema>;
export type PublishedSkillPreviewsResponse = z.infer<typeof publishedSkillPreviewsResponseSchema>;
