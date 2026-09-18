import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { createScreenshotCanvasTool } from "./screenshot-canvas.js";
import { toolExecutionContext } from "./tool-run-context.js";

async function dataUri() {
  const bytes = await sharp({ create: { width: 40, height: 20, channels: 4, background: "#3b82f6" } }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

describe("screenshot_canvas pixel truthfulness", () => {
  it("passes captured pixels to vision before reporting a visual pass", async () => {
    const rpcToCanvas = vi.fn(async () => ({ url: await dataUri(), width: 40, height: 20 }));
    const generate = vi.fn(async (_input: unknown) => ({
      text: '{"blockingIssues":[],"suggestions":[],"uncertainties":[]}', usage: {},
    }));
    const tool = createScreenshotCanvasTool({ connectionManager: { rpcToCanvas } as never, model: { generate } as never, currentUserPrompt: "检查标题裁切" });
    const output = JSON.parse(await tool.execute({ mode: "full", max_dimension: 1024 }, toolExecutionContext({
      configurable: { user_id: "user", canvas_id: "canvas" },
    })));
    expect(output).toMatchObject({ visualStatus: "passed", viewed: true, width: 40, height: 20 });
    expect(generate).toHaveBeenCalledOnce();
    const image = (generate.mock.calls[0]![0] as { images: { dataUri: string }[] }).images[0];
    expect(image!.dataUri).toMatch(/^data:image\/webp;base64,/);
  });

  it("marks a captured screenshot unavailable when no vision model is wired", async () => {
    const tool = createScreenshotCanvasTool({ connectionManager: { rpcToCanvas: async () => ({ url: await dataUri(), width: 40, height: 20 }) } as never });
    const output = JSON.parse(await tool.execute({ mode: "viewport", max_dimension: 512 }, toolExecutionContext({
      configurable: { user_id: "user", canvas_id: "canvas" },
    })));
    expect(output).toMatchObject({ visualStatus: "unavailable", viewed: false, visualError: "canvas_vision_model_unavailable" });
    expect(output.summary).toContain("不能声称已查看像素");
  });

  it("caps the whole screenshot request and does not start vision after a late RPC", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const generate = vi.fn();
      const tool = createScreenshotCanvasTool({
        connectionManager: { rpcToCanvas: () => new Promise(resolve => { release = resolve; }) } as never,
        model: { generate } as never, rpcTimeout: 60_000,
      });
      const pending = tool.execute({ mode: "full", max_dimension: 1024 }, toolExecutionContext({
        configurable: { user_id: "user", canvas_id: "canvas" },
      }));
      await vi.advanceTimersByTimeAsync(20_000);
      const parsed = JSON.parse(await pending);
      expect(parsed).toMatchObject({ visualStatus: "unavailable", viewed: false });
      expect(parsed.message).toContain("image_review_timeout");
      release({ url: await dataUri(), width: 40, height: 20 });
      await vi.runAllTimersAsync();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
