import type {
  AssetSignedUrlResponse,
  CanvasDetail,
  ChatMessageCreateRequest,
  CreateImageJobRequest,
  NodeImageSubmissionRequest,
  NodeImageSubmissionResponse,
  NodeImageSubmissionLookup,
  JobResponse,
  MarketplaceDetail,
  MarketplaceSearchResponse,
  MessageCreateResponse,
  MessageListResponse,
  ModelListResponse,
  ProfileUpdateResponse,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectListResponse,
  ProjectUpdateRequest,
  RunCreateRequest,
  RunCreateResponse,
  SessionCreateResponse,
  SessionListResponse,
  SkillCreateRequest,
  SkillDetailResponse,
  SkillListResponse,
  SkillUpdateRequest,
  UploadResponse,
  ViewerResponse,
  WorkspaceSettingsResponse,
  WorkspaceSkillListResponse,
  ProviderConfigCreateRequest,
  ProviderConfigListResponse,
  ProviderConfigResponse,
  ProviderConfigUpdateRequest,
  ProviderConnectionTestResponse,
  ProviderModelDiscoveryResponse,
  WorkspaceMemberCreateRequest,
  WorkspaceMemberListResponse,
  WorkspaceMemberResponse,
  WorkspaceMemberUpdateRequest,
  AdminAccessResponse,
  AdminOverviewResponse,
  AdminPlatformAdminListResponse,
  AdminAuditListResponse,
  AdminUserDirectoryResponse,
  AdminWorkspaceDirectoryResponse,
  AdminAssignableRole,
  AdminWorkspaceBillingResponse,
  AdminSkillCatalogResponse,
  AdminSkillPreviewListResponse,
  PublishedSkillPreviewsResponse,
} from "@loomic/shared";
import {
  canvasGetResponseSchema,
  nodeImageSubmissionRequestSchema,
  nodeImageSubmissionResponseSchema,
  nodeImageSubmissionLookupSchema,
  nodeImageSubmissionLookupResponseSchema,
  canvasSaveResponseSchema,
  providerConfigListResponseSchema,
  providerConfigResponseSchema,
  providerConnectionTestResponseSchema,
  providerModelDiscoveryResponseSchema,
  workspaceMemberListResponseSchema,
  workspaceMemberResponseSchema,
} from "@loomic/shared";

import { dedupeRequest } from "./dedupe-request";
import { getServerBaseUrl } from "./env";
import {
  parseAgentRunDetailResponse,
  parseAgentRunListPage,
  type AgentRunDetail,
  type AgentRunListPage,
} from "./agent-run-history";

export type {
  AgentRunDetail,
  AgentRunExecutionMode,
  AgentRunListPage,
  AgentRunStatus,
  AgentRunSummary,
  AgentRunToolCounts,
  AgentRunToolExecutionDetail,
} from "./agent-run-history";

// --- Error types ---

export class ApiAuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "ApiAuthError";
  }
}

export class ApiApplicationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiApplicationError";
    this.code = code;
  }
}

// --- Existing ---

export async function createRun(
  payload: RunCreateRequest,
  options?: { accessToken?: string },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options?.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  const response = await fetch(`${getServerBaseUrl()}/api/agent/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Run creation failed with status ${response.status}`);
  }

  return (await response.json()) as RunCreateResponse;
}

// --- Authenticated API ---

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const message = body?.error?.message ?? "Request failed";
  throw new ApiApplicationError(code, message);
}

export async function fetchViewer(
  accessToken: string,
): Promise<ViewerResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ViewerResponse;
}

export async function fetchProjects(
  accessToken: string,
): Promise<ProjectListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectListResponse;
}

export async function createProject(
  accessToken: string,
  data: ProjectCreateRequest,
): Promise<ProjectCreateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectCreateResponse;
}

export async function deleteProject(
  accessToken: string,
  projectId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchProject(
  accessToken: string,
  projectId: string,
): Promise<{
  project: { id: string; name: string; brand_kit_id: string | null };
}> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    project: { id: string; name: string; brand_kit_id: string | null };
  };
}

