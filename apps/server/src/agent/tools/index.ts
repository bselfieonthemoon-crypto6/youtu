import type { StructuredTool } from "@langchain/core/tools";
import type { AnyBackendProtocol } from "deepagents";

import type { DestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../../generation/providers/registry.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { SyncBackendFactory } from "../backends/index.js";
import { createBrandKitTool } from "./brand-kit.js";
import {
  type DesignToolDependencies,
  createDesignTools,
} from "./design-tools.js";
import {
  type PersistImageFn,
  type SubmitImageJobFn,
  createImageGenerateTool,
} from "./image-generate.js";
import { createImageGenerationConfirmationTool } from "./image-generation-confirmation.js";
import { createInspectCanvasTool } from "./inspect-canvas.js";
import { createDesignDiscoveryTool } from "./design-discovery.js";
import { createManipulateCanvasTool } from "./manipulate-canvas.js";
import { createPersistSandboxFileTool } from "./persist-sandbox-file.js";
import { createProjectSearchTool } from "./project-search.js";
import { createScreenshotCanvasTool } from "./screenshot-canvas.js";
import {
  type SubmitVideoJobFn,
  createVideoGenerateTool,
} from "./video-generate.js";

export { createImageGenerateTool } from "./image-generate.js";
export { createVideoGenerateTool } from "./video-generate.js";
export { createInspectCanvasTool } from "./inspect-canvas.js";
export { createManipulateCanvasTool } from "./manipulate-canvas.js";

// ---------------------------------------------------------------------------
// deepagents 内置工具参考 (由 FilesystemMiddleware 自动注入)
// ---------------------------------------------------------------------------
//
// deepagents@1.8.4 通过 createFilesystemMiddleware 自动注入以下工具，
// 我们自定义的工具名称不能与这些冲突：
//
//   ls          — 列出目录内容
//   read_file   — 读取文件内容（支持 offset/limit）
//   write_file  — 写入文件
//   edit_file   — 编辑文件（find & replace）
//   glob        — 按模式匹配文件路径
//   grep        — 按正则搜索文件内容
//   execute     — 执行 shell 命令（仅 SandboxBackendProtocol 时可用）
//   task        — 分发子任务到 subagent
//   write_todos — 管理 TODO 列表
//
// 开发模式可使用 LocalShellBackend；生产 state 模式使用 StateBackend，
// 不向多租户 Agent 暴露主机 shell。
//
// CompositeBackend 路由互不干扰：
//   /workspace/  → StoreBackend (PostgresStore) — 文件持久化
//   /memories/   → StoreBackend (PostgresStore) — agent 记忆
//   /skills/     → FilesystemBackend            — 系统 skills
//   default      → StateBackend / dev shell     — 由运行模式决定
// ---------------------------------------------------------------------------

export function createMainAgentTools(
  backend: AnyBackendProtocol | SyncBackendFactory,
  deps: {
    createUserClient: (accessToken: string) => any;
    destructiveConfirmationService?: DestructiveConfirmationService;
    brandKitId?: string | null;
    connectionManager?: ConnectionManager;
    persistImage?: PersistImageFn;
    sandboxDir?: string;
    submitImageJob?: SubmitImageJobFn;
    submitVideoJob?: SubmitVideoJobFn;
    availableImageModels?: AvailableModel[];
    availableVideoModels?: AvailableVideoModel[];
    designTools?: DesignToolDependencies;
  },
) {
  const tools: StructuredTool[] = [
    createProjectSearchTool(backend),
    createInspectCanvasTool(deps),
    createManipulateCanvasTool({
      createUserClient: deps.createUserClient,
      ...(deps.destructiveConfirmationService
        ? {
            destructiveConfirmationService: deps.destructiveConfirmationService,
          }
        : {}),
    }),
  ];
  if (deps.designTools)
    tools.push(
      ...createDesignTools(deps.designTools),
      createDesignDiscoveryTool({
        ...deps.designTools,
        createUserClient: deps.createUserClient,
      }),
    );
  if (
    deps.availableImageModels === undefined ||
    deps.availableImageModels.length > 0
  ) {
    tools.push(
      createImageGenerateTool({
        ...(deps.designTools
          ? {
              validateDesignTarget: async (target, context) => {
                const design = await deps.designTools!.designService.get(
                  {
                    id: context.user_id,
                    accessToken: context.access_token,
                    email: "",
                    userMetadata: {},
                  },
                  target.design_id,
                );
                if (design.workspace_id !== context.workspace_id)
                  throw new Error("画板不属于当前工作区");
                const { data, error } = await deps
                  .createUserClient(context.access_token)
                  .from("design_nodes")
                  .select("design_id")
                  .eq("design_id", design.id)
                  .eq("canvas_id", context.canvas_id)
                  .eq("workspace_id", context.workspace_id)
                  .is("deleted_at", null)
                  .maybeSingle();
                if (error || !data)
                  throw new Error(
                    "画板不属于当前画布，请先调用 list_designs 确定目标",
                  );
                if (design.revision !== target.expected_revision)
                  throw new Error(
                    "画板版本已改变，请重新 inspect_design 后生成方案",
                  );
              },
            }
          : {}),
        ...(deps.destructiveConfirmationService
          ? { confirmationService: deps.destructiveConfirmationService }
          : {}),
        ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
        ...(deps.submitImageJob ? { submitImageJob: deps.submitImageJob } : {}),
        ...(deps.availableImageModels
          ? { availableModels: deps.availableImageModels }
          : {}),
      }),
    );
  }
  if (
    deps.availableVideoModels === undefined ||
    deps.availableVideoModels.length > 0
  ) {
    tools.push(
      createVideoGenerateTool({
        ...(deps.submitVideoJob ? { submitVideoJob: deps.submitVideoJob } : {}),
        ...(deps.availableVideoModels
          ? { availableModels: deps.availableVideoModels }
          : {}),
      }),
    );
  }
  // execute 工具由 deepagents FilesystemMiddleware 自动注入，
  // 因为 CompositeBackend 的 default backend 是 LocalShellBackend。
  // 不需要在这里手动注册。
  if (deps.destructiveConfirmationService) {
    tools.push(
      createImageGenerationConfirmationTool({
        confirmationService: deps.destructiveConfirmationService,
      }),
    );
  }
  // This tool reads a host path and is only safe when a real isolated/dev
  // sandbox directory is present. Never expose it with the production
  // StateBackend, where an arbitrary host path would otherwise be accepted.
  if (deps.sandboxDir) {
    tools.push(
      createPersistSandboxFileTool({
        createUserClient: deps.createUserClient,
        sandboxDir: deps.sandboxDir,
      }),
    );
  }
  if (deps.brandKitId) {
    tools.push(createBrandKitTool(deps, deps.brandKitId));
  }
  if (deps.connectionManager) {
    tools.push(
      createScreenshotCanvasTool({
        connectionManager: deps.connectionManager,
        ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
      }),
    );
  }
  return tools;
}

/** @deprecated Use createMainAgentTools + sub-agents instead */
export function createPhaseATools(
  backend: AnyBackendProtocol | SyncBackendFactory,
) {
  return [
    createProjectSearchTool(backend),
    createImageGenerateTool(),
    createVideoGenerateTool(),
  ] as const;
}
