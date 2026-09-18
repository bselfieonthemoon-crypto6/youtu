import type { MastraAgentTool } from "./tool-run-context.js";

import type { DestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../../generation/providers/registry.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { PromptLibraryService } from "../../features/prompt-library/prompt-library-service.js";
import type { WorkspaceVisionModel } from "../workspace-vision-model.js";
import { createBrandKitTool } from "./brand-kit.js";
import {
  type DesignToolDependencies,
  createDesignTools,
} from "./design-tools.js";
import {
  type PersistImageFn,
  type ImageGenerateInput,
  type SubmitImageJobFn,
} from "../image-generation-contracts.js";
import { supportedImageAspectRatioForDimensions } from "../image-ratio-intent.js";
import { createDesignImageTargetValidator } from "./design-image-target.js";
import { createInspectCanvasTool } from "./inspect-canvas.js";
import { createDesignDiscoveryTool } from "./design-discovery.js";
import { createManipulateCanvasTool } from "./manipulate-canvas.js";
import { createScreenshotCanvasTool } from "./screenshot-canvas.js";
import { createReviewImageResultsTool } from "./review-image-results.js";
import {
  type SubmitVideoJobFn,
  createVideoGenerateTool,
} from "./video-generate.js";

export { createVideoGenerateTool } from "./video-generate.js";
export { createInspectCanvasTool } from "./inspect-canvas.js";
export { createManipulateCanvasTool } from "./manipulate-canvas.js";

export function createDesignImageAspectRatioResolver(deps: {
  designTools?: DesignToolDependencies;
}) {
  if (!deps.designTools) return undefined;
  return async (
    target: NonNullable<ImageGenerateInput["target"]>,
    context: Record<string, any>,
  ) => {
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
    if (design.revision !== target.expected_revision)
      throw new Error("画板版本已改变，请重新 inspect_design 后生成方案并确认。");
    return supportedImageAspectRatioForDimensions(design.width, design.height);
  };
}

// ---------------------------------------------------------------------------
// 工具命名空间说明
// ---------------------------------------------------------------------------
//
// 历史上 DeepAgents 的 FilesystemMiddleware 会注入 ls / read_file / write_file /
// edit_file / glob / grep / execute / task / write_todos。该中间件已随 legacy
// runtime 一起退役，Backends 与虚拟文件系统（/workspace、/memories、/skills）
// 也已删除。
//
// 当前运行时（Mastra）只保留两个自建的文件读取入口：
//   read_file  — 由 mastra-toolkit.ts 提供，只能读本轮已启用 Skill 的快照切片
//   （技能目录由 list_skills / use_skill / compose_skills 承载）
//
// 自定义工具名不得与上述保留名冲突。
// ---------------------------------------------------------------------------

export function createMainAgentTools(
  deps: {
    createUserClient: (accessToken: string) => any;
    destructiveConfirmationService?: DestructiveConfirmationService;
    brandKitId?: string | null;
    connectionManager?: ConnectionManager;
    persistImage?: PersistImageFn;
    submitImageJob?: SubmitImageJobFn;
    submitVideoJob?: SubmitVideoJobFn;
    availableImageModels?: AvailableModel[];
    availableVideoModels?: AvailableVideoModel[];
    designTools?: DesignToolDependencies;
    visionModel?: WorkspaceVisionModel;
    currentUserPrompt?: string;
    promptLibraryService?: PromptLibraryService;
    resultReviewScope?: { jobId: string; assetIds: string[] };
    prepareImagePipeline?: (input: ImageGenerateInput, configurable: Record<string, unknown>) => Promise<ImageGenerateInput>;
  },
) {
  // TODO(refactor): `validateDesignTarget`, `resolveDesignAspectRatio` and the
  // `prepareImagePipeline` dependency were only ever consumed by the retired
  // legacy proposal tool (`generate_image`). They are deliberately left in place
  // here because they are part of this module's exported dependency contract and
  // their own unit tests still exercise them; removing them is a separate,
  // purely-internal cleanup that must not be mixed into this extraction.
  const validateDesignTarget = createDesignImageTargetValidator(deps);
  const resolveDesignAspectRatio = createDesignImageAspectRatioResolver(deps);
  const tools: MastraAgentTool[] = [
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
  // `generate_image` is no longer registered here. The legacy two-round
  // proposal/confirmation tool that used to live behind this gate was retired
  // with the Mastra direct-submission path (`mastra-image-tool.ts` ->
  // `mastra-image-jobs.ts`), and `mastra-toolkit.ts` already passes
  // `availableImageModels: []`. The image-generation contracts and the pure
  // ratio/model helpers it shared now live in `../image-generation-contracts.ts`,
  // `../image-ratio-intent.ts` and `../image-model-resolution.ts`.
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
  // `persist_sandbox_file` was retired with the DeepAgents sandbox backend: it
  // read a host path and had no consumer once the Mastra runtime took over.
  if (deps.brandKitId) {
    tools.push(createBrandKitTool(deps, deps.brandKitId));
  }
  if (deps.connectionManager) {
    tools.push(
      createScreenshotCanvasTool({
        connectionManager: deps.connectionManager,
        ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
        ...(deps.visionModel ? { model: deps.visionModel } : {}),
        ...(deps.currentUserPrompt !== undefined ? { currentUserPrompt: deps.currentUserPrompt } : {}),
      }),
    );
  }
  if (deps.visionModel) {
    tools.push(createReviewImageResultsTool({
      ...(deps.resultReviewScope ? { resultReviewScope: deps.resultReviewScope } : {}),
      createUserClient: deps.createUserClient,
      model: deps.visionModel,
      ...(deps.currentUserPrompt !== undefined ? { currentUserPrompt: deps.currentUserPrompt } : {}),
      ...(deps.promptLibraryService ? { promptLibraryService: deps.promptLibraryService } : {}),
    }));
  }
  return tools;
}