export async function updateProject(
  accessToken: string,
  projectId: string,
  data: ProjectUpdateRequest,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas API ---

export async function fetchCanvas(
  accessToken: string,
  canvasId: string,
): Promise<{ canvas: CanvasDetail }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return canvasGetResponseSchema.parse(await response.json()) as {
    canvas: CanvasDetail;
  };
}

export async function saveCanvas(
  accessToken: string,
  canvasId: string,
  content: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  },
): Promise<number> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
    {
      method: "PUT",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return canvasSaveResponseSchema.parse(await response.json()).revision;
}

export async function uploadThumbnail(
  accessToken: string,
  projectId: string,
  blob: Blob,
): Promise<void> {
  const formData = new FormData();
  formData.append("file", blob, "thumbnail.webp");
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}/thumbnail`,
    {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: formData,
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Settings API ---

export async function updateProfile(
  accessToken: string,
  data: { displayName: string },
): Promise<ProfileUpdateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer/profile`, {
    method: "PATCH",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProfileUpdateResponse;
}

export async function fetchWorkspaceSettings(
  accessToken: string,
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

export async function updateWorkspaceSettings(
  accessToken: string,
  data: { defaultModel?: string },
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    method: "PUT",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

export async function fetchModels(
  accessToken?: string,
): Promise<ModelListResponse> {
  const url = `${getServerBaseUrl()}/api/models`;
  const response = accessToken
    ? await fetch(url, { headers: authHeaders(accessToken) })
    : await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`);
  }
  return (await response.json()) as ModelListResponse;
}

// --- Chat Session API ---

export function fetchSessions(
  accessToken: string,
  canvasId: string,
): Promise<SessionListResponse> {
  return dedupeRequest(`sessions:${canvasId}`, async () => {
    const response = await fetch(
      `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
      { headers: authHeaders(accessToken) },
    );
    if (!response.ok) return handleErrorResponse(response);
    return (await response.json()) as SessionListResponse;
  });
}

export async function createSession(
  accessToken: string,
  canvasId: string,
  title?: string,
): Promise<SessionCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(title ? { title } : {}),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SessionCreateResponse;
}

export async function updateSessionTitle(
  accessToken: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ title }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function deleteSession(
  accessToken: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchMessages(
  accessToken: string,
  sessionId: string,
): Promise<MessageListResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageListResponse;
}

export async function saveMessage(
  accessToken: string,
  sessionId: string,
  data: ChatMessageCreateRequest,
): Promise<MessageCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageCreateResponse;
}

/**
 * Delete a message and every later message in the session.
 *
 * Used by "edit and resend" so the superseded attempt does not remain visible
 * above the replacement turn. The server resolves the cut by conversation order
 * and applies the session's own RLS delete policy.
 */
export async function truncateMessagesFrom(
  accessToken: string,
  sessionId: string,
  messageId: string,
): Promise<{ deleted: number }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages/${messageId}/tail`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { deleted: number };
}

// --- Upload API ---
export async function uploadFile(
  accessToken: string,
  file: File,
  projectId?: string,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (projectId) {
    formData.append("projectId", projectId);
  }

  const response = await fetch(`${getServerBaseUrl()}/api/uploads`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: formData,
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as UploadResponse;
}

export async function getAssetUrl(
  accessToken: string,
  assetId: string,
): Promise<AssetSignedUrlResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/${assetId}/url`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AssetSignedUrlResponse;
}

