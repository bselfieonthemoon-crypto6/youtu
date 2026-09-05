import type { Json } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  ProviderAdapter,
  ProviderModelCapability,
  ProviderModelModality,
} from "./types.js";

const WORKSPACE_MODEL_PREFIX = "workspace:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITIES = new Set<ProviderModelCapability>([
  "text",
  "vision_input",
  "image_generation",
  "video_generation",
]);
const BILLING_UNITS = new Set<ProviderBillingUnit>([
  "request",
  "image",
  "second",
  "token",
  "unknown",
]);

export type ProviderBillingUnit =
  | "request"
  | "image"
  | "second"
  | "token"
  | "unknown";

export type ProviderExecutionBillingSnapshot = {
  creditsCost?: number;
  pricingVersion?: string;
  unit?: ProviderBillingUnit;
};

export type CreateJobProviderSnapshotInput = {
  workspaceId: string;
  jobId: string;
  modelRef: string;
  billing?: ProviderExecutionBillingSnapshot;
};

export type CreateRunProviderSnapshotInput = {
  workspaceId: string;
  runId: string;
  modelRef: string;
  billing?: ProviderExecutionBillingSnapshot;
};

/** Server-only DTO. Never serialize this object into an HTTP/WS response. */
export type ResolvedProviderExecutionSecret = {
  snapshotId: string;
  providerConfigId: string;
  providerRevision: number;
  catalogKey: string;
  adapter: ProviderAdapter;
  baseUrl: string;
  upstreamModelId: string;
  modality: ProviderModelModality;
  capabilities: ProviderModelCapability[];
  billing: {
    creditsCost: number | null;
    pricingVersion: string | null;
    unit: ProviderBillingUnit | null;
  };
  apiKey: string;
};

export type ProviderSnapshotService = {
  createJobSnapshot(input: CreateJobProviderSnapshotInput): Promise<string>;
  createRunSnapshot(input: CreateRunProviderSnapshotInput): Promise<string>;
  resolveJobSnapshot(input: {
    workspaceId: string;
    jobId: string;
  }): Promise<ResolvedProviderExecutionSecret>;
  resolveRunSnapshot(input: {
    workspaceId: string;
    runId: string;
  }): Promise<ResolvedProviderExecutionSecret>;
  releaseSnapshot(input: { workspaceId: string; snapshotId: string }): Promise<void>;
};

export class ProviderSnapshotServiceError extends Error {
  readonly code:
    | "provider_snapshot_invalid_request"
    | "provider_snapshot_not_found"
    | "provider_snapshot_not_terminal"
    | "provider_snapshot_create_failed"
    | "provider_snapshot_unavailable";
  readonly statusCode: number;

