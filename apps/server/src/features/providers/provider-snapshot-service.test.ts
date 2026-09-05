import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  createProviderSnapshotService,
  ProviderSnapshotServiceError,
} from "./provider-snapshot-service.js";

const CATALOG_KEY = "10000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "20000000-0000-4000-8000-000000000002";

function adminWithRpc(
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>,
): AdminSupabaseClient {
  return { rpc: vi.fn(rpc) } as unknown as AdminSupabaseClient;
}

describe("provider snapshot service", () => {
  it("creates a job snapshot from only workspace, target, and opaque catalog ref", async () => {
    const admin = adminWithRpc(async () => ({
      data: SNAPSHOT_ID,
      error: null,
    }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    await expect(
      service.createJobSnapshot({
        workspaceId: "workspace-1",
        jobId: "job-1",
        modelRef: `workspace:${CATALOG_KEY}`,
        billing: { creditsCost: 5, pricingVersion: "2026-09", unit: "image" },
      }),
    ).resolves.toBe(SNAPSHOT_ID);

    expect(admin.rpc).toHaveBeenCalledWith("loomic_provider_snapshot_create", {
      p_workspace_id: "workspace-1",
      p_catalog_key: CATALOG_KEY,
      p_background_job_id: "job-1",
      p_billing_credits_cost: 5,
      p_billing_pricing_version: "2026-09",
      p_billing_unit: "image",
    });
    const args = vi.mocked(admin.rpc).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("p_agent_run_id");
    expect(args).not.toHaveProperty("p_provider_config_id");
    expect(args).not.toHaveProperty("p_revision");
  });

  it("binds an agent run without allowing a job id", async () => {
    const admin = adminWithRpc(async () => ({
      data: SNAPSHOT_ID,
      error: null,
    }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    await service.createRunSnapshot({
      workspaceId: "workspace-1",
      runId: "run-1",
      modelRef: `workspace:${CATALOG_KEY}`,
    });

    expect(admin.rpc).toHaveBeenCalledWith(
      "loomic_provider_snapshot_create",
      expect.objectContaining({
        p_agent_run_id: "run-1",
      }),
    );
    const args = vi.mocked(admin.rpc).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("p_background_job_id");
  });

  it("rejects malformed refs and billing before service-role access", async () => {
    const admin = adminWithRpc(async () => ({
      data: SNAPSHOT_ID,
      error: null,
    }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    await expect(
      service.createJobSnapshot({
        workspaceId: "workspace-1",
        jobId: "job-1",
        modelRef: "openai:gpt-image",
      }),
    ).rejects.toMatchObject({ code: "provider_snapshot_invalid_request" });
    await expect(
      service.createJobSnapshot({
        workspaceId: "workspace-1",
        jobId: "job-1",
        modelRef: `workspace:${CATALOG_KEY}`,
        billing: { creditsCost: -1 },
      }),
    ).rejects.toMatchObject({ code: "provider_snapshot_invalid_request" });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("returns a server-only resolved DTO and never exposes a Vault id", async () => {
    const admin = adminWithRpc(async (name) => ({
      data:
        name === "loomic_provider_job_snapshot_resolve"
          ? [
              {
                snapshot_id: SNAPSHOT_ID,
                provider_config_id: "config-1",
                provider_revision: 3,
                catalog_key: CATALOG_KEY,
                adapter: "openai_compatible",
                base_url: "https://api.openai.com/v1",
                upstream_model_id: "gpt-image-2",
                modality: "image",
                capabilities: ["image_generation"],
                billing_credits_cost: 5,
                billing_pricing_version: "2026-09",
                billing_unit: "image",
                api_key: "sk-ephemeral-copy",
                api_key_secret_id: "must-not-escape",
              },
            ]
          : null,
      error: null,
    }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    const resolved = await service.resolveJobSnapshot({
      workspaceId: "workspace-1",
      jobId: "job-1",
    });

    expect(resolved).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      providerRevision: 3,
      upstreamModelId: "gpt-image-2",
      apiKey: "sk-ephemeral-copy",
    });
    expect(resolved).not.toHaveProperty("apiKeySecretId");
    expect(resolved).not.toHaveProperty("api_key_secret_id");
  });

  it("fails closed when a bound snapshot is missing or released", async () => {
    const admin = adminWithRpc(async () => ({ data: [], error: null }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    await expect(
      service.resolveRunSnapshot({
        workspaceId: "workspace-1",
        runId: "run-1",
      }),
    ).rejects.toMatchObject({
      code: "provider_snapshot_not_found",
      statusCode: 404,
    });
  });

  it("maps cross-workspace or revision lookup failures to a stable create error", async () => {
    const admin = adminWithRpc(async () => ({
      data: null,
      error: {
        message: "provider_snapshot_target_not_found with database details",
      },
    }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    const promise = service.createJobSnapshot({
      workspaceId: "foreign-workspace",
      jobId: "job-1",
      modelRef: `workspace:${CATALOG_KEY}`,
    });
    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        code: "provider_snapshot_create_failed",
        message: "Provider execution snapshot could not be created.",
      }),
    );
  });

  it("releases only through the terminal-state RPC", async () => {
    const admin = adminWithRpc(async () => ({ data: true, error: null }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    await service.releaseSnapshot({
      workspaceId: "workspace-1",
      snapshotId: SNAPSHOT_ID,
    });
    expect(admin.rpc).toHaveBeenCalledWith("loomic_provider_snapshot_release", {
      p_workspace_id: "workspace-1",
      p_snapshot_id: SNAPSHOT_ID,
    });
  });

  it("does not leak database details from release failures", async () => {
    const admin = adminWithRpc(async () => ({
      data: null,
      error: { message: "provider_snapshot_target_not_terminal" },
    }));
    const service = createProviderSnapshotService({
      getAdminClient: () => admin,
    });

    await expect(
      service.releaseSnapshot({
        workspaceId: "workspace-1",
        snapshotId: SNAPSHOT_ID,
      }),
    ).rejects.toBeInstanceOf(ProviderSnapshotServiceError);
    await expect(
      service.releaseSnapshot({
        workspaceId: "workspace-1",
        snapshotId: SNAPSHOT_ID,
      }),
    ).rejects.toMatchObject({ code: "provider_snapshot_not_terminal" });
  });
});