export async function deleteAsset(
  accessToken: string,
  assetId: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/uploads/${assetId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas-Native Generation API ---

export type GenerateImageResponse = {
  url: string;
  assetId: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
};

export type ImageModelInfo = {
  id: string;
  supportsExact2K?: boolean;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
};

export async function fetchImageModels(accessToken?: string): Promise<{
  models: ImageModelInfo[];
}> {
  const url = `${getServerBaseUrl()}/api/image-models`;
  const response = accessToken
    ? await fetch(url, { headers: authHeaders(accessToken) })
    : await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image models: ${response.status}`);
  }
  return (await response.json()) as { models: ImageModelInfo[] };
}

export type VideoModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
  capabilities?: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits?: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
  pricing?: {
    currency: "CNY";
    billingUnit: "generated_second";
    providerPointsName: string;
    evidenceDate: string;
    rates: Array<{
      resolution: "720p" | "1080p";
      displayResolution: string;
      providerPointsPerSecond: number;
      cnyPerSecond: { min: number; max: number };
    }>;
  };
};

export async function fetchVideoModels(accessToken?: string): Promise<{
  models: VideoModelInfo[];
}> {
  const url = `${getServerBaseUrl()}/api/video-models`;
  const response = accessToken
    ? await fetch(url, { headers: authHeaders(accessToken) })
    : await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch video models: ${response.status}`);
  }
  return (await response.json()) as { models: VideoModelInfo[] };
}

export async function submitNodeImageGeneration(
  accessToken: string, payload: NodeImageSubmissionRequest,
): Promise<NodeImageSubmissionResponse> {
  const request = nodeImageSubmissionRequestSchema.parse(payload);
  const response = await fetch(`${getServerBaseUrl()}/api/jobs/node-image-generation`, {
    method: "POST", headers: authJsonHeaders(accessToken), body: JSON.stringify(request),
  });
  if (!response.ok) return handleErrorResponse(response);
  return nodeImageSubmissionResponseSchema.parse(await response.json());
}

export async function getNodeImageSubmission(accessToken: string, input: NodeImageSubmissionLookup) {
  const key = nodeImageSubmissionLookupSchema.parse(input);
  const query = new URLSearchParams({ canvas_id: key.canvasId, element_id: key.elementId });
  const response = await fetch(`${getServerBaseUrl()}/api/jobs/node-image-generation/${key.requestId}?${query}`, {
    method: "GET", headers: authJsonHeaders(accessToken), cache: "no-store",
  });
  if (!response.ok) return handleErrorResponse(response);
  return nodeImageSubmissionLookupResponseSchema.parse(await response.json());
}

export async function generateImageDirect(
  accessToken: string,
  prompt: string,
  options?: { model?: string; aspectRatio?: string; quality?: string },
): Promise<GenerateImageResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/generate-image`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options?.quality ? { quality: options.quality } : {}),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as GenerateImageResponse;
}

export type GenerateVideoResponse = {
  url: string;
  assetId: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
};

export async function generateVideoDirect(
  accessToken: string,
  prompt: string,
  options?: {
    model?: string;
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    inputImages?: string[];
    idempotencyKey?: string;
  },
): Promise<GenerateVideoResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/generate-video`,
    {
      method: "POST",
      headers: {
        ...authJsonHeaders(accessToken),
        ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.duration != null ? { duration: options.duration } : {}),
        ...(options?.resolution ? { resolution: options.resolution } : {}),
        ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options?.inputImages?.length
          ? { inputImages: options.inputImages }
          : {}),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as GenerateVideoResponse;
}

// --- Jobs API ---

export async function fetchJob(
  accessToken: string,
  jobId: string,
): Promise<JobResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/jobs/${jobId}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

export async function createImageGenerationJob(
  accessToken: string,
  payload: CreateImageJobRequest,
): Promise<JobResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/jobs/image-generation`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

export async function recognizeCanvasImageText(
  accessToken: string,
  canvasId: string,
  image: { assetId: string; url: string; mimeType: string },
): Promise<{ texts: string[] }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/images/recognize-text`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ canvasId, image }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { texts?: unknown };
  return {
    texts: Array.isArray(payload.texts)
      ? payload.texts.filter((item): item is string => typeof item === "string")
      : [],
  };
}

/**
 * Names the elements a generative layer split should extract. One paid vision
 * call; the split itself is quoted separately before anything is generated.
 */
export async function suggestLayerElements(
  accessToken: string,
  canvasId: string,
  image: { assetId: string; url: string; mimeType: string },
): Promise<{ elements: string[] }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/images/layer-elements`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ canvasId, image }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { elements?: unknown };
  return {
    elements: Array.isArray(payload.elements)
      ? payload.elements.filter((item): item is string => typeof item === "string")
      : [],
  };
}

// --- Workspace provider configurations (admin only) ---
export async function fetchProviderConfigs(
  accessToken: string,
): Promise<ProviderConfigListResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/provider-configs`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return providerConfigListResponseSchema.parse(await response.json());
}

