import {
  type ManualCanvasImageImportRequest,
  type ManualCanvasImageImportResponse,
  type UndoManualCanvasImageImportRequest,
  type UndoManualCanvasImageImportResponse,
  canvasRevisionConflictResponseSchema,
  designConflictResponseSchema,
  designErrorResponseSchema,
  designUuidSchema,
  manualCanvasImageImportRequestSchema,
  manualCanvasImageImportResponseSchema,
  undoManualCanvasImageImportRequestSchema,
  undoManualCanvasImageImportResponseSchema,
} from "@loomic/shared";

import { DesignApiError } from "./design-api";
import { getServerBaseUrl } from "./env";

type FetchImplementation = typeof globalThis.fetch;
type ResponseSchema<T> = { parse(value: unknown): T };
type RequestOptions = {
  baseUrl?: string;
  fetch?: FetchImplementation;
};

export async function importCanvasImageToDesign(
  accessToken: string,
  rawInput: ManualCanvasImageImportRequest,
  options: RequestOptions = {},
): Promise<ManualCanvasImageImportResponse> {
  const input = manualCanvasImageImportRequestSchema.parse(rawInput);
  return request({
    accessToken,
    path: `/api/designs/${encodeURIComponent(input.design_id)}/canvas-image-imports`,
    body: input,
    responseSchema: manualCanvasImageImportResponseSchema,
    ...options,
  });
}

export async function undoCanvasImageImport(
  accessToken: string,
  rawDesignId: string,
  rawOperationId: string,
  rawInput: UndoManualCanvasImageImportRequest,
  options: RequestOptions = {},
): Promise<UndoManualCanvasImageImportResponse> {
  const designId = designUuidSchema.parse(rawDesignId);
  const operationId = designUuidSchema.parse(rawOperationId);
  const input = undoManualCanvasImageImportRequestSchema.parse(rawInput);
  return request({
    accessToken,
    path: `/api/designs/${encodeURIComponent(designId)}/canvas-image-imports/${encodeURIComponent(operationId)}/undo`,
    body: input,
    responseSchema: undoManualCanvasImageImportResponseSchema,
    ...options,
  });
}

async function request<T>(input: {
  accessToken: string;
  path: string;
  body: unknown;
  responseSchema: ResponseSchema<T>;
  baseUrl?: string;
  fetch?: FetchImplementation;
}): Promise<T> {
  const baseUrl = (input.baseUrl ?? getServerBaseUrl()).replace(/\/$/, "");
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(`${baseUrl}${input.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
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
  const body = await readJson(response);
  if (!response.ok) throwResponseError(response, body);
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

function throwResponseError(response: Response, body: unknown): never {
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
