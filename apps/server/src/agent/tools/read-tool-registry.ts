import {
  type DesignToolDependencies,
  createDesignTools,
} from "./design-tools.js";
import { createInspectCanvasTool } from "./inspect-canvas.js";
import { toolExecutionContext, type MastraAgentTool } from "./tool-run-context.js";

export type RetryableReadToolExecutor = (input: {
  accessToken: string;
  canvasId: string;
  input: Record<string, unknown>;
  threadId: string;
  toolName: string;
  userId: string;
  /** Design reads are workspace-scoped; retry must reuse the run's workspace. */
  workspaceId: string;
}) => Promise<Record<string, unknown>>;

export function createRetryableReadToolExecutor(deps: {
  createUserClient: (accessToken: string) => unknown;
  designTools?: DesignToolDependencies;
}): RetryableReadToolExecutor {
  const inspectCanvas = createInspectCanvasTool({
    createUserClient: deps.createUserClient,
  });
  const designReads = new Map<string, MastraAgentTool>();
  for (const candidate of deps.designTools
    ? createDesignTools(deps.designTools)
    : []) {
    if (
      [
        "inspect_design",
        "get_design_objects",
        "search_design_resources",
      ].includes(candidate.id)
    ) {
      designReads.set(candidate.id, candidate as MastraAgentTool);
    }
  }

  return async (request) => {
    const selected: MastraAgentTool | undefined =
      request.toolName === "inspect_canvas"
        ? inspectCanvas
        : designReads.get(request.toolName);
    if (!selected) {
      throw new Error("Tool is not approved for read-only retry.");
    }
    const result = await selected.execute!(request.input, toolExecutionContext({
      configurable: {
        access_token: request.accessToken,
        canvas_id: request.canvasId,
        thread_id: request.threadId,
        user_id: request.userId,
        workspace_id: request.workspaceId,
      },
    }));
    return normalizeToolOutput(result);
  };
}

function normalizeToolOutput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve non-JSON tool output without widening the retry protocol.
    }
    return { result: value };
  }
  return { result: value ?? null };
}