export async function createProviderConfig(
  accessToken: string,
  data: ProviderConfigCreateRequest,
): Promise<ProviderConfigResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/provider-configs`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return providerConfigResponseSchema.parse(await response.json());
}

export async function updateProviderConfig(
  accessToken: string,
  providerId: string,
  data: ProviderConfigUpdateRequest,
): Promise<ProviderConfigResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/provider-configs/${encodeURIComponent(providerId)}`,
    {
      method: "PUT",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return providerConfigResponseSchema.parse(await response.json());
}

export async function deleteProviderConfig(
  accessToken: string,
  providerId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/provider-configs/${encodeURIComponent(providerId)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function testProviderConnection(
  accessToken: string,
  providerId: string,
): Promise<ProviderConnectionTestResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/provider-configs/${encodeURIComponent(providerId)}/test`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return providerConnectionTestResponseSchema.parse(await response.json());
}

export async function discoverDraftProviderModels(
  accessToken: string,
  input: { baseUrl: string; apiKey?: string; configId?: string },
): Promise<ProviderModelDiscoveryResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/provider-configs/discover-models`, {
    method: "POST", headers: authJsonHeaders(accessToken), body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
  return providerModelDiscoveryResponseSchema.parse(await response.json());
}

export async function discoverProviderModels(
  accessToken: string,
  providerId: string,
): Promise<ProviderModelDiscoveryResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/provider-configs/${encodeURIComponent(providerId)}/discover-models`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return providerModelDiscoveryResponseSchema.parse(await response.json());
}

// --- Workspace members (owner/admin only) ---

export async function fetchWorkspaceMembers(
  accessToken: string,
): Promise<WorkspaceMemberListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/members`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return workspaceMemberListResponseSchema.parse(await response.json());
}

export async function addWorkspaceMember(
  accessToken: string,
  data: WorkspaceMemberCreateRequest,
): Promise<WorkspaceMemberResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/members`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return workspaceMemberResponseSchema.parse(await response.json());
}

export async function updateWorkspaceMember(
  accessToken: string,
  userId: string,
  data: WorkspaceMemberUpdateRequest,
): Promise<WorkspaceMemberResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return workspaceMemberResponseSchema.parse(await response.json());
}

export async function removeWorkspaceMember(
  accessToken: string,
  userId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspace/members/${encodeURIComponent(userId)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Agent Run History API ---

export async function fetchSessionRuns(
  accessToken: string,
  sessionId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<AgentRunListPage> {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 50)
  ) {
    throw new RangeError("Run history limit must be an integer from 1 to 50.");
  }

  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await fetch(
    `${getServerBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/runs${suffix}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleRunHistoryErrorResponse(response);
  return parseAgentRunListPage(await readJsonResponse(response));
}

export async function fetchAgentRunDetail(
  accessToken: string,
  sessionId: string,
  runId: string,
): Promise<AgentRunDetail> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleRunHistoryErrorResponse(response);
  return parseAgentRunDetailResponse(await readJsonResponse(response));
}

async function handleRunHistoryErrorResponse(
  response: Response,
): Promise<never> {
  if (response.status === 401) throw new ApiAuthError();
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? `http_${response.status}`;
  const message = body?.error?.message ?? body?.message ?? "Request failed";
  throw new ApiApplicationError(code, message);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiApplicationError(
      "invalid_response",
      "Server returned an invalid JSON response.",
    );
  }
}

export type RestoreJobToCanvasResponse = {
  jobId: string;
  canvasId: string;
  elementId: string;
  inserted: boolean;
};

