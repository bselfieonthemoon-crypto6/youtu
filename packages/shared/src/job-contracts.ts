import { z } from "zod";

import {
  type CanvasJobTarget,
  canvasJobTargetSchema,
  designExportPayloadSchema,
  designExportResultSchema,
  jobTargetSchema,
} from "./design-contracts.js";

export const backgroundJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
]);
export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusSchema>;

export const backgroundJobTypeSchema = z.enum([
  "image_generation",
  "video_generation",
  "code_execution",
  "design_preview",
  "design_export",
  "design_resource_import",
]);
export type BackgroundJobType = z.infer<typeof backgroundJobTypeSchema>;

export const imageOperationSchema = z.enum([
  "generate",
  "remove_background",
  "region_matting",
  "split_layers",
  "erase_transparent",
  "smart_erase",
]);

export const normalizedSelectionRegionSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.x + value.width > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selection region exceeds the right edge",
        path: ["width"],
      });
    }
    if (value.y + value.height > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selection region exceeds the bottom edge",
        path: ["height"],
      });
    }
  });

const uniqueStringsSchema = z
  .array(z.string())
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "values must be unique",
          path: [index],
        });
      }
      seen.add(value);
    }
  });
const uniqueInputImagesSchema = z
  .array(z.string())
  .max(10)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "values must be unique",
          path: [index],
        });
      }
      seen.add(value);
    }
  });

const imageGenerationShape = {
  prompt: z.string().min(1),
  operation: imageOperationSchema.optional(),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
  output_width: z.number().int().min(16).max(3_840).optional(),
  output_height: z.number().int().min(16).max(3_840).optional(),
  input_images: uniqueInputImagesSchema.optional(),
  mask_image: z.string().optional(),
  selection_region: normalizedSelectionRegionSchema.optional(),
} as const;

const requestContextShape = {
  project_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
} as const;

const legacyCanvasRoutingShape = {
  canvas_id: z.string().uuid().optional(),
  placement_x: z.number().finite().optional(),
  placement_y: z.number().finite().optional(),
  placement_width: z.number().finite().positive().optional(),
  placement_height: z.number().finite().positive().optional(),
  placeholder_element_id: z.string().trim().min(1).max(200).optional(),
} as const;

type LegacyCanvasRouting = {
  canvas_id?: string | undefined;
  placement_x?: number | undefined;
  placement_y?: number | undefined;
  placement_width?: number | undefined;
  placement_height?: number | undefined;
  placeholder_element_id?: string | undefined;
};

function validateLegacyRouting(
  value: LegacyCanvasRouting & { target?: unknown },
  context: z.RefinementCtx,
) {
  const legacyKeys = [
    "canvas_id",
    "placement_x",
    "placement_y",
    "placement_width",
    "placement_height",
    "placeholder_element_id",
  ] as const;
  const hasLegacy = legacyKeys.some((key) => value[key] !== undefined);
  if (value.target !== undefined && hasLegacy) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modern target and legacy canvas routing are mutually exclusive",
      path: ["target"],
    });
  }
  const hasPlacement = legacyKeys
    .slice(1)
    .some((key) => value[key] !== undefined);
  if (hasPlacement && value.canvas_id === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "legacy placement requires canvas_id",
      path: ["canvas_id"],
    });
  }
  if ((value.placement_x === undefined) !== (value.placement_y === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "legacy placement x and y must be supplied together",
      path: ["placement_y"],
    });
  }
  if (
    (value.placement_width === undefined) !==
    (value.placement_height === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "legacy placement width and height must be supplied together",
      path: ["placement_height"],
    });
  }
}

// Public entry schema. It accepts the old flat canvas routing or the modern
// target, never both. API handlers must normalize it before enqueueing.
export const createImageJobRequestSchema = z
  .object({
    ...requestContextShape,
    ...imageGenerationShape,
    ...legacyCanvasRoutingShape,
    target: jobTargetSchema.nullable().optional(),
  })
  .strict()
  .superRefine(validateLegacyRouting);
export type CreateImageJobRequest = z.infer<typeof createImageJobRequestSchema>;

// Canonical Worker input: routing is always one discriminated target or null
// for a chat-only generation. It contains no legacy placement aliases.
export const normalizedImageGenerationPayloadSchema = z
  .object({
    ...imageGenerationShape,
    target: jobTargetSchema.nullable(),
  })
  .strict();
