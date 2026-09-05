import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";

const candidateSchema = z
  .object({
    id: z.string().uuid(),
    gc_claim_token: z.string().uuid().nullable(),
    deletion_pending_at: z.string().nullable(),
    bucket: z.string().min(1),
    object_path: z.string().min(1),
  })
  .strict();
const claimSchema = z
  .object({
    claim_token: z.string().uuid(),
    bucket: z.string().min(1),
    object_path: z.string().min(1),
  })
  .strict();

export async function collectExpiredDesignExportAssets(
  admin: AdminSupabaseClient,
  now = new Date(),
  limit = 25,
) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  // Scan beyond the desired successful batch size. Otherwise a fixed prefix
  // of storage failures can permanently hide every later eligible asset.
  const scanLimit = Math.min(1_000, safeLimit * 4);
  const candidates = await admin
    .from("asset_objects")
    .select("id, gc_claim_token, deletion_pending_at, bucket, object_path")
    .like("object_path", "%/design-exports/%")
    .not("gc_eligible_at", "is", null)
    .lte("gc_eligible_at", now.toISOString())
    .order("gc_eligible_at", { ascending: true })
    .limit(scanLimit);
  if (candidates.error) {
    throw new Error(`design_export_gc_scan_failed:${candidates.error.message}`);
  }
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  for (const rawCandidate of candidates.data ?? []) {
    const candidate = candidateSchema.parse(rawCandidate);
    try {
      if (candidate.deletion_pending_at && candidate.gc_claim_token) {
        const revalidated = await callRpc(
          admin,
          "loomic_asset_gc_prepare_delete",
          {
            p_asset_id: candidate.id,
            p_claim_token: candidate.gc_claim_token,
          },
        );
        if (revalidated !== true) {
          skipped += 1;
          continue;
        }
        const removed = await admin.storage
          .from(candidate.bucket)
          .remove([candidate.object_path]);
        if (removed.error) {
          failed += 1;
          await deferGcRetry(admin, candidate.id, now);
          continue;
        }
        const finalized = await callRpc(admin, "loomic_asset_gc_finalize", {
          p_asset_id: candidate.id,
          p_claim_token: candidate.gc_claim_token,
        });
        if (finalized === true) deleted += 1;
        else failed += 1;
        continue;
      }
      const claimResult = await callRpc(admin, "loomic_asset_gc_claim", {
        p_asset_id: candidate.id,
        p_now: now.toISOString(),
      });
      const rawClaim = Array.isArray(claimResult)
        ? claimResult[0]
        : claimResult;
      if (!rawClaim) {
        skipped += 1;
        continue;
      }
      const claim = claimSchema.parse(rawClaim);
      const prepared = await callRpc(admin, "loomic_asset_gc_prepare_delete", {
        p_asset_id: candidate.id,
        p_claim_token: claim.claim_token,
      });
      if (prepared !== true) {
        skipped += 1;
        continue;
      }
      const removed = await admin.storage
        .from(claim.bucket)
        .remove([claim.object_path]);
      if (removed.error) {
        failed += 1;
        await deferGcRetry(admin, candidate.id, now);
        continue;
      }
      const finalized = await callRpc(admin, "loomic_asset_gc_finalize", {
        p_asset_id: candidate.id,
        p_claim_token: claim.claim_token,
      });
      if (finalized === true) deleted += 1;
      else failed += 1;
    } catch {
      failed += 1;
      await deferGcRetry(admin, candidate.id, now);
    }
  }
  return {
    checked: candidates.data?.length ?? 0,
    deleted,
    skipped,
    failed,
  };
}

async function deferGcRetry(
  admin: AdminSupabaseClient,
  assetId: string,
  now: Date,
) {
  try {
    await admin
      .from("asset_objects")
      .update({
        gc_eligible_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      })
      .eq("id", assetId);
  } catch {
    // The original asset and claim remain durable. A later scan can retry even
    // if persisting the fairness backoff itself fails.
  }
}

async function callRpc(
  admin: AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await (
    admin.rpc as unknown as (
      rpcName: string,
      rpcArgs: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string } | null }>
  )(name, args);
  if (error) throw new Error(error.message ?? `${name}_failed`);
  return data;
}
