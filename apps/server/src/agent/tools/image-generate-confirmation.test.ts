import { describe, expect, it, vi } from "vitest";

import { createDestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import {
  createImageGenerateTool,
  runImageGenerate,
} from "./image-generate.js";
import { createImageGenerationConfirmationTool } from "./image-generation-confirmation.js";

describe("generate_image confirmation boundary", () => {
  it("does not inject legacy canvas placement defaults into a native design target", async () => {
    const imageTool = createImageGenerateTool({
      confirmationService: createDestructiveConfirmationService(),
      submitImageJob: vi.fn(),
      availableModels: [
        {
          id: "workspace:10000000-0000-4000-8000-000000000001",
          displayName: "GPT Image 2",
          description: "Workspace image generation",
          provider: "apiyi",
        },
      ],
    });

    await expect(
      imageTool.invoke(
        {
          title: "Native design image",
          prompt: "A minimal blue icon",
          model: "workspace:10000000-0000-4000-8000-000000000001",
          target: {
            kind: "design",
            design_id: "20000000-0000-4000-8000-000000000001",
            expected_revision: 2,
            idempotency_key: "30000000-0000-4000-8000-000000000001",
            placement: { x: 10, y: 20, width: 180, height: 180 },
          },
        },
        {
          configurable: {
            user_id: "user-1",
            canvas_id: "canvas-1",
            run_id: "run-native-target",
            user_prompt: "在设计里生成一个图标",
          },
        },
      ),
    ).resolves.toMatchObject({ status: "awaiting_confirmation" });
  });

  it("fails closed when native design delivery has no async job port", async () => {
    await expect(
      runImageGenerate({
        title: "Design image",
        prompt: "A product photo",
        model: "gpt-image-2-all",
        target: {
          kind: "design",
          design_id: "10000000-0000-4000-8000-000000000001",
          expected_revision: 2,
          idempotency_key: "20000000-0000-4000-8000-000000000001",
          placement: { x: 10, y: 20, width: 400, height: 300 },
        },
      }),
    ).resolves.toMatchObject({ error: "design_target_delivery_unavailable" });
  });

  it("submits no provider job before the user confirms the detailed proposal", async () => {
    const confirmationService = createDestructiveConfirmationService();
    const submitImageJob = vi.fn(async () => ({
      jobId: "job-1",
      imageUrl: "https://example.com/image.png",
      width: 1024,
      height: 1024,
      mimeType: "image/png",
    }));
    const imageTool = createImageGenerateTool({
      confirmationService,
      submitImageJob,
      availableModels: [
        {
          id: "gpt-image-2-all",
          displayName: "GPT Image 2",
          description: "Image generation",
          provider: "apiyi",
        },
      ],
    });

    const prepared = (await imageTool.invoke(
      {
        title: "Lottery logo",
        prompt: "A detailed red and gold lottery logo with clean typography",
        model: "gpt-image-2-all",
        aspectRatio: "1:1",
        quality: "hd",
        outputFormat: "png",
      },
      {
        configurable: {
          user_id: "user-1",
          canvas_id: "canvas-1",
          run_id: "run-prepare",
          user_prompt: "请设计一个彩票 Logo",
        },
      },
    )) as unknown as {
      status: string;
      confirmation: { confirmationId: string; details: Record<string, unknown> };
    };

    expect(prepared.status).toBe("awaiting_confirmation");
    expect(prepared.confirmation.details).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("red and gold"),
        model: "gpt-image-2-all",
        aspectRatio: "1:1",
        quality: "hd",
      }),
    );
    expect(submitImageJob).not.toHaveBeenCalled();

    const confirmTool = createImageGenerationConfirmationTool({
      confirmationService,
    });
    await expect(
      confirmTool.invoke(
        {
          confirmationId: prepared.confirmation.confirmationId,
          decision: "confirm",
        },
        {
          configurable: {
            user_id: "user-1",
            canvas_id: "canvas-1",
            run_id: "run-prepare",
            user_prompt: "确认生成",
          },
        },
      ),
    ).resolves.toMatchObject({ status: "awaiting_ui_confirmation" });
    expect(submitImageJob).not.toHaveBeenCalled();

    const result = (await confirmTool.invoke(
      {
        confirmationId: prepared.confirmation.confirmationId,
        decision: "confirm",
      },
      {
        configurable: {
          user_id: "user-1",
          canvas_id: "canvas-1",
          run_id: "run-confirm",
          user_prompt: "确认，就按这个生成",
        },
      },
    )) as unknown as { imageUrl?: string };

    expect(submitImageJob).toHaveBeenCalledTimes(1);
    expect(result.imageUrl).toBe("https://example.com/image.png");
  });

  it("returns a recoverable result when the confirmation has expired", async () => {
    let now = 1_000;
    const confirmationService = createDestructiveConfirmationService({
      ttlMs: 50,
      now: () => now,
    });
    const imageTool = createImageGenerateTool({
      confirmationService,
      submitImageJob: vi.fn(),
      availableModels: [
        {
          id: "gpt-image-2-all",
          displayName: "GPT Image 2",
          description: "Image generation",
          provider: "apiyi",
        },
      ],
    });
    const prepared = (await imageTool.invoke(
      {
        title: "Expired proposal",
        prompt: "A detailed logo proposal that has expired",
        model: "gpt-image-2-all",
      },
      {
        configurable: {
          user_id: "user-1",
          canvas_id: "canvas-1",
          run_id: "run-prepare",
          user_prompt: "请设计 Logo",
        },
      },
    )) as unknown as { confirmation: { confirmationId: string } };
    now += 51;

    const confirmTool = createImageGenerationConfirmationTool({
      confirmationService,
    });
    const result = (await confirmTool.invoke(
      {
        confirmationId: prepared.confirmation.confirmationId,
        decision: "confirm",
      },
      {
        configurable: {
          user_id: "user-1",
          canvas_id: "canvas-1",
          run_id: "run-confirm",
          user_prompt: "确认，请按上述方案继续执行并生成预览",
        },
      },
    )) as unknown as { status: string; error: string };

    expect(result).toEqual(
      expect.objectContaining({
        status: "confirmation_unavailable",
        error: "confirmation_expired",
      }),
    );
  });
});
