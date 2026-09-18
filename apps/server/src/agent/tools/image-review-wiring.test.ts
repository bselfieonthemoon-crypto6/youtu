import { describe, expect, it, vi } from "vitest";

import { createMainAgentTools } from "./index.js";

describe("main Agent image review wiring", () => {
  it("registers bounded pixel review and wires foreground preparation into image proposals", () => {
    const prepareImagePipeline = vi.fn();
    const tools = createMainAgentTools({
      createUserClient: vi.fn(),
      visionModel: { invoke: vi.fn() } as never,
      promptLibraryService: { getById: vi.fn() } as never,
      currentUserPrompt: "当前任务",
      prepareImagePipeline,
    });
    expect(tools.map(tool => tool.id)).toContain("review_image_results");
    expect(tools.find(tool => tool.id === "review_image_results")?.description).toContain("never generates, retries");
    expect(tools.find(tool => tool.id === "generate_image")).toBeDefined();
  });

  it("keeps screenshot capture explicit but omits asset review without a vision model", () => {
    const tools = createMainAgentTools({
      createUserClient: vi.fn(), connectionManager: {} as never,
    });
    expect(tools.map(tool => tool.id)).toContain("screenshot_canvas");
    expect(tools.map(tool => tool.id)).not.toContain("review_image_results");
  });
});
