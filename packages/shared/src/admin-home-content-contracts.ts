import { z } from "zod";

import { timestampSchema } from "./contracts.js";

/**
 * Platform management for the two home content libraries (discovery and examples).
 *
 * The browser reads these tables directly under RLS, which grants SELECT on active
 * rows only, so `isActive` *is* the publish switch: a case additionally needs its
 * category to be active, which is why every list row carries `categoryIsActive` and
 * the toggle returns `hiddenItems`.
 *
 * Two rules are baked into the contracts rather than left to the UI:
 *   * `sortOrder` is never part of an upsert. There is a unique index on
 *     (category_key, sort_order), so writing a position directly collides. New rows
 *     append, and order changes travel through the reorder requests, which always
 *     name every entry exactly once.
 *   * There is no category delete. The category foreign keys cascade, so a delete
 *     would remove the whole library; unpublishing is the offered alternative.
 */

export const ADMIN_HOME_CONTENT_KINDS = ["discovery_case", "example_example"] as const;
export const ADMIN_HOME_CATEGORY_KINDS = ["discovery_category", "example_category"] as const;
export const ADMIN_HOME_TOGGLE_KINDS = [...ADMIN_HOME_CONTENT_KINDS, ...ADMIN_HOME_CATEGORY_KINDS] as const;

export const homeContentKindSchema = z.enum(ADMIN_HOME_CONTENT_KINDS);
export const homeCategoryKindSchema = z.enum(ADMIN_HOME_CATEGORY_KINDS);
export const homeToggleKindSchema = z.enum(ADMIN_HOME_TOGGLE_KINDS);

const reasonSchema = z.string().trim().min(2).max(500);
const httpUrl = z.string().trim().url().max(1000);
/** Optional media fields accept an empty string, which the database stores as "". */
const optionalHttpUrl = z.union([httpUrl, z.literal("")]);
const optionalText = (max: number) => z.string().trim().max(max).nullable();

/**
 * Read-side input mentions stay lenient: rows written before this console existed
 * must still render. The write schema below is the strict one.
 */
export const adminHomeInputMentionSchema = z.object({
  name: z.string().default(""),
  type: z.string().default("tool"),
  imgSrc: z.string().default(""),
});

export const homeInputMentionWriteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["tool", "image"]),
  imgSrc: httpUrl,
}).strict();

export const adminHomeDiscoveryCategorySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  updatedAt: timestampSchema,
  itemCount: z.number().int().nonnegative(),
  activeItemCount: z.number().int().nonnegative(),
});

export const adminHomeExampleCategorySchema = adminHomeDiscoveryCategorySchema.extend({
  dataType: z.string().nullable(),
  accent: z.string().nullable(),
});

export const adminHomeContentOverviewResponseSchema = z.object({
  discovery: z.object({
    categories: z.array(adminHomeDiscoveryCategorySchema),
    itemCount: z.number().int().nonnegative(),
    activeItemCount: z.number().int().nonnegative(),
  }),
  example: z.object({
    categories: z.array(adminHomeExampleCategorySchema),
    itemCount: z.number().int().nonnegative(),
    activeItemCount: z.number().int().nonnegative(),
  }),
});

export const adminHomeDiscoveryCaseSchema = z.object({
  id: z.string().min(1),
  categoryKey: z.string().min(1),
  title: z.string(),
  coverImageUrl: z.string(),
  authorName: z.string(),
  authorAvatarUrl: z.string(),
  caseUrl: z.string(),
  seedPrompt: z.string(),
  viewCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** `false` means the entry is published but its category is not, so it is hidden. */
  categoryIsActive: z.boolean().nullable(),
});

export const adminHomeExampleSchema = z.object({
  id: z.string().min(1),
  categoryKey: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  imageUrls: z.array(z.string()),
  inputMentions: z.array(adminHomeInputMentionSchema),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  categoryIsActive: z.boolean().nullable(),
});

export const adminHomeContentListResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("discovery_case"),
    total: z.number().int().nonnegative(),
    items: z.array(adminHomeDiscoveryCaseSchema),
  }),
  z.object({
    kind: z.literal("example_example"),
    total: z.number().int().nonnegative(),
    items: z.array(adminHomeExampleSchema),
  }),
]);

export const adminHomeDiscoveryCaseUpsertRequestSchema = z.object({
  caseId: z.string().trim().min(1).max(64).nullable(),
  categoryKey: z.string().trim().min(1).max(63),
  title: z.string().trim().min(1).max(200),
  coverImageUrl: httpUrl,
  authorName: optionalText(100),
  authorAvatarUrl: optionalHttpUrl.nullable(),
  caseUrl: optionalText(1000),
  seedPrompt: optionalText(4000),
  isActive: z.boolean(),
  reason: reasonSchema,
}).strict();

