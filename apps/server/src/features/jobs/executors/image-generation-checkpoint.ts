import { createHash } from "node:crypto";
import { isUuid } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../../supabase/admin.js";

const MAX_CHECKPOINT_BYTES = 48 * 1024 * 1024;
const MAX_RESULT_URL_LENGTH = 42 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

export type ProviderImageReference = {
  url: string;
  mimeType: string;
};

export type ImageGenerationCheckpointVariant =
  | "image-generation-source"
  | "design-foreground-matting"
  | "background-removal-foreground"
  | "semantic-layer-stage";

export type ImageGenerationCheckpointState =
  | {
      version: 1;
      status: "calling";
      workspaceId: string;
      jobId: string;
      requestFingerprint: string;
      variant: ImageGenerationCheckpointVariant;
      claimedAt: string;
      attemptOrdinal?: number;
    }
  | {
      version: 1;
      status: "returned";
      workspaceId: string;
      jobId: string;
      requestFingerprint: string;
      variant: ImageGenerationCheckpointVariant;
      result: ProviderImageReference;
      attemptOrdinal?: number;
    }
  | {
      version: 1;
      status: "rejected";
      workspaceId: string;
      jobId: string;
      requestFingerprint: string;
      variant: ImageGenerationCheckpointVariant;
      errorCode: string;
      errorMessage: string;
      rejectedAt: string;
      attemptOrdinal?: number;
    }
  | {
      version: 1;
      status: "archived";
      workspaceId: string;
      jobId: string;
      requestFingerprint: string;
      variant: ImageGenerationCheckpointVariant;
      assetId: string;
      objectPath: string;
      mimeType: string;
      attemptOrdinal?: number;
    };

export class ImageGenerationCheckpointError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "image_generation_checkpoint_invalid"
      | "image_generation_checkpoint_unavailable"
      | "image_generation_result_unknown"
      | "image_generation_provider_rejected",
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationCheckpointError";
  }
}

export type ImageGenerationCheckpoint = {
  claim: () => Promise<
    | { claimed: true }
    | { claimed: false; state: ImageGenerationCheckpointState }
  >;
  saveReturned: (result: ProviderImageReference) => Promise<void>;
  saveRejected: (errorCode: string, errorMessage: string) => Promise<void>;
  saveArchived: (mimeType: string) => Promise<void>;
};

/**
 * Private, job-scoped provider checkpoint. The initial `calling` object is
 * created exclusively so two workers can never both decide that generation
 * has not started.
 */
