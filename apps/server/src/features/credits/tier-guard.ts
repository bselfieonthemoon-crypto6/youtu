// @credits-system — Tier enforcement: model access, resolution limits, concurrency guards per plan
import type {
  BackgroundJobType,
  BillingErrorCode,
  ImageQualityLevel,
  NativeImageResolution,
  SubscriptionPlan,
  VideoResolution,
} from "@loomic/shared";
import {
  canAccessModel,
  canUseResolution,
  canUseVideoResolution,
  getImageCreditCost,
  getVideoCreditCost,
  PLAN_CONFIGS,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";

/**
 * Master switch for every commercial generation gate. It is intentionally
 * disabled during product validation. Switching this one value back to true
 * restores model tiers, resolution limits, concurrency limits and credit
 * charging together.
 */
export const COMMERCIALIZATION_ENFORCEMENT_ENABLED = [
  "1",
  "true",
  "yes",
  "on",
].includes(
  (process.env.LOOMIC_COMMERCIALIZATION_ENABLED ?? "false")
    .trim()
    .toLowerCase(),
);

export function isModelAccessible(
  plan: SubscriptionPlan | null,
  modelId: string,
): boolean {
  return (
    !COMMERCIALIZATION_ENFORCEMENT_ENABLED ||
    (plan !== null && canAccessModel(plan, modelId))
  );
}

// ── Error ────────────────────────────────────────────────────

export type TierGuardErrorCode = Exclude<BillingErrorCode, "insufficient_credits">;

export class TierGuardError extends Error {
  readonly statusCode: number;
  readonly code: TierGuardErrorCode;

  constructor(
    code: TierGuardError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "TierGuardError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Pixel resolution is billed independently from provider quality semantics. */
export function imageResolutionBillingQuality(
  resolution: NativeImageResolution | undefined,
  fallback: ImageQualityLevel,
): ImageQualityLevel {
  const resolutionTier: ImageQualityLevel = resolution === "4k" ? "ultra" : resolution === "2k" ? "hd" : "standard";
  const rank: Record<ImageQualityLevel, number> = { standard: 0, hd: 1, ultra: 2 };
  return rank[resolutionTier] > rank[fallback] ? resolutionTier : fallback;
}

// ── Types ────────────────────────────────────────────────────

export type TierGuard = {
  checkModelAccess(plan: SubscriptionPlan, modelId: string): void;
  checkResolution(plan: SubscriptionPlan, quality: ImageQualityLevel): void;
  checkVideoResolution(plan: SubscriptionPlan, resolution: VideoResolution): void;
  checkConcurrency(
    workspaceId: string,
    plan: SubscriptionPlan,
  ): Promise<void>;
  calculateCreditCost(
    modelId: string,
    jobType: BackgroundJobType,
    params?: { quality?: ImageQualityLevel; duration?: number; resolution?: VideoResolution; imageResolution?: NativeImageResolution },
  ): number;
};

// ── Factory ──────────────────────────────────────────────────

export function createTierGuard(options: {
  getAdminClient: () => AdminSupabaseClient;
}): TierGuard {
  return {
    checkModelAccess(plan, modelId) {
      if (!isModelAccessible(plan, modelId)) {
        throw new TierGuardError(
          "model_not_accessible",
          `Your ${plan} plan does not have access to model "${modelId}". Please upgrade your plan.`,
          403,
        );
      }
    },

    checkResolution(plan, quality) {
      if (!COMMERCIALIZATION_ENFORCEMENT_ENABLED) return;
      if (!canUseResolution(plan, quality)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `Your ${plan} plan does not allow "${quality}" image quality. Maximum allowed: "${PLAN_CONFIGS[plan].maxResolution}". Please upgrade your plan.`,
          403,
        );
      }
    },


    checkVideoResolution(plan, resolution) {
      if (!COMMERCIALIZATION_ENFORCEMENT_ENABLED) return;
      if (!canUseVideoResolution(plan, resolution)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `Your ${plan} plan does not allow "${resolution}" video resolution. Maximum allowed: "${PLAN_CONFIGS[plan].maxVideoResolution}". Please upgrade your plan.`,
          403,
        );
      }
    },

    async checkConcurrency(workspaceId, plan) {
      if (!COMMERCIALIZATION_ENFORCEMENT_ENABLED) return;
      const admin = options.getAdminClient();
      const maxConcurrent = PLAN_CONFIGS[plan].maxConcurrentJobs;

      const { count, error } = await admin
        .from("background_jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .in("status", ["queued", "running"]);

      if (error) {
        // Log but don't block — fail open on query errors
        console.error(
          "[tier-guard] Failed to check concurrency:",
          error.message,
        );
        return;
      }

      const activeCount = count ?? 0;
      if (activeCount >= maxConcurrent) {
        throw new TierGuardError(
          "concurrency_limit",
          `Concurrent job limit reached (${activeCount}/${maxConcurrent}). Wait for a job to finish or upgrade your plan.`,
          429,
        );
      }
    },

    calculateCreditCost(modelId, jobType, params) {
      if (!COMMERCIALIZATION_ENFORCEMENT_ENABLED) return 0;
      if (jobType === "image_generation") {
        const quality: ImageQualityLevel = imageResolutionBillingQuality(params?.imageResolution, params?.quality ?? "standard");
        return getImageCreditCost(modelId, quality);
      }
      // video_generation
      return getVideoCreditCost(modelId, params?.duration, params?.resolution);
    },
  };
}
