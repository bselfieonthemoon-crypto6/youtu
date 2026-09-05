import type { ProviderSnapshotService } from "../features/providers/index.js";
import { OpenAICompatibleChatModel } from "./openai-compatible-chat-model.js";

export async function resolveWorkspaceChatModel(input: {
  modelRef: string;
  providerSnapshotService: ProviderSnapshotService;
  runId: string;
  workspaceId: string;
}) {
  let snapshot;
  try {
    snapshot = await input.providerSnapshotService.resolveRunSnapshot({
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
  } catch {
    throw workspaceModelError();
  }
  if (
    snapshot.modality !== "text" ||
    !snapshot.capabilities.includes("text") ||
    `workspace:${snapshot.catalogKey}` !== input.modelRef
  ) {
    throw workspaceModelError();
  }
  return new OpenAICompatibleChatModel({
    model: snapshot.upstreamModelId,
    apiKey: snapshot.apiKey,
    configuration: { baseURL: snapshot.baseUrl },
    streaming: true,
    streamUsage: false,
  });
}

function workspaceModelError() {
  const error = new Error("The workspace text model snapshot is invalid or unavailable.");
  (error as Error & { code?: string }).code = "provider_snapshot_invalid";
  return error;
}
