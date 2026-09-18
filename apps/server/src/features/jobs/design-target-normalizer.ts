import {
  type BackgroundJob,
  type BackgroundJobWorker,
  type JobTarget,
  backgroundJobWorkerSchema,
  canvasJobTargetSchema,
  designJobTargetSchema,
  normalizeImageGenerationPayload,
  normalizeVideoGenerationPayload,
  imageForegroundPolicySchema,
  imageGenerationInternalContextSchema,
} from "@loomic/shared";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const imageKeys = [
  "prompt",
  "operation",
  "layer_backend",
  "layer_names",
  "repair_background",
  "output_format",
  "background",
  "model",
  "aspect_ratio",
  "quality",
  "resolution",
  "output_width",
  "output_height",
  "input_images",
  "mask_image",
  "selection_region",
  "outpaint_margins",
] as const;
const videoKeys = [
  "prompt",
  "model",
  "duration",
  "resolution",
  "aspect_ratio",
  "input_images",
  "input_video",
  "enable_audio",
] as const;

function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

function legacyCanvasTarget(
  job: Pick<BackgroundJob, "canvas_id">,
  payload: Record<string, unknown>,
): JobTarget | null {
  if (!job.canvas_id) return null;
  return canvasJobTargetSchema.parse({
    kind: "canvas",
    canvas_id: job.canvas_id,
    ...(typeof payload.placeholder_element_id === "string"
      ? { element_id: payload.placeholder_element_id }
      : {}),
    ...(typeof payload.placement_x === "number" &&
    typeof payload.placement_y === "number"
      ? {
          placement: {
            x: payload.placement_x,
            y: payload.placement_y,
            ...(typeof payload.placement_width === "number"
              ? { width: payload.placement_width }
              : {}),
            ...(typeof payload.placement_height === "number"
              ? { height: payload.placement_height }
              : {}),
          },
        }
      : {}),
  });
}

/**
 * Convert a persisted legacy Canvas job to the one canonical Worker envelope.
 * Modern design targets cannot be reconstructed and are therefore required to
 * be present in payload.target exactly as they were frozen at enqueue time.
 */
export function normalizePersistedGenerationJob(
  rawJob: BackgroundJob,
): BackgroundJobWorker {
  const payload = record(rawJob.payload);
  if (rawJob.job_type === "design_export") {
    return backgroundJobWorkerSchema.parse(rawJob);
  }
  if (
    rawJob.job_type !== "image_generation" &&
    rawJob.job_type !== "video_generation"
  ) {
    throw new Error(`unsupported_worker_job_type:${rawJob.job_type}`);
  }

  const storedTarget = payload.target;
  const target =
    storedTarget !== undefined
      ? storedTarget
      : rawJob.target_kind === "design"
        ? null
        : legacyCanvasTarget(rawJob, payload);
  if (rawJob.target_kind === "design" && storedTarget === undefined) {
    throw new Error("design_target_payload_missing");
  }

  const normalizedPayload =
    rawJob.job_type === "image_generation"
      ? normalizeImageGenerationPayload({
          ...pick(payload, imageKeys),
          target,
        })
      : normalizeVideoGenerationPayload({
          ...pick(payload, videoKeys),
          target,
        });
  if (rawJob.job_type === "image_generation" && payload.foreground_policy !== undefined) {
    Object.assign(normalizedPayload, { foreground_policy: imageForegroundPolicySchema.parse(payload.foreground_policy) });
  }
  if (rawJob.job_type === "image_generation") Object.assign(normalizedPayload,
    imageGenerationInternalContextSchema.parse(pick(payload, ["origin_run_id", "source_element_id", "source_asset_id"])));
  const canonicalTarget = normalizedPayload.target;
  const targetKind =
    rawJob.target_kind === undefined
      ? (canonicalTarget?.kind ?? null)
      : rawJob.target_kind;

  return backgroundJobWorkerSchema.parse({
    ...rawJob,
    target_kind: targetKind,
    canvas_id:
      targetKind === "canvas" && canonicalTarget?.kind === "canvas"
        ? canonicalTarget.canvas_id
        : rawJob.canvas_id,
    design_id:
      targetKind === "design" && canonicalTarget?.kind === "design"
        ? canonicalTarget.design_id
        : (rawJob.design_id ?? null),
    payload: normalizedPayload,
  });
}

export function targetColumns(target: JobTarget | null): {
  targetKind: "canvas" | "design" | null;
  canvasId: string | null;
  designId: string | null;
} {
  if (!target) return { targetKind: null, canvasId: null, designId: null };
  if (target.kind === "canvas") {
    return {
      targetKind: "canvas",
      canvasId: target.canvas_id,
      designId: null,
    };
  }
  return {
    targetKind: "design",
    canvasId: null,
    designId: target.design_id,
  };
}

export function normalizeGenerationPayloadForCreation(input: {
  jobType: "image_generation" | "video_generation";
  payload: Record<string, unknown>;
  fallbackTarget: JobTarget | null;
}) {
  const target =
    input.payload.target === undefined
      ? input.fallbackTarget
      : input.payload.target;
  const normalized = input.jobType === "image_generation"
    ? normalizeImageGenerationPayload({
        ...pick(input.payload, imageKeys),
        target,
      })
      : normalizeVideoGenerationPayload({
        ...pick(input.payload, videoKeys),
        target,
      });
  if (input.jobType === "image_generation" && input.payload.foreground_policy !== undefined) {
    Object.assign(normalized, { foreground_policy: imageForegroundPolicySchema.parse(input.payload.foreground_policy) });
  }
  if (input.jobType === "image_generation") Object.assign(normalized,
    imageGenerationInternalContextSchema.parse(pick(input.payload, ["origin_run_id", "source_element_id", "source_asset_id"])));
  return normalized;
}

export function parseDesignTarget(value: unknown) {
  return designJobTargetSchema.parse(value);
}
