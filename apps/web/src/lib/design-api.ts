import {
  type BackgroundJob,
  type CanvasDetail,
  type CopyDesignRequest,
  type CreateDesignRequest,
  type CreateDesignResponse,
  type CreateImageJobRequest,
  type DeleteDesignRequest,
  type DesignDocumentDto,
  type DesignExportRequest,
  type DesignLifecycleResponse,
  type DesignMutationRequest,
  type DesignMutationResponse,
  type DesignReferencesResponse,
  type JobResponse,
  type QueueDesignPreviewRequest,
  type QueueDesignPreviewResponse,
  type RenameDesignRequest,
  type RestoreDesignRequest,
  canvasRevisionConflictResponseSchema,
  copyDesignRequestSchema,
  createDesignRequestSchema,
  createDesignResponseSchema,
  createImageJobRequestSchema,
  deleteDesignRequestSchema,
  designConflictResponseSchema,
  designErrorResponseSchema,
  designExportRequestSchema,
  designGetResponseSchema,
  designLifecycleResponseSchema,
  designMutationRequestSchema,
  designMutationResponseSchema,
  designReferencesResponseSchema,
  designUuidSchema,
  jobListResponseSchema,
  jobResponseSchema,
  queueDesignPreviewRequestSchema,
  queueDesignPreviewResponseSchema,
  renameDesignRequestSchema,
  restoreDesignRequestSchema,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";

type ResponseSchema<T> = { parse(value: unknown): T };
type FetchImplementation = typeof globalThis.fetch;

export type DesignApiErrorCode =
  | "unauthorized"
  | "DESIGN_CONFLICT"
  | "CANVAS_REVISION_CONFLICT"
  | "design_not_found"
  | "design_forbidden"
  | "design_invalid"
  | "design_create_failed"
  | "design_query_failed"
  | "design_write_failed"
  | "job_not_found"
  | "job_query_failed"
  | "job_cancel_failed"
  | "network_error"
  | "response_invalid";

export class DesignApiError extends Error {
  constructor(
    readonly code: DesignApiErrorCode,
    message: string,
    readonly status: number,
    readonly conflict?: {
      designId?: string;
      canvasId?: string;
      latestRevision: number;
      conflictObjectIds: string[];
      retryable: boolean;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignApiError";
  }
}

export type DesignApiClient = {
  getDesign(accessToken: string, designId: string): Promise<DesignDocumentDto>;
  createDesign(
    accessToken: string,
    input: CreateDesignRequest,
  ): Promise<CreateDesignResponse>;
  mutateDesign(
    accessToken: string,
    input: DesignMutationRequest,
  ): Promise<DesignMutationResponse>;
  renameDesign(
    accessToken: string,
    input: RenameDesignRequest,
  ): Promise<DesignLifecycleResponse>;
  copyDesign(
    accessToken: string,
    input: CopyDesignRequest,
  ): Promise<CreateDesignResponse>;
  deleteDesign(
    accessToken: string,
    input: DeleteDesignRequest,
  ): Promise<DesignLifecycleResponse>;
  restoreDesign(
    accessToken: string,
    input: RestoreDesignRequest,
  ): Promise<DesignLifecycleResponse>;
  getDesignReferences(
    accessToken: string,
    designId: string,
  ): Promise<DesignReferencesResponse>;
  queueDesignPreview(
    accessToken: string,
    input: QueueDesignPreviewRequest,
  ): Promise<QueueDesignPreviewResponse>;
  exportDesign(
    accessToken: string,
    input: DesignExportRequest,
  ): Promise<JobResponse>;
  listDesignExportJobs(
    accessToken: string,
    designId: string,
  ): Promise<BackgroundJob[]>;
  getDesignExportJob(
    accessToken: string,
    jobId: string,
  ): Promise<BackgroundJob>;
  cancelDesignExportJob(
    accessToken: string,
    jobId: string,
  ): Promise<BackgroundJob>;
  createDesignImageJob(
    accessToken: string,
    input: CreateImageJobRequest,
  ): Promise<BackgroundJob>;
  listDesignImageJobs(
    accessToken: string,
    designId: string,
  ): Promise<BackgroundJob[]>;
  getDesignImageJob(accessToken: string, jobId: string): Promise<BackgroundJob>;
  cancelDesignImageJob(
    accessToken: string,
    jobId: string,
  ): Promise<BackgroundJob>;
};

export function createDesignApiClient(
  options: {
    baseUrl?: string;
    fetch?: FetchImplementation;
  } = {},
): DesignApiClient {
  const baseUrl = (options.baseUrl ?? getServerBaseUrl()).replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  const request = async <T>(input: {
    accessToken: string;
    path: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    responseSchema: ResponseSchema<T>;
  }): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${input.path}`, {
        method: input.method ?? "GET",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      });
    } catch (error) {
      throw new DesignApiError(
        "network_error",
        "Unable to reach the design service.",
        0,
        undefined,
        { cause: error },
      );
    }

    if (!response.ok) await throwDesignApiError(response);
    const body = await readJson(response);
    try {
      return input.responseSchema.parse(body);
    } catch (error) {
      throw new DesignApiError(
        "response_invalid",
        "The design service returned an invalid response.",
        response.status,
        undefined,
        { cause: error },
      );
    }
  };

  return {
    async getDesign(accessToken, rawDesignId) {
      const designId = designUuidSchema.parse(rawDesignId);
      const response = await request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(designId)}`,
        responseSchema: designGetResponseSchema,
      });
      return response.design;
    },

    createDesign(accessToken, rawInput) {
      const input = createDesignRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: "/api/designs",
        method: "POST",
        body: input,
        responseSchema: createDesignResponseSchema,
      });
    },

    mutateDesign(accessToken, rawInput) {
      const input = designMutationRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.design_id)}/mutations`,
        method: "POST",
        body: input,
        responseSchema: designMutationResponseSchema,
      });
    },

    renameDesign(accessToken, rawInput) {
      const input = renameDesignRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.design_id)}/name`,
        method: "PATCH",
        body: input,
        responseSchema: designLifecycleResponseSchema,
      });
    },

    copyDesign(accessToken, rawInput) {
      const input = copyDesignRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.source_design_id)}/copy`,
        method: "POST",
        body: input,
        responseSchema: createDesignResponseSchema,
      });
    },

    deleteDesign(accessToken, rawInput) {
      const input = deleteDesignRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.design_id)}`,
        method: "DELETE",
        body: input,
        responseSchema: designLifecycleResponseSchema,
      });
    },

    restoreDesign(accessToken, rawInput) {
      const input = restoreDesignRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.design_id)}/restore`,
        method: "POST",
        body: input,
        responseSchema: designLifecycleResponseSchema,
      });
    },

    getDesignReferences(accessToken, rawDesignId) {
      const designId = designUuidSchema.parse(rawDesignId);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(designId)}/references`,
        responseSchema: designReferencesResponseSchema,
      });
    },

    queueDesignPreview(accessToken, rawInput) {
      const input = queueDesignPreviewRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.design_id)}/preview`,
        method: "POST",
        body: input,
        responseSchema: queueDesignPreviewResponseSchema,
      });
    },

    exportDesign(accessToken, rawInput) {
      const input = designExportRequestSchema.parse(rawInput);
      return request({
        accessToken,
        path: `/api/designs/${encodeURIComponent(input.design_id)}/exports`,
        method: "POST",
        body: input,
        responseSchema: jobResponseSchema,
      });
    },

    async listDesignExportJobs(accessToken, rawDesignId) {
      const designId = designUuidSchema.parse(rawDesignId);
      const response = await request({
        accessToken,
        path: "/api/jobs?job_type=design_export",
        responseSchema: jobListResponseSchema,
      });
      return response.jobs.filter(
        (job) =>
          job.job_type === "design_export" &&
          job.target_kind === "design" &&
          job.design_id === designId,
      );
    },

    async getDesignExportJob(accessToken, rawJobId) {
      const jobId = designUuidSchema.parse(rawJobId);
      const response = await request({
        accessToken,
        path: `/api/jobs/${encodeURIComponent(jobId)}`,
        responseSchema: jobResponseSchema,
      });
      return response.job;
    },

    async cancelDesignExportJob(accessToken, rawJobId) {
      const jobId = designUuidSchema.parse(rawJobId);
      const response = await request({
        accessToken,
        path: `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
        method: "POST",
        responseSchema: jobResponseSchema,
      });
      return response.job;
    },

    async createDesignImageJob(accessToken, rawInput) {
      const input = createImageJobRequestSchema.parse(rawInput);
      const response = await request({
        accessToken,
        path: "/api/jobs/image-generation",
        method: "POST",
        body: input,
        responseSchema: jobResponseSchema,
      });
      return response.job;
    },

    async listDesignImageJobs(accessToken, rawDesignId) {
      const designId = designUuidSchema.parse(rawDesignId);
      const response = await request({
        accessToken,
        path: "/api/jobs?job_type=image_generation",
        responseSchema: jobListResponseSchema,
      });
      return response.jobs.filter(
        (job) =>
          job.job_type === "image_generation" &&
          job.target_kind === "design" &&
          job.design_id === designId,
      );
    },

    async getDesignImageJob(accessToken, rawJobId) {
      const jobId = designUuidSchema.parse(rawJobId);
      const response = await request({
        accessToken,
        path: `/api/jobs/${encodeURIComponent(jobId)}`,
        responseSchema: jobResponseSchema,
      });
      return response.job;
    },

    async cancelDesignImageJob(accessToken, rawJobId) {
      const jobId = designUuidSchema.parse(rawJobId);
      const response = await request({
        accessToken,
        path: `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
        method: "POST",
        responseSchema: jobResponseSchema,
      });
      return response.job;
    },
  };
}

export type CreateDesignForCanvasInput = Omit<
  CreateDesignRequest,
  "canvas_id" | "expected_canvas_revision"
>;

/** Builds creation input from a fetched Canvas; callers must never guess 0. */
export function createDesignRequestForCanvas(
  canvas: Pick<CanvasDetail, "id" | "revision">,
  input: CreateDesignForCanvasInput,
): CreateDesignRequest {
  return createDesignRequestSchema.parse({
    ...input,
    canvas_id: canvas.id,
    expected_canvas_revision: canvas.revision,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new DesignApiError(
      "response_invalid",
      "The design service returned a non-JSON response.",
      response.status,
      undefined,
      { cause: error },
    );
  }
}

async function throwDesignApiError(response: Response): Promise<never> {
  const body = await readJson(response);
  const canvasConflict = canvasRevisionConflictResponseSchema.safeParse(body);
  if (canvasConflict.success) {
    const error = canvasConflict.data.error;
    throw new DesignApiError(error.code, error.message, response.status, {
      canvasId: error.canvas_id,
      latestRevision: error.latest_revision,
      conflictObjectIds: [],
      retryable: error.retryable,
    });
  }
  const designConflict = designConflictResponseSchema.safeParse(body);
  if (designConflict.success) {
    const error = designConflict.data.error;
    throw new DesignApiError(error.code, error.message, response.status, {
      designId: error.design_id,
      latestRevision: error.latest_revision,
      conflictObjectIds: error.conflict_object_ids,
      retryable: error.retryable,
    });
  }
  const applicationError = designErrorResponseSchema.safeParse(body);
  if (applicationError.success) {
    throw new DesignApiError(
      applicationError.data.error.code,
      applicationError.data.error.message,
      response.status,
    );
  }
  if (response.status === 401) {
    throw new DesignApiError("unauthorized", "Unauthorized.", 401);
  }
  throw new DesignApiError(
    "response_invalid",
    "The design service returned an invalid error response.",
    response.status,
  );
}
