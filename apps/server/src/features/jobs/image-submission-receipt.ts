/** Persisted submission values only; recovery never requotes an old job. */
export function imageSubmissionReceipt(job: { payload: unknown; credits_cost?: number | null }) {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload as Record<string, unknown> : {};
  const cost = payload.mastra_credits_cost ?? job.credits_cost;
  const creditsCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  const pricingVersion = typeof payload.mastra_pricing_version === "string" ? payload.mastra_pricing_version : undefined;
  const actualQuality: "Low" | "Medium" | "High" = payload.quality === "ultra" ? "High" : payload.quality === "hd" ? "Medium" : "Low";
  const actualResolution: "1K" | "2K" | "4K" = payload.resolution === "4k" ? "4K" : payload.resolution === "2k" ? "2K" : "1K";
  return { ...(creditsCost !== undefined ? { creditsCost } : {}), ...(pricingVersion ? { pricingVersion } : {}), actualQuality, actualResolution };
}