export function createImageGenerationCheckpoint(
  admin: AdminSupabaseClient,
  input: {
    workspaceId: string;
    jobId: string;
    requestFingerprint: string;
    variant: ImageGenerationCheckpointVariant;
    attemptOrdinal?: number;
  },
): ImageGenerationCheckpoint {
  assertCheckpointIdentity(input);
  const binding = generationSourceAssetBinding(
    input.workspaceId,
    input.jobId,
    input.variant,
    input.attemptOrdinal,
  );
  const checkpointSuffix =
    input.variant === "image-generation-source"
      ? input.attemptOrdinal && input.attemptOrdinal > 0
        ? `image-generation-attempt-${input.attemptOrdinal}-checkpoint`
        : "image-generation-checkpoint"
      : input.variant === "semantic-layer-stage" ? `semantic-layer-stage-${input.attemptOrdinal ?? 0}-checkpoint`
      : input.variant === "design-foreground-matting" ? "design-foreground-checkpoint"
      : "background-removal-checkpoint";
  const objectPath = `${input.workspaceId}/generated/${input.jobId}-${checkpointSuffix}.json`;
  const bucket = admin.storage.from("workspace-assets");

  const write = async (
    state: ImageGenerationCheckpointState,
    upsert: boolean,
  ) => {
    const buffer = Buffer.from(JSON.stringify(state), "utf8");
    if (buffer.length > MAX_CHECKPOINT_BYTES) {
      throw new ImageGenerationCheckpointError(
        "image_generation_checkpoint_invalid",
        "生图返回存档超过大小限制，未继续处理。",
      );
    }
    const { error } = await bucket.upload(objectPath, buffer, {
      contentType: "application/json",
      upsert,
    });
    return error;
  };

  const loadExisting = async () => {
    const { data, error } = await bucket.download(objectPath);
    if (error || !data) {
      throw new ImageGenerationCheckpointError(
        "image_generation_checkpoint_unavailable",
        "读取生图调用存档失败，未重复调用生图接口。",
      );
    }
    if (data.size <= 0 || data.size > MAX_CHECKPOINT_BYTES) {
      throw new ImageGenerationCheckpointError(
        "image_generation_checkpoint_invalid",
        "生图调用存档为空或超过大小限制，未重复调用生图接口。",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await data.text());
    } catch {
      throw new ImageGenerationCheckpointError(
        "image_generation_checkpoint_invalid",
        "生图调用存档损坏，未重复调用生图接口。",
      );
    }
    return parseCheckpointState(raw, input, binding);
  };

  return {
    async claim() {
      const calling: ImageGenerationCheckpointState = {
        version: 1,
        status: "calling",
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        requestFingerprint: input.requestFingerprint,
        variant: input.variant,
        claimedAt: new Date().toISOString(),
        ...(input.attemptOrdinal ? { attemptOrdinal: input.attemptOrdinal } : {}),
      };
      const error = await write(calling, false);
      if (!error) return { claimed: true };
      if (!isAlreadyExistsError(error)) {
        // The write may have reached storage even if its response was lost. Do
        // not call the provider unless exclusive creation is confirmed.
        throw new ImageGenerationCheckpointError(
          "image_generation_checkpoint_unavailable",
          "无法确认生图调用存档是否已创建，未调用生图接口。",
        );
      }
      return { claimed: false, state: await loadExisting() };
    },

    async saveReturned(result) {
      assertProviderReference(result);
      const error = await write(
        {
          version: 1,
          status: "returned",
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          requestFingerprint: input.requestFingerprint,
          variant: input.variant,
          result,
          ...(input.attemptOrdinal ? { attemptOrdinal: input.attemptOrdinal } : {}),
        },
        true,
      );
      if (error) {
        throw new ImageGenerationCheckpointError(
          "image_generation_checkpoint_unavailable",
          "生图接口已返回，但返回结果存档失败；未自动重新生图。",
        );
      }
    },

    async saveRejected(errorCode, errorMessage) {
      if (
        input.variant !== "image-generation-source" ||
        typeof errorCode !== "string" ||
        !errorCode.trim() ||
        typeof errorMessage !== "string"
      ) {
        throw new ImageGenerationCheckpointError(
          "invalid_input",
          "生图供应商拒绝存档无效。",
        );
      }
      const error = await write(
        {
          version: 1,
          status: "rejected",
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          requestFingerprint: input.requestFingerprint,
          variant: input.variant,
          errorCode: errorCode.slice(0, 100),
          errorMessage: errorMessage.slice(0, 2_000),
          rejectedAt: new Date().toISOString(),
          ...(input.attemptOrdinal ? { attemptOrdinal: input.attemptOrdinal } : {}),
        },
        true,
      );
      if (error) {
        throw new ImageGenerationCheckpointError(
          "image_generation_checkpoint_unavailable",
          "供应商已明确拒绝生图，但拒绝状态存档失败；未尝试备用供应商。",
        );
      }
    },

    async saveArchived(mimeType) {
      assertImageMimeType(mimeType);
      const error = await write(
        {
          version: 1,
          status: "archived",
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          requestFingerprint: input.requestFingerprint,
          variant: input.variant,
          assetId: binding.assetId,
          objectPath: binding.objectPath,
          mimeType,
          ...(input.attemptOrdinal ? { attemptOrdinal: input.attemptOrdinal } : {}),
        },
        true,
      );
      if (error) {
        throw new ImageGenerationCheckpointError(
          "image_generation_checkpoint_unavailable",
          "生图原图已保存，但归档状态写入失败；可安全重试后处理。",
        );
      }
    },
  };
}

export function generationSourceAssetBinding(
  workspaceId: string,
  jobId: string,
  variant: ImageGenerationCheckpointVariant,
  attemptOrdinal?: number,
) {
  if (!isUuid(workspaceId) || !isUuid(jobId)) {
    throw new ImageGenerationCheckpointError(
      "invalid_input",
      "生图存档任务范围无效。",
    );
  }
  const suffix =
    variant === "semantic-layer-stage"
      ? `semantic-layer-stage-${attemptOrdinal ?? 0}-source`
      : variant === "image-generation-source"
      ? "source-before-matting"
      : variant === "design-foreground-matting" ? "design-foreground"
      : "0-foreground";
  return {
    suffix,
    assetId: deterministicAssetId(jobId, suffix),
    objectPath: `${workspaceId}/generated/${jobId}-${suffix}.png`,
  };
}

