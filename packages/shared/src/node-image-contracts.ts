import { z } from "zod";
import { backgroundJobSchema } from "./job-contracts.js";
import { nativeImageResolutionValues } from "./native-image-size.js";

/** Direct node generation is an explicit user submission, not an Agent proposal. */
export const nodeImageSubmissionRequestSchema = z.object({
  request_id: z.string().uuid(),
  canvas_id: z.string().uuid(),
  element_id: z.string().min(1).max(200),
  // Preserve the actual prompt, including whitespace. Validation must not rewrite it.
  prompt: z.string().min(1).max(32_768).refine(value => value.trim().length > 0),
  model: z.string().min(1).max(200),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]),
  quality: z.enum(["standard", "hd", "ultra"]),
  resolution: z.enum(nativeImageResolutionValues).optional(),
}).strict();
export type NodeImageSubmissionRequest = z.infer<typeof nodeImageSubmissionRequestSchema>;

export const nodeImageSubmissionLookupSchema = z.object({
  requestId: z.string().uuid(),
  canvasId: z.string().uuid(),
  elementId: z.string().min(1).max(200),
}).strict();
export type NodeImageSubmissionLookup = z.infer<typeof nodeImageSubmissionLookupSchema>;

export const nodeImageSubmissionResponseSchema = z.object({
  job: backgroundJobSchema,
  replayed: z.boolean(),
}).strict();
export type NodeImageSubmissionResponse = z.infer<typeof nodeImageSubmissionResponseSchema>;

export const nodeImageSubmissionLookupResponseSchema = z.object({
  job: backgroundJobSchema.nullable(),
}).strict();
