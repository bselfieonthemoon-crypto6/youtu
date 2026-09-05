import {
  type DesignToolDependencies,
  createDesignTools,
} from "./design-tools.js";
import { createInspectCanvasTool } from "./inspect-canvas.js";

export type RetryableReadToolExecutor = (input: {
  accessToken: string;
  canvasId: string;
  input: Record<string, unknown>;
  threadId: string;
  toolName: string;
  userId: string;
}) => Promise<Record<string, unknown>>;

export function createRetryableReadToolExecutor(deps: {
  createUserClient: (accessToken: string) => unknown;
  designTools?: DesignToolDependencies;
}): RetryableReadToolExecutor {
  const inspectCanvas = createInspectCanvasTool({
    createUserClient: deps.createUserClient,
  });
  const designReads = new Map<
    string,
    { invoke(input: Record<string, unknown>, config: unknown): Promise<unknown> }
  >();
  for (const candidate of deps.designTools
    ? createDesignTools(deps.designTools)
    : []) {
    if (
      [
        "inspect_design",
        "get_design_objects",
        "search_design_resources",
      ].includes(candidate.name)
    ) {
      designReads.set(candidate.name, candidate as never);
    }
  }

  return async (request) => {
    const selected =
      request.toolName === "inspect_canvas"
        ? inspectCanvas
        : designReads.get(request.toolName);
    if (!selected) {
      throw new Error("Tool is not approved for read-only retry.");
    }
    const result = await selected.invoke(request.input, {
      configurable: {
        access_token: request.accessToken,
        canvas_id: request.canvasId,
        thread_id: request.threadId,
        user_id: request.userId,
      },
    });
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
