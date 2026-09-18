import { describe, expect, it, vi } from "vitest";

import { createMainAgentTools } from "./index.js";

describe("main Agent image review wiring", () => {
  it("registers bounded pixel review and no longer registers the retired legacy image proposal tool", () => {
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
    // The two-round proposal tool is retired: Mastra owns direct submission
    // (`mastra-image-tool.ts` -> `mastra-image-jobs.ts`), and `mastra-toolkit.ts`
    // passes `availableImageModels: []`. No image-generation tool may reappear here.
    expect(tools.map(tool => tool.id)).not.toContain("generate_image");
  });

  it("keeps screenshot capture explicit but omits asset review without a vision model", () => {
    const tools = createMainAgentTools({
      createUserClient: vi.fn(), connectionManager: {} as never,
    });
    expect(tools.map(tool => tool.id)).toContain("screenshot_canvas");
    expect(tools.map(tool => tool.id)).not.toContain("review_image_results");
  });
});