export async function restoreJobToCanvas(
  accessToken: string,
  jobId: string,
): Promise<RestoreJobToCanvasResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/restore-to-canvas`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as RestoreJobToCanvasResponse;
}

// --- Skills API ---

export async function fetchSkills(
  accessToken: string,
): Promise<SkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillListResponse;
}

export async function fetchSkillDetail(
  accessToken: string,
  id: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${id}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function createSkill(
  accessToken: string,
  data: SkillCreateRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function updateSkill(
  accessToken: string,
  id: string,
  data: SkillUpdateRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${id}`, {
    method: "PUT",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function deleteSkill(
  accessToken: string,
  id: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchSkillFiles(
  accessToken: string,
  skillId: string,
): Promise<{
  files: Array<{
    id: string;
    filePath: string;
    content: string;
    mimeType: string;
    createdAt: string;
    updatedAt: string;
  }>;
}> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/${skillId}/files`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as any;
}

// --- Workspace Skills API ---

export async function fetchWorkspaceSkills(
  accessToken: string,
): Promise<WorkspaceSkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspaces/skills`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSkillListResponse;
}

export async function installSkill(
  accessToken: string,
  skillId: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspaces/skills`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ skillId }),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function uninstallSkill(
  accessToken: string,
  skillId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspaces/skills/${skillId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function toggleSkill(
  accessToken: string,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspaces/skills/${skillId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ enabled }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Marketplace API ---

export async function searchMarketplace(
  accessToken: string,
  query: string,
  page = 1,
  limit = 20,
): Promise<MarketplaceSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    limit: String(limit),
  });
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/marketplace/search?${params}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MarketplaceSearchResponse;
}

export async function getMarketplaceDetail(
  accessToken: string,
  packageName: string,
): Promise<MarketplaceDetail> {
  const params = new URLSearchParams({ name: packageName });
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/marketplace/detail?${params}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MarketplaceDetail;
}

export async function installMarketplaceSkill(
  accessToken: string,
  packageName: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/marketplace/install`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ packageName }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function importSkillFromUrl(
  accessToken: string,
  url: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/import`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ url }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

/**
 * Whether the signed-in user is a platform admin, so the console can decide
 * whether to render its tab. This is presentation only: every data route
 * re-checks the same condition server-side.
 */
export async function fetchAdminAccess(
  accessToken: string,
): Promise<AdminAccessResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/access`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminAccessResponse;
}

/** Read-only platform overview. The server refuses a non-admin with 403. */
export async function fetchAdminOverview(
  accessToken: string,
): Promise<AdminOverviewResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/overview`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminOverviewResponse;
}

export async function fetchAdminPlatformAdmins(
  accessToken: string,
): Promise<AdminPlatformAdminListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/platform-admins`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminPlatformAdminListResponse;
}

/** Both access changes require a reason; the server stores it in the audit row. */
export async function grantAdminPlatformAdmin(
  accessToken: string,
  input: { email: string; reason: string },
): Promise<AdminPlatformAdminListResponse["admins"][number]> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/platform-admins`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
  return ((await response.json()) as { admin: AdminPlatformAdminListResponse["admins"][number] }).admin;
}

export async function revokeAdminPlatformAdmin(
  accessToken: string,
  userId: string,
  reason: string,
): Promise<AdminPlatformAdminListResponse["admins"][number]> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/platform-admins/${userId}`, {
    method: "DELETE",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return ((await response.json()) as { admin: AdminPlatformAdminListResponse["admins"][number] }).admin;
}

