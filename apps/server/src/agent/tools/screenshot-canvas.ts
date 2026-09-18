import { z } from "zod";

import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { PersistImageFn } from "../image-generation-contracts.js";
import type { ScreenshotResult } from "@loomic/shared";
import type { WorkspaceVisionModel } from "../workspace-vision-model.js";
import { createAgentTool, runContextOf, toolAbortSignalOf } from "./tool-run-context.js";
import {
  assertImageReviewActive,
  resolveCanvasScreenshotReviewImage,
  reviewImagePixels,
  runWithImageReviewDeadline,
} from "../image-result-verification.js";

const screenshotCanvasSchema = z.object({
  mode: z
    .enum(["full", "region", "viewport"])
    .describe("full: all elements; region: specific area; viewport: current user view"),
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive().max(100_000),
      height: z.number().positive().max(100_000),
    })
    .optional()
    .describe("Required when mode is 'region'. Defines the crop rectangle."),
  max_dimension: z
    .number().int().min(128).max(2048)
    .default(1024)
    .describe("Max width or height in pixels. 512=low, 1024=medium, 2048=high quality"),
}).superRefine((value, context) => {
  if (value.mode === "region" && !value.region)
    context.addIssue({ code: "custom", path: ["region"], message: "mode=region requires an explicit region rectangle." });
});

export function createScreenshotCanvasTool(deps: {
  connectionManager: ConnectionManager;
  persistImage?: PersistImageFn;
  rpcTimeout?: number;
  model?: WorkspaceVisionModel;
  currentUserPrompt?: string;
}) {
  const timeout = deps.rpcTimeout ?? 10_000;

  return createAgentTool({
    id: "screenshot_canvas",
    description:
      "Take a visual screenshot of the canvas to inspect layout, design quality, color harmony, and spatial relationships. Use this to visually verify your changes or understand the current canvas state. Supports full canvas, specific region, or current viewport capture.",
    inputSchema: screenshotCanvasSchema,
    execute: async (input, toolContext): Promise<string> => {
      const runContext = runContextOf(toolContext);
      const userId = runContext.user_id as string | undefined;
      const canvasId = runContext.canvas_id as string | undefined;

      if (typeof userId !== "string" || typeof canvasId !== "string") {
        return JSON.stringify({
          error: "no_user_context",
          message: "screenshot_canvas requires a user context to communicate with the browser.",
        });
      }

      try {
        return await runWithImageReviewDeadline(toolAbortSignalOf(toolContext), async reviewSignal => {
        const result = await deps.connectionManager.rpcToCanvas<ScreenshotResult>(
          canvasId,
          "canvas.screenshot",
          {
            mode: input.mode,
            ...(input.region ? { region: input.region } : {}),
            max_dimension: input.max_dimension,
          },
          timeout,
        );
        assertImageReviewActive(reviewSignal);

        const visual = deps.model
          ? await resolveCanvasScreenshotReviewImage(result.url).then(image => reviewImagePixels({
              images: [image], model: deps.model!, taskBrief: { currentUserPrompt: deps.currentUserPrompt ?? "" },
              mode: "canvas_verification", comparison: "individual", signal: reviewSignal,
            })).catch(() => ({
              status: "unavailable" as const, viewed: false, blockingIssues: [], suggestions: [], uncertainties: [],
              error: "canvas_pixel_review_unavailable", summary: "截图已捕获，但未能查看实际像素，不能声称视觉验收通过。",
            }))
          : {
              status: "unavailable" as const, viewed: false, blockingIssues: [], suggestions: [], uncertainties: [],
              error: "canvas_vision_model_unavailable", summary: "截图已捕获，但视觉模型不可用，不能声称已查看像素。",
            };
        assertImageReviewActive(reviewSignal);

        // Keep the existing short artifact URL, but never let a slow upload
        // delay the actual pixel review or start more work after the deadline.
        let screenshotUrl: string | undefined;
        if (deps.persistImage) {
          try {
            screenshotUrl = await deps.persistImage(
              result.url,
              "image/png",
              `canvas-screenshot-${input.mode}`,
            );
          } catch {
            // Non-fatal: the truthful pixel review remains available without an artifact URL.
          }
        }
        assertImageReviewActive(reviewSignal);
        const output: Record<string, unknown> = {
          summary: visual.summary,
          captureSummary: `Canvas screenshot captured (${result.width}x${result.height}, mode: ${input.mode})`,
          width: result.width,
          height: result.height,
          visualStatus: visual.status,
          viewed: visual.viewed,
          blockingIssues: visual.blockingIssues,
          suggestions: visual.suggestions,
          uncertainties: visual.uncertainties,
          ...(visual.error ? { visualError: visual.error } : {}),
        };

        if (screenshotUrl) {
          output.screenshotUrl = screenshotUrl;
        }

        return JSON.stringify(output);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Screenshot failed";
        return JSON.stringify({
          error: "screenshot_failed",
          visualStatus: "unavailable",
          viewed: false,
          message: `Screenshot failed: ${message}`,
        });
      }
    },
  });
}