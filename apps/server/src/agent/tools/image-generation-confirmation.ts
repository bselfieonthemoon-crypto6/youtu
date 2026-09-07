import { tool } from "langchain";
import { z } from "zod";
import {
  isExplicitImageConfirmationMessage,
  isExplicitImageCancellation,
} from "@loomic/shared";
import type { ImageProposalStore } from "../../features/agent-actions/image-proposal-store.js";
import {
  runImageGenerate,
  type ImageGenerateInput,
  type SubmitImageJobFn,
  type PersistImageFn,
} from "./image-generate.js";

import {
  DestructiveConfirmationError,
  type DestructiveConfirmationService,
} from "../../features/agent-actions/destructive-confirmation-service.js";

function isExplicitDecision(prompt: unknown, decision: "confirm" | "cancel") {
  return decision === "cancel"
    ? isExplicitImageCancellation(prompt)
    : isExplicitImageConfirmationMessage(prompt);
}

export function createImageGenerationConfirmationTool(deps: {
  confirmationService: DestructiveConfirmationService;
  proposalStore?: ImageProposalStore;
  submitImageJob?: SubmitImageJobFn;
  persistImage?: PersistImageFn;
  validateDesignTarget?: (
    target: NonNullable<ImageGenerateInput["target"]>,
    context: any,
  ) => Promise<void>;
}) {
  return tool(
    async (
      input: {
        confirmationId: string;
        decision: "confirm" | "cancel";
      },
      config,
    ) => {
      const configurable = (config as any)?.configurable;
      const userId = configurable?.user_id;
      const canvasId = configurable?.canvas_id;
      const runId = configurable?.run_id;
      const userPrompt = configurable?.user_prompt;
      if (typeof userId !== "string" || typeof canvasId !== "string") {
        return {
          summary: "无法确认这次图片生成，请重新描述要生成的图片。",
          error: "confirmation_unavailable",
        };
      }

      if (!isExplicitDecision(userPrompt, input.decision)) {
        return {
          summary:
            input.decision === "confirm"
              ? "尚未收到用户本轮的明确确认，请继续用中文询问是否确认生成。"
              : "尚未收到用户本轮的明确取消指令。",
          error: "explicit_confirmation_required",
        };
      }

      if (deps.proposalStore) {
        try {
          const proposal = await deps.proposalStore.decide(
            configurable,
            input.confirmationId,
            input.decision,
          );
          if (input.decision === "cancel")
            return {
              status: "canceled",
              summary: "已取消方案，没有提交生成。",
            };
          if (!deps.submitImageJob)
            return {
              error: "submission_unavailable",
              summary: "任务服务不可用，未生成，请稍后重试确认。",
            };
          const existing = await deps.proposalStore.job(
            configurable,
            proposal.id,
          );
          if (!existing && proposal.input.target) {
            if (!deps.validateDesignTarget)
              throw new Error("画板校验服务不可用");
            await deps.validateDesignTarget(
              proposal.input.target,
              configurable,
            );
          }
          return await runImageGenerate(
            { ...proposal.input, proposalId: proposal.id },
            deps.persistImage,
            deps.submitImageJob,
          );
        } catch (error) {
          return {
            error: "confirmation_unavailable",
            summary:
              error instanceof Error
                ? error.message
                : "无法确认方案，请重新创建方案。",
          };
        }
      }
      if (input.decision === "cancel") {
        deps.confirmationService.cancel({
          confirmationId: input.confirmationId,
          userId,
          canvasId,
          kind: "image_generation",
        });
        return {
          summary: "已取消，本次没有生成图片。",
          status: "canceled",
        };
      }

      try {
        return await deps.confirmationService.confirm({
          confirmationId: input.confirmationId,
          userId,
          canvasId,
          kind: "image_generation",
          ...(typeof runId === "string" ? { runId } : {}),
        });
      } catch (error) {
        if (
          error instanceof DestructiveConfirmationError &&
          (error.code === "confirmation_expired" ||
            error.code === "confirmation_not_found" ||
            error.code === "confirmation_consumed")
        ) {
          return {
            summary:
              "这份图片方案的确认已失效，请根据对话中最近的设计要求重新调用 generate_image 创建方案，并再次询问用户确认。",
            status: "confirmation_unavailable",
            error: error.code,
          };
        }
        if (
          error instanceof DestructiveConfirmationError &&
          error.code === "confirmation_requires_new_turn"
        ) {
          return {
            summary:
              "确认操作已交由产品确认界面处理，请勿在当前 Agent 轮次重复确认。",
            status: "awaiting_ui_confirmation",
          };
        }
        throw error;
      }
    },
    {
      name: "confirm_image_generation",
      description:
        "Confirm or cancel the latest frozen image proposal after the user explicitly replies in the conversation. Reuse the confirmationId returned by generate_image. Never call with decision=confirm unless the user's latest message clearly confirms generation.",
      schema: z.object({
        confirmationId: z
          .string()
          .uuid()
          .describe("The confirmationId returned by generate_image"),
        decision: z
          .enum(["confirm", "cancel"])
          .describe(
            "confirm only after explicit user approval; cancel when declined",
          ),
      }),
    },
  );
}
