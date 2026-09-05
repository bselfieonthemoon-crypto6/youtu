import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import type { AgentExecutionMode } from "@loomic/shared";
import { createDeepAgent } from "deepagents";

import { DEFAULT_APIYI_AGENT_MODEL, type ServerEnv } from "../config/env.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../generation/providers/registry.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import {
  type AgentBackendResult,
  createAgentBackend,
} from "./backends/index.js";
import { OpenAICompatibleChatModel } from "./openai-compatible-chat-model.js";
import {
  LOOMIC_FAST_MODE_PROMPT,
  LOOMIC_SYSTEM_PROMPT,
  LOOMIC_THINKING_MODE_PROMPT,
} from "./prompts/loomic-main.js";
import { createVideoSubAgent } from "./sub-agents.js";
import type { DesignToolDependencies } from "./tools/design-tools.js";
import type {
  PersistImageFn,
  SubmitImageJobFn,
} from "./tools/image-generate.js";
import { createMainAgentTools } from "./tools/index.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type { WorkspaceSkillEntry } from "./workspace-skills.js";

export type LoomicAgent = Pick<
  ReturnType<typeof createDeepAgent>,
  "stream" | "streamEvents"
>;

export type LoomicAgentFactory = (options: {
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  destructiveConfirmationService?: DestructiveConfirmationService;
  designTools?: DesignToolDependencies;
  executionMode?: AgentExecutionMode;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  workspaceSkills?: WorkspaceSkillEntry[];
  availableImageModels?: AvailableModel[];
  availableVideoModels?: AvailableVideoModel[];
}) => LoomicAgent;

export function createLoomicDeepAgent(options: {
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  destructiveConfirmationService?: DestructiveConfirmationService;
  designTools?: DesignToolDependencies;
  executionMode?: AgentExecutionMode;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  workspaceSkills?: WorkspaceSkillEntry[];
  availableImageModels?: AvailableModel[];
  availableVideoModels?: AvailableVideoModel[];
}): LoomicAgent {
  const backendResult =
    options.backendResult ?? createAgentBackend(options.env, options.canvasId);

  const executionMode = options.executionMode ?? "thinking";
  const modelSpec = options.model ?? createDefaultModelSpecifier(options.env);
  const resolvedModel =
    typeof modelSpec === "string"
      ? createStreamingChatModel(modelSpec, executionMode)
      : modelSpec;

  const createUserClient =
    options.createUserClient ??
    ((_accessToken: string): never => {
      throw new Error(
        "inspect_canvas is unavailable: no createUserClient was provided to createLoomicDeepAgent.",
      );
    });

  let systemPrompt = options.brandKitId
    ? LOOMIC_SYSTEM_PROMPT +
      "\n\n当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。"
    : LOOMIC_SYSTEM_PROMPT;

  systemPrompt += `\n\n${
    executionMode === "thinking"
      ? LOOMIC_THINKING_MODE_PROMPT
      : LOOMIC_FAST_MODE_PROMPT
  }`;

  // Inject enabled skills (both system and user-created) into the system prompt.
  // All skills are loaded from the database via loadWorkspaceSkills() in runtime.ts.
  const wsSkills = options.workspaceSkills ?? [];
  if (wsSkills.length > 0) {
    const skillsList = wsSkills
      .map((s) => {
        let line = `- **${s.name}**: ${s.description}\n  → Read \`${s.path}\` for full instructions`;
        if (s.files.length > 0) {
          const counts: Record<string, number> = {};
          for (const f of s.files) {
            const dir = f.path.split("/")[0] ?? "other";
            counts[dir] = (counts[dir] ?? 0) + 1;
          }
          const summary = Object.entries(counts)
            .map(([dir, n]) => `${dir}/ (${n})`)
            .join(", ");
          line += `\n  → Has: ${summary}`;
        }
        return line;
      })
      .join("\n");
    systemPrompt += `\n\n## Skills\n\nThe following skills are enabled in this workspace:\n${skillsList}`;
  }

  return createDeepAgent({
    backend: backendResult.factory,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    model: resolvedModel,
    name: "loomic",
    ...(options.store ? { store: options.store } : {}),
    subagents: options.submitVideoJob
      ? [createVideoSubAgent(options.submitVideoJob)]
      : [],
    systemPrompt,
    tools: createMainAgentTools(backendResult.factory, {
      createUserClient,
      ...(options.destructiveConfirmationService
        ? {
            destructiveConfirmationService:
              options.destructiveConfirmationService,
          }
        : {}),
      ...(options.designTools ? { designTools: options.designTools } : {}),
      ...(options.brandKitId != null ? { brandKitId: options.brandKitId } : {}),
      ...(options.connectionManager
        ? { connectionManager: options.connectionManager }
        : {}),
      ...(options.persistImage ? { persistImage: options.persistImage } : {}),
      ...(backendResult.sandboxDir
        ? { sandboxDir: backendResult.sandboxDir }
        : {}),

      ...(options.submitImageJob
        ? { submitImageJob: options.submitImageJob }
        : {}),
      ...(options.submitVideoJob
        ? { submitVideoJob: options.submitVideoJob }
        : {}),
      ...(options.availableImageModels
        ? { availableImageModels: options.availableImageModels }
        : {}),
      ...(options.availableVideoModels
        ? { availableVideoModels: options.availableVideoModels }
        : {}),
    }),
  });
}