export async function fetchAdminAudit(
  accessToken: string,
  options: { limit?: number; targetKind?: string; targetId?: string } = {},
): Promise<AdminAuditListResponse> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.targetKind) query.set("targetKind", options.targetKind);
  if (options.targetId) query.set("targetId", options.targetId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await fetch(`${getServerBaseUrl()}/api/admin/audit${suffix}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminAuditListResponse;
}

export async function fetchAdminUsers(
  accessToken: string,
  options: { query?: string; userId?: string; limit?: number; offset?: number } = {},
): Promise<AdminUserDirectoryResponse> {
  const search = new URLSearchParams();
  if (options.query) search.set("query", options.query);
  if (options.userId) search.set("userId", options.userId);
  if (options.limit !== undefined) search.set("limit", String(options.limit));
  if (options.offset !== undefined) search.set("offset", String(options.offset));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await fetch(`${getServerBaseUrl()}/api/admin/users${suffix}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminUserDirectoryResponse;
}

export async function fetchAdminWorkspaces(
  accessToken: string,
  options: { query?: string; limit?: number } = {},
): Promise<AdminWorkspaceDirectoryResponse> {
  const search = new URLSearchParams();
  if (options.query) search.set("query", options.query);
  if (options.limit !== undefined) search.set("limit", String(options.limit));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await fetch(`${getServerBaseUrl()}/api/admin/workspaces${suffix}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminWorkspaceDirectoryResponse;
}

/** Membership writes all require a reason; the server stores it in the audit row. */
export async function adminAddWorkspaceMember(
  accessToken: string,
  workspaceId: string,
  input: { userId: string; role: AdminAssignableRole; reason: string },
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/workspaces/${workspaceId}/members`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function adminSetWorkspaceMemberRole(
  accessToken: string,
  workspaceId: string,
  userId: string,
  input: { role: AdminAssignableRole; reason: string },
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/workspaces/${workspaceId}/members/${userId}`, {
    method: "PATCH",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function adminRemoveWorkspaceMember(
  accessToken: string,
  workspaceId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchAdminWorkspaceBilling(
  accessToken: string,
  workspaceId: string,
  limit = 20,
): Promise<AdminWorkspaceBillingResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/workspaces/${workspaceId}/billing?limit=${limit}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminWorkspaceBillingResponse;
}

export async function adminSetWorkspacePlan(
  accessToken: string,
  workspaceId: string,
  input: { plan: string; grantCredits: number; reason: string },
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/workspaces/${workspaceId}/plan`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function adminAdjustWorkspaceCredits(
  accessToken: string,
  workspaceId: string,
  input: { delta: number; reason: string },
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/workspaces/${workspaceId}/credits`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchAdminSkillCatalog(
  accessToken: string,
  options: { query?: string; limit?: number } = {},
): Promise<AdminSkillCatalogResponse> {
  const search = new URLSearchParams();
  if (options.query) search.set("query", options.query);
  if (options.limit !== undefined) search.set("limit", String(options.limit));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await fetch(`${getServerBaseUrl()}/api/admin/skills${suffix}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminSkillCatalogResponse;
}

export async function fetchAdminSkillPreviews(
  accessToken: string,
  skillId: string,
): Promise<AdminSkillPreviewListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/skills/${skillId}/previews`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AdminSkillPreviewListResponse;
}

/** Multipart: the file, its role, an optional caption and the mandatory reason. */
export async function uploadAdminSkillPreview(
  accessToken: string,
  skillId: string,
  input: { file: File; role: "cover" | "example"; caption: string; reason: string },
): Promise<void> {
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  form.append("role", input.role);
  if (input.caption.trim()) form.append("caption", input.caption.trim());
  form.append("reason", input.reason.trim());
  const response = await fetch(`${getServerBaseUrl()}/api/admin/skills/${skillId}/previews`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function publishAdminSkillPreview(
  accessToken: string,
  skillId: string,
  previewId: string,
  reason: string,
  action: "publish" | "unpublish" = "publish",
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/skills/${skillId}/previews/${previewId}/${action}`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ reason: reason.trim() }),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function deleteAdminSkillPreview(
  accessToken: string,
  skillId: string,
  previewId: string,
  reason: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/skills/${skillId}/previews/${previewId}`, {
    method: "DELETE",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ reason: reason.trim() }),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function reorderAdminSkillPreviews(
  accessToken: string,
  skillId: string,
  orderedPreviewIds: string[],
  reason: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/skills/${skillId}/previews/order`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ orderedPreviewIds, reason: reason.trim() }),
  });
  if (!response.ok) return handleErrorResponse(response);
}

/** Published previews only; available to any signed-in user. */
export async function fetchPublishedSkillPreviews(
  accessToken: string,
  slug: string,
): Promise<PublishedSkillPreviewsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${encodeURIComponent(slug)}/previews`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as PublishedSkillPreviewsResponse;
}
