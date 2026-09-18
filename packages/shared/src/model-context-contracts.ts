import { z } from "zod";

/** Administrator-supplied, verified limits for the actual upstream endpoint. */
export const modelContextProfileSchema = z.object({
  contextWindowTokens: z.number().int().min(8192).max(4_000_000),
  maxInputTokens: z.number().int().min(1024).max(4_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  profileSource: z.string().trim().min(1).max(500).refine(value => value.toLowerCase() !== "unverified"),
  verifiedAt: z.string().datetime({ offset: true }),
  profileVersion: z.string().trim().min(1).max(100),
  imageTokensPerImage: z.number().int().min(1).max(100_000).optional(),
}).strict().refine(value => value.maxInputTokens <= value.contextWindowTokens &&
  value.maxOutputTokens < value.contextWindowTokens, { message: "Input/output limits exceed the context window." });

export type ModelContextProfile = z.infer<typeof modelContextProfileSchema>;