/**
 * Create a streaming chat model from a `<provider>:<model-id>` specifier.
 *
 * All environment-backed text models use APIYI's OpenAI-compatible endpoint.
 * Workspace provider models are resolved separately from immutable snapshots.
 */
export function createStreamingChatModel(
  specifier: string,
  _executionMode: AgentExecutionMode,
): BaseLanguageModel {
  const colonIdx = specifier.indexOf(":");
  let provider = colonIdx > 0 ? specifier.slice(0, colonIdx) : "apiyi";
  let modelName = colonIdx > 0 ? specifier.slice(colonIdx + 1) : specifier;
  const hasApiYi = !!process.env.APIYI_API_KEY;

  if (!hasApiYi) {
    throw new Error(
      "APIYI_API_KEY is required for environment-backed text models.",
    );
  }
  if (provider !== "apiyi") {
    console.warn(
      `[model] Replacing legacy provider ${provider} with APIYI for: ${specifier}`,
    );
    provider = "apiyi";
    modelName = DEFAULT_APIYI_AGENT_MODEL;
  }

  return new OpenAICompatibleChatModel({
    model: modelName,
    apiKey: process.env.APIYI_API_KEY,
    configuration: {
      baseURL: process.env.APIYI_API_BASE ?? "https://api.apiyi.com/v1",
    },
    streaming: true,
    streamUsage: false,
  });
}

export function getGoogleThinkingConfig(
  executionMode: AgentExecutionMode,
  modelName: string,
): { includeThoughts: boolean; thinkingBudget?: number } {
  const includeThoughts = executionMode === "thinking";

  // Gemini 2.5 Flash and Flash-Lite explicitly support 0 (disabled) and -1
  // (dynamic). Gemini 2.5 Pro cannot disable thinking, while Gemini 3 uses
  // thinkingLevel semantics. For those and unknown future models, leave the
  // native thinking policy untouched and rely on the execution-mode prompt.
  if (/^gemini-2\.5-flash(?:-lite)?(?:$|-)/.test(modelName)) {
    return {
      includeThoughts,
      thinkingBudget: includeThoughts ? -1 : 0,
    };
  }

  return { includeThoughts };
}

export function createDefaultModelSpecifier(
  env: Pick<ServerEnv, "agentModel">,
) {
  const model = env.agentModel;
  // Already has an explicit provider prefix — pass through as-is.
  if (model.includes(":")) return model;
  return `apiyi:${model}`;
}
