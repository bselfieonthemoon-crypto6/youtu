import { describe, expect, it, vi } from "vitest";

import { createImageGenerateTool, normalizeImageGenerationAspectRatioProposal, runImageGenerate } from "./image-generate.js";
import { toolExecutionContext } from "./tool-run-context.js";

const model = "gpt-image-2";
const sourceId = "10000000-0000-4000-8000-000000000003";
const source = "data:image/png;base64,eA==";
const base = { title: "Header", prompt: "Blue campaign header", model };

describe("native image ratio preflight", () => {
  it.each([
    { operation: "generate" as const, inputImages: undefined, sourceUsage: undefined },
    { operation: "generate" as const, inputImages: [source], sourceUsage: "edit" as const },
  ])("rejects 656:176 for $sourceUsage before a job exists", async ({ operation, inputImages, sourceUsage }) => {
    const submit = vi.fn();
    const result = await runImageGenerate({
      ...base, operation, aspectRatio: "656:176", resolution: "1k",
      ...(inputImages ? { inputImages } : {}),
      ...(sourceUsage ? { sourceUsage, aspectRatioIntent: "resize" as const } : {}),
    }, undefined, submit);

    expect(result).toMatchObject({ error: "image_native_aspect_ratio_unsupported" });
    expect(result.summary).toContain("656:176");
    expect(result.summary).toContain("未创建或提交付费任务");
    expect(result).not.toHaveProperty("status", "succeeded");
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts a representable custom ratio without changing the requested frame", async () => {
    const submit = vi.fn(async () => ({ jobId: "job", status: "processing" as const }));
    const result = await runImageGenerate({ ...base, aspectRatio: "1200:628" }, undefined, submit);
    expect(result).toMatchObject({ status: "processing" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: "1200:628",
    }));
  });

  it("rejects an extreme generate request before saving a proposal", async () => {
    const propose = vi.fn();
    const tool = createImageGenerateTool({
      availableModels: [],
      proposalStore: { propose } as never,
    });
    const result = await tool.execute({ ...base, aspectRatio: "656:176" }, toolExecutionContext({
      configurable: { user_prompt: "制作一张 656:176 横幅", run_id: "run", user_id: "user", canvas_id: "canvas" },
    }));
    expect(result).toMatchObject({ error: "image_native_aspect_ratio_unsupported" });
    expect(propose).not.toHaveBeenCalled();
  });

  it("rejects an extreme edit resize before saving a proposal", async () => {
    const propose = vi.fn();
    const tool = createImageGenerateTool({
      availableModels: [],
      proposalStore: { propose } as never,
    });
    const result = await tool.execute({
      ...base, aspectRatio: "656:176", inputImages: [sourceId],
      sourceUsage: "edit", aspectRatioIntent: "resize",
    }, toolExecutionContext({
      configurable: {
        user_prompt: "把附件改为 656:176", run_id: "run", user_id: "user", canvas_id: "canvas",
        user_attachment_map: { [sourceId]: source },
        image_edit_routing: { assetId: sourceId, aspectRatio: "4:3", placement: {} },
      },
    }));
    expect(result).toMatchObject({ error: "image_native_aspect_ratio_unsupported" });
    expect(propose).not.toHaveBeenCalled();
  });

  it("keeps the numeric user ratio unless a loaded Skill and current approximation agree on the nearest legal boundary", () => {
    const args = { ...base, aspectRatio: "3:1", aspectRatioIntent: "approximate" };
    expect(normalizeImageGenerationAspectRatioProposal(args, "auto", "做 656:176，尺寸差不多就好")).toMatchObject({
      ok: true, args: { aspectRatio: "656:176" },
    });
    expect(normalizeImageGenerationAspectRatioProposal(args, "auto", "做 656:176，尺寸差不多就好",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "3:1" } });
    expect(normalizeImageGenerationAspectRatioProposal({ ...args, aspectRatio: "2:1" }, "auto", "做 656:176，尺寸差不多就好",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "656:176" } });
    expect(normalizeImageGenerationAspectRatioProposal(args, "auto", "做 656:176，必须精确",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "656:176" } });
    expect(normalizeImageGenerationAspectRatioProposal(args, "16:9", "做 656:176，尺寸差不多就好",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "16:9" } });
  });
});
