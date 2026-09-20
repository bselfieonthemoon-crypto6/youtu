import { parseMastraImageSourceReferences, type MastraImageSourceReference } from "../../agent/mastra-image-source-grounding.js";

/**
 * Persisted submission values only; recovery never requotes an old job.
 *
 * `fallbackSourceReferences` exists for the one in-process caller that holds
 * the roles before they are durable (the submitter's fresh-create path, whose
 * insert response is supplied by its test seam). Everything read back from the
 * database uses the persisted `source_references` payload instead.
 */
export function imageSubmissionReceipt(
  job: { payload: unknown; credits_cost?: number | null },
  fallbackSourceReferences?: readonly MastraImageSourceReference[],
) {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload as Record<string, unknown> : {};
  const cost = payload.mastra_credits_cost ?? job.credits_cost;
  const creditsCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  const pricingVersion = typeof payload.mastra_pricing_version === "string" ? payload.mastra_pricing_version : undefined;
  const actualQuality: "Low" | "Medium" | "High" = payload.quality === "ultra" ? "High" : payload.quality === "hd" ? "Medium" : "Low";
  const actualResolution: "1K" | "2K" | "4K" = payload.resolution === "4k" ? "4K" : payload.resolution === "2k" ? "2K" : "1K";
  // What each reference image IS to this job: structured role data the product
  // reads directly, instead of prose the reader has to interpret. A job with no
  // references persisted no such field, so the receipt carries none either.
  const sourceReferences: MastraImageSourceReference[] | undefined =
    parseMastraImageSourceReferences(payload.source_references)
    ?? parseMastraImageSourceReferences(fallbackSourceReferences);
  return { ...(creditsCost !== undefined ? { creditsCost } : {}), ...(pricingVersion ? { pricingVersion } : {}),
    ...(sourceReferences ? { sourceReferences } : {}), actualQuality, actualResolution };
}
