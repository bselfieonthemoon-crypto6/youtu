import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createProviderSnapshotService } from "./provider-snapshot-service.js";

const WORKSPACE = "workspace-1";
const JOB = "job-1";
const CATALOG = "10000000-0000-4000-8000-000000000001";

function row(attemptOrdinal: number, overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: `20000000-0000-4000-8000-00000000000${attemptOrdinal + 1}`,
    provider_config_id: "config-1",
    provider_revision: 3,
    catalog_key: CATALOG,
    adapter: "openai_compatible",
    base_url: "https://example.com/v1",
    upstream_model_id: "gpt-image-2",
    modality: "image",
    capabilities: ["image_generation"],
    billing_credits_cost: 5,
    billing_pricing_version: "2026-09",
    billing_unit: "image",
    api_key: "test-only",
    attempt_ordinal: attemptOrdinal,
    ...overrides,
  };
}

function serviceReturning(data: unknown) {
  const rpc = vi.fn(async () => ({ data, error: null }));
  const service = createProviderSnapshotService({
    getAdminClient: () => ({ rpc } as unknown as AdminSupabaseClient),
  });
  return { service, rpc };
}

describe("image provider execution plan validation", () => {
  it.each([
    ["missing ordinal zero", [row(1)]],
    ["ordinal gap", [row(0), row(2)]],
    ["mixed upstream models", [row(0), row(1, { upstream_model_id: "other-image-model" })]],
    ["different credit price", [row(0), row(1, { billing_credits_cost: 6 })]],
    ["different pricing version", [row(0), row(1, { billing_pricing_version: "2026-10" })]],
  ])("rejects %s", async (_label, data) => {
    const { service } = serviceReturning(data);
    await expect(
      service.resolveImageGenerationPlan!({ workspaceId: WORKSPACE, jobId: JOB }),
    ).rejects.toMatchObject({
      code: "provider_snapshot_unavailable",
      message: "Image provider execution plan is invalid.",
    });
  });

  it("rejects an empty plan before attempting provider execution", async () => {
    const { service } = serviceReturning([]);
    await expect(
      service.resolveImageGenerationPlan!({ workspaceId: WORKSPACE, jobId: JOB }),
    ).rejects.toMatchObject({
      code: "provider_snapshot_not_found",
      statusCode: 404,
    });
  });

  it("accepts a continuous same-upstream plan", async () => {
    const { service, rpc } = serviceReturning([row(0), row(1), row(2)]);
    const plan = await service.resolveImageGenerationPlan!({
      workspaceId: WORKSPACE,
      jobId: JOB,
    });
    expect(plan.map((entry) => entry.attemptOrdinal)).toEqual([0, 1, 2]);
    expect(plan.map((entry) => entry.upstreamModelId)).toEqual([
      "gpt-image-2",
      "gpt-image-2",
      "gpt-image-2",
    ]);
    expect(rpc).toHaveBeenCalledWith("loomic_image_provider_plan_resolve", {
      p_workspace_id: WORKSPACE,
      p_background_job_id: JOB,
    });
  });
});