export const imageGenerationPayloadSchema =
  normalizedImageGenerationPayloadSchema;
export type NormalizedImageGenerationPayload = z.infer<
  typeof normalizedImageGenerationPayloadSchema
>;
export type ImageGenerationPayload = NormalizedImageGenerationPayload;

function legacyCanvasTarget(
  value: LegacyCanvasRouting,
): CanvasJobTarget | null {
  if (!value.canvas_id) return null;
  const hasPosition =
    value.placement_x !== undefined && value.placement_y !== undefined;
  return canvasJobTargetSchema.parse({
    kind: "canvas",
    canvas_id: value.canvas_id,
    ...(value.placeholder_element_id !== undefined
      ? { element_id: value.placeholder_element_id }
      : {}),
    ...(hasPosition
      ? {
          placement: {
            x: value.placement_x,
            y: value.placement_y,
            ...(value.placement_width !== undefined
              ? { width: value.placement_width }
              : {}),
            ...(value.placement_height !== undefined
              ? { height: value.placement_height }
              : {}),
          },
        }
      : {}),
  });
}

export function normalizeImageGenerationPayload(
  input: unknown,
): NormalizedImageGenerationPayload {
  const request = createImageJobRequestSchema.parse(input);
  return normalizedImageGenerationPayloadSchema.parse({
    prompt: request.prompt,
    ...(request.operation !== undefined
      ? { operation: request.operation }
      : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.aspect_ratio !== undefined
      ? { aspect_ratio: request.aspect_ratio }
      : {}),
    ...(request.quality !== undefined ? { quality: request.quality } : {}),
    ...(request.output_width !== undefined
      ? { output_width: request.output_width }
      : {}),
    ...(request.output_height !== undefined
      ? { output_height: request.output_height }
      : {}),
    ...(request.input_images !== undefined
      ? { input_images: request.input_images }
      : {}),
    ...(request.mask_image !== undefined
      ? { mask_image: request.mask_image }
      : {}),
    ...(request.selection_region !== undefined
      ? { selection_region: request.selection_region }
      : {}),
    target:
      request.target !== undefined
        ? request.target
        : legacyCanvasTarget(request),
  });
}

const videoGenerationShape = {
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().positive().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: uniqueStringsSchema.optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
} as const;

export const createVideoJobRequestSchema = z
  .object({
    ...requestContextShape,
    ...videoGenerationShape,
    canvas_id: z.string().uuid().optional(),
    target: jobTargetSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target !== undefined && value.canvas_id !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "modern target and legacy canvas routing are mutually exclusive",
        path: ["target"],
      });
    }
  });
export type CreateVideoJobRequest = z.infer<typeof createVideoJobRequestSchema>;

export const normalizedVideoGenerationPayloadSchema = z
  .object({ ...videoGenerationShape, target: jobTargetSchema.nullable() })
  .strict();
export const videoGenerationPayloadSchema =
  normalizedVideoGenerationPayloadSchema;
export type NormalizedVideoGenerationPayload = z.infer<
  typeof normalizedVideoGenerationPayloadSchema
>;
export type VideoGenerationPayload = NormalizedVideoGenerationPayload;

export function normalizeVideoGenerationPayload(
  input: unknown,
): NormalizedVideoGenerationPayload {
  const request = createVideoJobRequestSchema.parse(input);
  return normalizedVideoGenerationPayloadSchema.parse({
    prompt: request.prompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.duration !== undefined ? { duration: request.duration } : {}),
    ...(request.resolution !== undefined
      ? { resolution: request.resolution }
      : {}),
    ...(request.aspect_ratio !== undefined
      ? { aspect_ratio: request.aspect_ratio }
      : {}),
    ...(request.input_images !== undefined
      ? { input_images: request.input_images }
      : {}),
    ...(request.input_video !== undefined
      ? { input_video: request.input_video }
      : {}),
    ...(request.enable_audio !== undefined
      ? { enable_audio: request.enable_audio }
      : {}),
    target:
      request.target !== undefined
        ? request.target
        : request.canvas_id
          ? canvasJobTargetSchema.parse({
              kind: "canvas",
              canvas_id: request.canvas_id,
            })
          : null,
  });
}