  constructor(
    code: ProviderSnapshotServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "ProviderSnapshotServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createProviderSnapshotService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): ProviderSnapshotService {
  async function createSnapshot(input: {
    workspaceId: string;
    modelRef: string;
    jobId?: string;
    runId?: string;
    billing?: ProviderExecutionBillingSnapshot;
  }): Promise<string> {
    const catalogKey = parseWorkspaceModelRef(input.modelRef);
    const billing = normalizeBilling(input.billing);
    const { data, error } = await options.getAdminClient().rpc(
      "loomic_provider_snapshot_create",
      {
        p_workspace_id: input.workspaceId,
        p_catalog_key: catalogKey,
        ...(input.runId !== undefined ? { p_agent_run_id: input.runId } : {}),
        ...(input.jobId !== undefined
          ? { p_background_job_id: input.jobId }
          : {}),
        ...(billing.creditsCost !== null
          ? { p_billing_credits_cost: billing.creditsCost }
          : {}),
        ...(billing.pricingVersion !== null
          ? { p_billing_pricing_version: billing.pricingVersion }
          : {}),
        ...(billing.unit !== null ? { p_billing_unit: billing.unit } : {}),
      },
    );
    if (error || typeof data !== "string" || !UUID_PATTERN.test(data)) {
      throw new ProviderSnapshotServiceError(
        "provider_snapshot_create_failed",
        "Provider execution snapshot could not be created.",
        409,
      );
    }
    return data;
  }

  async function resolve(
    rpcName:
      | "loomic_provider_job_snapshot_resolve"
      | "loomic_provider_run_snapshot_resolve",
    args:
      | { p_workspace_id: string; p_background_job_id: string }
      | { p_workspace_id: string; p_agent_run_id: string },
  ): Promise<ResolvedProviderExecutionSecret> {
    const { data, error } = await options.getAdminClient().rpc(rpcName, args);
    if (error) {
      throw new ProviderSnapshotServiceError(
        "provider_snapshot_unavailable",
        "Provider execution snapshot is unavailable.",
        503,
      );
    }
    const row = Array.isArray(data) ? data[0] : undefined;
    if (!row) {
      throw new ProviderSnapshotServiceError(
        "provider_snapshot_not_found",
        "Provider execution snapshot was not found or has been released.",
        404,
      );
    }
    return mapResolvedRow(row as Record<string, unknown>);
  }

  return {
    createJobSnapshot(input) {
      return createSnapshot({
        workspaceId: input.workspaceId,
        modelRef: input.modelRef,
        jobId: input.jobId,
        ...(input.billing ? { billing: input.billing } : {}),
      });
    },
    createRunSnapshot(input) {
      return createSnapshot({
        workspaceId: input.workspaceId,
        modelRef: input.modelRef,
        runId: input.runId,
        ...(input.billing ? { billing: input.billing } : {}),
      });
    },
    resolveJobSnapshot(input) {
      return resolve("loomic_provider_job_snapshot_resolve", {
        p_workspace_id: input.workspaceId,
        p_background_job_id: input.jobId,
      });
    },
    resolveRunSnapshot(input) {
      return resolve("loomic_provider_run_snapshot_resolve", {
        p_workspace_id: input.workspaceId,
        p_agent_run_id: input.runId,
      });
    },
    async releaseSnapshot(input) {
      const { data, error } = await options.getAdminClient().rpc(
        "loomic_provider_snapshot_release",
        {
          p_workspace_id: input.workspaceId,
          p_snapshot_id: input.snapshotId,
        },
      );
      if (error) {
        const notTerminal = error.message === "provider_snapshot_target_not_terminal";
        throw new ProviderSnapshotServiceError(
          notTerminal
            ? "provider_snapshot_not_terminal"
            : "provider_snapshot_unavailable",
          notTerminal
            ? "Provider execution snapshot cannot be released before the execution is terminal."
            : "Provider execution snapshot could not be released.",
          notTerminal ? 409 : 503,
        );
      }
      if (data !== true) {
        throw new ProviderSnapshotServiceError(
          "provider_snapshot_not_found",
          "Provider execution snapshot was not found or was already released.",
          404,
        );
      }
    },
  };
}

export function parseWorkspaceModelRef(modelRef: string): string {
  if (!modelRef.startsWith(WORKSPACE_MODEL_PREFIX)) {
    throw invalidRequest("A workspace provider model reference is required.");
  }
  const catalogKey = modelRef.slice(WORKSPACE_MODEL_PREFIX.length);
  if (!UUID_PATTERN.test(catalogKey)) {
    throw invalidRequest("Workspace provider model reference is invalid.");
  }
  return catalogKey;
}

function normalizeBilling(billing: ProviderExecutionBillingSnapshot | undefined): {
  creditsCost: number | null;
  pricingVersion: string | null;
  unit: ProviderBillingUnit | null;
} {
  if (
    billing?.creditsCost !== undefined &&
    (!Number.isSafeInteger(billing.creditsCost) || billing.creditsCost < 0)
  ) {
    throw invalidRequest("Billing credits cost is invalid.");
  }
  const pricingVersion = billing?.pricingVersion?.trim() ?? null;
  if (pricingVersion !== null && (pricingVersion.length < 1 || pricingVersion.length > 100)) {
    throw invalidRequest("Billing pricing version is invalid.");
  }
  if (billing?.unit !== undefined && !BILLING_UNITS.has(billing.unit)) {
    throw invalidRequest("Billing unit is invalid.");
  }
  return {
    creditsCost: billing?.creditsCost ?? null,
    pricingVersion,
    unit: billing?.unit ?? null,
  };
}

function mapResolvedRow(row: Record<string, unknown>): ResolvedProviderExecutionSecret {
  const rawCapabilities = Array.isArray(row.capabilities) ? row.capabilities : [];
  const capabilities = rawCapabilities.filter(
    (value): value is ProviderModelCapability =>
      typeof value === "string" && CAPABILITIES.has(value as ProviderModelCapability),
  );
  const unit = typeof row.billing_unit === "string" && BILLING_UNITS.has(row.billing_unit as ProviderBillingUnit)
    ? (row.billing_unit as ProviderBillingUnit)
    : null;
  if (
    typeof row.snapshot_id !== "string" ||
    typeof row.provider_config_id !== "string" ||
    typeof row.provider_revision !== "number" ||
    typeof row.catalog_key !== "string" ||
    row.adapter !== "openai_compatible" ||
    typeof row.base_url !== "string" ||
    typeof row.upstream_model_id !== "string" ||
    !["text", "image", "video"].includes(String(row.modality)) ||
    typeof row.api_key !== "string" ||
    row.api_key.length === 0
  ) {
    throw new ProviderSnapshotServiceError(
      "provider_snapshot_unavailable",
      "Provider execution snapshot is unavailable.",
      503,
    );
  }
  return {
    snapshotId: row.snapshot_id,
    providerConfigId: row.provider_config_id,
    providerRevision: row.provider_revision,
    catalogKey: row.catalog_key,
    adapter: row.adapter,
    baseUrl: row.base_url,
    upstreamModelId: row.upstream_model_id,
    modality: row.modality as ProviderModelModality,
    capabilities,
    billing: {
      creditsCost:
        typeof row.billing_credits_cost === "number" ? row.billing_credits_cost : null,
      pricingVersion:
        typeof row.billing_pricing_version === "string"
          ? row.billing_pricing_version
          : null,
      unit,
    },
    apiKey: row.api_key,
  };
}

function invalidRequest(message: string): ProviderSnapshotServiceError {
  return new ProviderSnapshotServiceError(
    "provider_snapshot_invalid_request",
    message,
    400,
  );
}
