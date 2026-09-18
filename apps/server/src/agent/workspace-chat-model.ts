import type { ProviderSnapshotService } from "../features/providers/index.js";
import { resolveKnownContextModelProfile } from "./context-budget.js";
import { type WorkspaceVisionModel, createWorkspaceVisionModel } from "./workspace-vision-model.js";

export async function resolveWorkspaceChatModel(input: {
  modelRef: string;
  providerSnapshotService: ProviderSnapshotService;
  runId: string;
  workspaceId: string;
  /** Already-resolved snapshot for this run; avoids a second provider RPC. */
  snapshot?: Awaited<ReturnType<ProviderSnapshotService["resolveRunSnapshot"]>>;
}): Promise<WorkspaceVisionModel> {
  let snapshot = input.snapshot;
  if (!snapshot) {
    try {
      snapshot = await input.providerSnapshotService.resolveRunSnapshot({
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
    } catch {
      throw workspaceModelError();
    }
  }
  if (
    snapshot.modality !== "text" ||
    !snapshot.capabilities.includes("text") ||
    `workspace:${snapshot.catalogKey}` !== input.modelRef
  ) {
    throw workspaceModelError();
  }
  try {
    const contextProfile = snapshot.contextProfile ?? resolveKnownContextModelProfile(snapshot.upstreamModelId, snapshot.baseUrl);
    return createWorkspaceVisionModel({
      apiKey: snapshot.apiKey,
      baseUrl: snapshot.baseUrl,
      upstreamModelId: snapshot.upstreamModelId,
      ...(contextProfile ? { contextProfile } : {}),
    });
  } catch {
    throw workspaceModelError();
  }
}

function workspaceModelError() {
  const error = new Error("The workspace text model snapshot is invalid or unavailable.");
  (error as Error & { code?: string }).code = "provider_snapshot_invalid";
  return error;
}