export const designExportJobPayloadSchema = designExportPayloadSchema;
export const designExportJobResultSchema = designExportResultSchema;

const backgroundJobRecordShape = {
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  canvas_id: z.string().uuid().nullable(),
  target_kind: z.enum(["canvas", "design"]).nullable().optional(),
  design_id: z.string().uuid().nullable().optional(),
  session_id: z.string().uuid().nullable(),
  thread_id: z.string().nullable(),
  queue_name: z.string(),
  job_type: backgroundJobTypeSchema,
  status: backgroundJobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
} as const;

type BackgroundJobTargetColumns = {
  target_kind?: "canvas" | "design" | null | undefined;
  canvas_id: string | null;
  design_id?: string | null | undefined;
};

function validateBackgroundJobTargetColumns(
  value: BackgroundJobTargetColumns,
  context: z.RefinementCtx,
) {
  if (value.target_kind === "canvas") {
    if (value.canvas_id === null || value.design_id != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "canvas target requires only canvas_id",
        path: ["target_kind"],
      });
    }
    return;
  }
  if (value.target_kind === "design") {
    if (value.design_id == null || value.canvas_id !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "design target requires only design_id",
        path: ["target_kind"],
      });
    }
    return;
  }
  if (value.target_kind === null) {
    if (value.canvas_id !== null || value.design_id != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat-only target requires null target columns",
        path: ["target_kind"],
      });
    }
    return;
  }
  // Missing target_kind is the legacy persisted form. It may carry a
  // canvas_id but must never carry a design_id.
  if (value.design_id != null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "legacy jobs cannot carry design_id",
      path: ["design_id"],
    });
  }
}

export const backgroundJobSchema = z
  .object(backgroundJobRecordShape)
  .strict()
  .superRefine(validateBackgroundJobTargetColumns);
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

const imageGenerationWorkerJobSchema = z
  .object({
    ...backgroundJobRecordShape,
    job_type: z.literal("image_generation"),
    payload: normalizedImageGenerationPayloadSchema,
  })
  .strict();

const videoGenerationWorkerJobSchema = z
  .object({
    ...backgroundJobRecordShape,
    job_type: z.literal("video_generation"),
    payload: normalizedVideoGenerationPayloadSchema,
  })
  .strict();

export const designExportWorkerJobSchema = z
  .object({
    ...backgroundJobRecordShape,
    job_type: z.literal("design_export"),
    payload: designExportPayloadSchema,
    result: designExportResultSchema.nullable(),
  })
  .strict();

function validateCanonicalWorkerRouting(
  value:
    | z.infer<typeof imageGenerationWorkerJobSchema>
    | z.infer<typeof videoGenerationWorkerJobSchema>
    | z.infer<typeof designExportWorkerJobSchema>,
  context: z.RefinementCtx,
) {
  validateBackgroundJobTargetColumns(value, context);
  if (value.job_type === "design_export") {
    if (
      value.target_kind !== "design" ||
      value.design_id !== value.payload.design_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "design export payload and job row must target the same design",
        path: ["payload", "design_id"],
      });
    }
    if (
      value.result !== null &&
      (value.result.design_id !== value.payload.design_id ||
        value.result.revision !== value.payload.revision)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "design export result must match the requested revision",
        path: ["result"],
      });
    }
    return;
  }

  const target = value.payload.target;
  if (target === null) {
    if (value.target_kind !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat-only Worker payload requires null target columns",
        path: ["payload", "target"],
      });
    }
    return;
  }
  if (
    target.kind !== value.target_kind ||
    (target.kind === "canvas" && target.canvas_id !== value.canvas_id) ||
    (target.kind === "design" && target.design_id !== value.design_id)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Worker payload target must match persisted target columns",
      path: ["payload", "target"],
    });
  }
}

export const backgroundJobWorkerSchema = z
  .discriminatedUnion("job_type", [
    imageGenerationWorkerJobSchema,
    videoGenerationWorkerJobSchema,
    designExportWorkerJobSchema,
  ])
  .superRefine(validateCanonicalWorkerRouting);
export type BackgroundJobWorker = z.infer<typeof backgroundJobWorkerSchema>;

export const jobResponseSchema = z.object({ job: backgroundJobSchema });
export type JobResponse = z.infer<typeof jobResponseSchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;