export const adminHomeExampleUpsertRequestSchema = z.object({
  exampleId: z.string().uuid().nullable(),
  categoryKey: z.string().trim().min(1).max(63),
  title: z.string().trim().min(1).max(200),
  prompt: optionalText(8000),
  imageUrls: z.array(httpUrl).max(12),
  inputMentions: z.array(homeInputMentionWriteSchema).max(12),
  isActive: z.boolean(),
  reason: reasonSchema,
}).strict();

export const adminHomeCategoryUpsertRequestSchema = z.object({
  kind: homeCategoryKindSchema,
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  label: z.string().trim().min(1).max(100),
  /** Required for example categories; ignored by discovery categories. */
  dataType: optionalText(40),
  accent: z.union([z.literal("special"), z.literal("")]).nullable(),
  isActive: z.boolean(),
  reason: reasonSchema,
}).strict();

export const adminHomeContentToggleRequestSchema = z.object({
  kind: homeToggleKindSchema,
  entityId: z.string().trim().min(1).max(64),
  isActive: z.boolean(),
  reason: reasonSchema,
}).strict();

export const adminHomeContentReorderRequestSchema = z.object({
  kind: homeContentKindSchema,
  categoryKey: z.string().trim().min(1).max(63),
  orderedIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  reason: reasonSchema,
}).strict();

export const adminHomeCategoryReorderRequestSchema = z.object({
  kind: homeCategoryKindSchema,
  orderedKeys: z.array(z.string().trim().min(1).max(63)).min(1).max(100),
  reason: reasonSchema,
}).strict();

export const adminHomeContentDeleteRequestSchema = z.object({
  kind: homeContentKindSchema,
  entityId: z.string().trim().min(1).max(64),
  reason: reasonSchema,
}).strict();

export const adminHomeContentUpsertResponseSchema = z.object({
  id: z.string().min(1),
  created: z.boolean(),
  sortOrder: z.number().int(),
});

export const adminHomeCategoryUpsertResponseSchema = z.object({
  key: z.string().min(1),
  kind: homeCategoryKindSchema,
  created: z.boolean(),
  sortOrder: z.number().int(),
});

export const adminHomeContentToggleResponseSchema = z.object({
  kind: homeToggleKindSchema,
  id: z.string().min(1),
  isActive: z.boolean(),
  wasActive: z.boolean(),
  /** Entries this change hides or reveals because they sit under the category. */
  hiddenItems: z.number().int().nonnegative(),
});

export const adminHomeContentReorderResponseSchema = z.object({
  kind: homeContentKindSchema,
  categoryKey: z.string().min(1),
  ordered: z.number().int().positive(),
});

export const adminHomeCategoryReorderResponseSchema = z.object({
  kind: homeCategoryKindSchema,
  ordered: z.number().int().positive(),
});

export const adminHomeContentDeleteResponseSchema = z.object({
  kind: homeContentKindSchema,
  id: z.string().min(1),
  deleted: z.literal(true),
});

export type AdminHomeContentOverviewResponse = z.infer<typeof adminHomeContentOverviewResponseSchema>;
export type AdminHomeDiscoveryCase = z.infer<typeof adminHomeDiscoveryCaseSchema>;
export type AdminHomeExample = z.infer<typeof adminHomeExampleSchema>;
export type AdminHomeContentListResponse = z.infer<typeof adminHomeContentListResponseSchema>;
export type AdminHomeDiscoveryCaseUpsertRequest = z.infer<typeof adminHomeDiscoveryCaseUpsertRequestSchema>;
export type AdminHomeExampleUpsertRequest = z.infer<typeof adminHomeExampleUpsertRequestSchema>;
export type AdminHomeCategoryUpsertRequest = z.infer<typeof adminHomeCategoryUpsertRequestSchema>;
export type AdminHomeContentToggleRequest = z.infer<typeof adminHomeContentToggleRequestSchema>;
export type AdminHomeContentReorderRequest = z.infer<typeof adminHomeContentReorderRequestSchema>;
export type AdminHomeCategoryReorderRequest = z.infer<typeof adminHomeCategoryReorderRequestSchema>;
export type AdminHomeContentDeleteRequest = z.infer<typeof adminHomeContentDeleteRequestSchema>;
export type AdminHomeDiscoveryCategory = z.infer<typeof adminHomeDiscoveryCategorySchema>;
export type AdminHomeExampleCategory = z.infer<typeof adminHomeExampleCategorySchema>;
export type HomeInputMentionWrite = z.infer<typeof homeInputMentionWriteSchema>;
export type AdminHomeInputMention = z.infer<typeof adminHomeInputMentionSchema>;