export function deterministicAssetId(jobId: string, suffix: string) {
  // Kept in one place so checkpoint validation and asset persistence cannot
  // drift to different job-derived identifiers.
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${jobId}:${suffix}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertCheckpointIdentity(input: {
  workspaceId: string;
  jobId: string;
  requestFingerprint: string;
  variant: ImageGenerationCheckpointVariant;
  attemptOrdinal?: number;
}) {
  if (
    !isUuid(input.workspaceId) ||
    !isUuid(input.jobId) ||
    !/^[0-9a-f]{64}$/i.test(input.requestFingerprint) ||
    (input.attemptOrdinal !== undefined &&
      (!Number.isSafeInteger(input.attemptOrdinal) ||
        input.attemptOrdinal < 0 ||
        input.attemptOrdinal > 7 ||
        !["image-generation-source", "semantic-layer-stage"].includes(input.variant))) ||
    !["image-generation-source", "background-removal-foreground", "design-foreground-matting", "semantic-layer-stage"].includes(
      input.variant,
    )
  ) {
    throw new ImageGenerationCheckpointError(
      "invalid_input",
      "生图调用存档标识无效。",
    );
  }
}

function parseCheckpointState(
  raw: unknown,
  expected: {
    workspaceId: string;
    jobId: string;
    requestFingerprint: string;
    variant: ImageGenerationCheckpointVariant;
    attemptOrdinal?: number;
  },
  binding: { assetId: string; objectPath: string },
): ImageGenerationCheckpointState {
  if (!raw || typeof raw !== "object") return invalidCheckpoint();
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.workspaceId !== expected.workspaceId ||
    value.jobId !== expected.jobId ||
    value.requestFingerprint !== expected.requestFingerprint ||
    value.variant !== expected.variant ||
    (value.attemptOrdinal ?? 0) !== (expected.attemptOrdinal ?? 0)
  ) {
    return invalidCheckpoint();
  }
  if (value.status === "calling" && typeof value.claimedAt === "string") {
    if (!Number.isFinite(Date.parse(value.claimedAt))) return invalidCheckpoint();
    return value as ImageGenerationCheckpointState;
  }
  if (value.status === "returned") {
    assertProviderReference(value.result);
    return value as ImageGenerationCheckpointState;
  }
  if (
    value.status === "rejected" &&
    typeof value.errorCode === "string" &&
    value.errorCode.length > 0 &&
    value.errorCode.length <= 100 &&
    typeof value.errorMessage === "string" &&
    value.errorMessage.length <= 2_000 &&
    typeof value.rejectedAt === "string" &&
    Number.isFinite(Date.parse(value.rejectedAt))
  ) {
    return value as ImageGenerationCheckpointState;
  }
  if (
    value.status === "archived" &&
    value.assetId === binding.assetId &&
    value.objectPath === binding.objectPath &&
    typeof value.mimeType === "string"
  ) {
    assertImageMimeType(value.mimeType);
    return value as ImageGenerationCheckpointState;
  }
  return invalidCheckpoint();
}

function assertProviderReference(value: unknown): asserts value is ProviderImageReference {
  if (!value || typeof value !== "object") return invalidCheckpoint();
  const result = value as Record<string, unknown>;
  if (
    typeof result.url !== "string" ||
    result.url.length === 0 ||
    result.url.length > MAX_RESULT_URL_LENGTH ||
    typeof result.mimeType !== "string"
  ) {
    return invalidCheckpoint();
  }
  assertImageMimeType(result.mimeType);
  if (result.url.startsWith("data:")) {
    if (!result.url.startsWith(`data:${result.mimeType};base64,`)) {
      return invalidCheckpoint();
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    return invalidCheckpoint();
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return invalidCheckpoint();
  }
}

function assertImageMimeType(value: string) {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(value)) return invalidCheckpoint();
}

function invalidCheckpoint(): never {
  throw new ImageGenerationCheckpointError(
    "image_generation_checkpoint_invalid",
    "生图调用存档内容无效，未重复调用生图接口。",
  );
}

function isAlreadyExistsError(error: { message: string; statusCode?: string | number }) {
  const status = String(error.statusCode ?? "");
  return (
    status === "409" ||
    (status === "400" && /already exists|duplicate|resource exists/i.test(error.message))
  );
}
