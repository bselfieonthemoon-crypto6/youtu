/**
 * Shared image-generation contracts.
 *
 * Owns the type/schema surface that more than one module needs: the tool input
 * shape, the job-submission and persistence callbacks, the billing receipt and
 * the server-only model-choice constraint.
 *
 * Why it was split out of the retired legacy image-generation tool module: that
 * file also carried the two-round proposal tool. The Mastra runtime
 * (`mastra-image-tool.ts` -> `mastra-image-jobs.ts`) only ever needed these
 * contracts, so they must not live behind the deleted tool machinery.
 */
import { z } from "zod";
import type { DesignJobTarget, ImageForegroundPolicy } from "@loomic/shared";

export type ImageGenerateInput = {
  /** Server-only model choice authority frozen with the proposal. */
  modelConstraint?: ImageGenerationModelConstraint;
  /** Server-only execution/price quote for native-design foreground delivery. */
  foregroundPolicy?: ImageForegroundPolicy;
  operation?: "generate" | "remove_background";
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: string;
  resolution?: "1k" | "2k" | "4k";
  outputFormat?: string;
  inputImages?: string[];
  sourceUsage?: "edit" | "reference";
  aspectRatioIntent?: "preserve_source" | "resize";
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  target?: DesignJobTarget;
};

export type GenerationBillingSummary = {
  estimate: number;
  charged: number;
  balanceAfter: number;
  currency: "credits";
};

/**
 * Optional function to persist a generated image to OSS.
 * Accepts the ephemeral URL and returns a persistent signed URL.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

/**
 * Submit an image generation job and wait for it to complete.
 * Returns the final result: signed_url on success, error on failure.
 */
export type SubmitImageJobFn = (input: {
  background?: "transparent" | "opaque" | "auto";
  proposalId?: string;
  /** Server-only recovery mode. Missing jobs must never be recreated. */
  replayOnly?: boolean;
  operation?: "generate" | "remove_background";
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  resolution?: "1k" | "2k" | "4k";
  outputFormat?: string;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  target?: DesignJobTarget;
  foregroundPolicy?: ImageForegroundPolicy;
}) => Promise<{
  status?: "processing" | "succeeded";
  jobId: string;
  elementId?: string;
  imageUrl?: string;
  assetId?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
  errorCode?: string;
  /** Eligibility for explicit recovery, never permission to retry automatically. */
  retryEligible?: boolean;
  billing?: GenerationBillingSummary;
  /** Server-authoritative persisted image submission receipt. */
  creditsCost?: number;
  pricingVersion?: string;
  actualQuality?: "Low" | "Medium" | "High";
  actualResolution?: "1K" | "2K" | "4K";
  design_id?: string;
  object_id?: string;
  revision?: number;
  finalization_status?: "completed" | "needs_attention" | "failed";
  preview_status?: "queued" | "failed" | "unavailable";
}>;

export const imageGenerationModelConstraintSchema = z.object({
  manualModelIds: z.array(z.string().min(1)).max(100).optional(),
  mentionedModelIds: z.array(z.string().min(1)).max(100).optional(),
}).strict();
export type ImageGenerationModelConstraint = z.infer<typeof imageGenerationModelConstraintSchema>;

export type ImageGenerationModelResolution =
  | { ok: true; args: Record<string, unknown>; model: string; repaired: boolean }
  | { ok: false; code: string; error: string };
