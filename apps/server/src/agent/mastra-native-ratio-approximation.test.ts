import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { createMastraImageEditTool, createMastraImageTool } from "./mastra-image-tool.js";
import { toolExecutionContext } from "./tools/tool-run-context.js";

const assetId = "10000000-0000-4000-8000-000000000003";
const native = { id: "workspace:native", provider: "test", upstreamModelId: "gpt-image-2",
  displayName: "Native", description: "" };
const signal = new AbortController().signal;
const configurable = {
  user_id: "user", access_token: "token", workspace_id: "workspace", session_id: "session",
  canvas_id: "canvas", run_id: "run", image_generation_aspect_ratio: "auto",
  user_prompt: "做一张 656:176 的图，尺寸差不多就好",
};

function fixture(selected = native, groundSources?: Parameters<typeof createMastraImageTool>[0]["groundSources"]) {
  const submit = vi.fn(async () => ({ jobId: "job", status: "processing" as const,
    creditsCost: 0, pricingVersion: "credits-v1", actualQuality: "Low" as const, actualResolution: "1K" as const }));
  const deps = { createUserClient: vi.fn(), submitter: { submit }, availableImageModels: [selected],
    ...(groundSources ? { groundSources } : {}) };
  return { generate: createMastraImageTool(deps), edit: createMastraImageEditTool(deps), submit };
}

describe("Mastra native ratio approximation", () => {
  it("rejects raw 656:176 in the actual direct generate route before paid submit", async () => {
    const f = fixture({ ...native, upstreamModelId: "gpt-image-2.5-flare" });
    const result = await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "656:176" }, toolExecutionContext({ signal, configurable }));
    expect(result).toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
    expect(result.summary).toContain("use_skill");
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("requires the loaded-skill marker before replacing the current numeric ratio", async () => {
    const f = fixture();
    const args = { title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "3:1", aspectRatioIntent: "approximate" as const };
    const result = await f.generate.execute(args, toolExecutionContext({ signal, configurable }));
    expect(result).toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["edit", "reference"] as const)("retains verified approximate intent after implicit %s grounding", async (usage) => {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const groundSources = vi.fn(async () => ({ decision: "bind" as const, usage,
      sourceAssetIds: [assetId], inputImages: [source], authorizationGranted: false as const }));
    const f = fixture(native, groundSources);
    const args = { title: "Header", prompt: "use previous subject", aspectRatio: "3:1",
      aspectRatioIntent: "approximate" as const };
    await expect(f.generate.execute(args, toolExecutionContext({ signal,
      configurable: { ...configurable, nonstandard_size_skill_loaded_run_id: "previous-run" } })))
      .resolves.toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
    expect(f.submit).not.toHaveBeenCalled();
    await expect(f.generate.execute(args, toolExecutionContext({ signal,
      configurable: { ...configurable, nonstandard_size_skill_loaded_run_id: "run" } })))
      .resolves.toMatchObject({ status: "processing", actualQuality: "Low", actualResolution: "1K",
        approximateSizePlan: { aspectRatio: "3:1", substituted: true } });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      aspectRatio: "3:1", inputImages: [source], quality: "standard", resolution: "1k",
    }));
    // The missing-marker attempt is rejected before grounding runs.
    expect(groundSources).toHaveBeenCalledTimes(1);
  });

  it("submits the nearest legal ratio with Low/1K and discloses the doubled planning reference", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "3:1", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(result).toMatchObject({ status: "processing", actualQuality: "Low", actualResolution: "1K",
      approximateSizePlan: { target: { width: 656, height: 176 }, scaleFactor: 4,
        scaledTarget: { width: 2624, height: 704 }, aspectRatio: "3:1", substituted: true } });
    expect(result.summary).toContain("计划比例偏差约");
    expect(result.summary).toContain("实际输出尺寸仍须按任务结果核对");
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      aspectRatio: "3:1", quality: "standard", resolution: "1k",
    }));
  });

  it("does not let a loaded marker replace an exact request or authorize an arbitrary ratio", async () => {
    for (const [prompt, aspectRatio] of [["做一张 656:176 的图，必须精确", "3:1"],
      [configurable.user_prompt, "2:1"]] as const) {
      const f = fixture();
      const result = await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
        aspectRatio, aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
        configurable: { ...configurable, user_prompt: prompt, nonstandard_size_skill_loaded_run_id: "run" } }));
      expect(result).toMatchObject({ status: "failed", error: prompt.includes("精确")
        ? "image_approximation_not_authorized" : "image_native_approximate_ratio_plan_required" });
      expect(f.submit).not.toHaveBeenCalled();
    }
  });

  it.each(["尺寸不用精确，比例尽量接近就行，用 3:1 可以",
    "尺寸不需要精确，比例尽量接近就行",
    "不用精确尺寸，尽量接近就行"])("accepts a negated exact request with near-ratio wording: %s", async (prompt) => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "3:1", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: prompt, nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(result).toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(),
      expect.objectContaining({ aspectRatio: "3:1", quality: "standard", resolution: "1k" }));
  });

  it("reuses a remembered series size on a continuation without restating it", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Banner", prompt: "another one", model: native.id,
      aspectRatio: "358:176", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: "换个元素和主体", nonstandard_size_skill_loaded_run_id: "run",
        session_series_sizes: ["358:176"] } }));
    expect(result).toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: "358:176" }));
  });

  it("still requires the nonstandard Skill for a remembered series size", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Banner", prompt: "another one", model: native.id,
      aspectRatio: "358:176", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: "换个元素和主体", session_series_sizes: ["358:176"] } }));
    expect(result).toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("requires the nonstandard Skill for an in-range custom ratio too", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Banner", prompt: "activity banner", model: native.id,
      aspectRatio: "358:176", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: "尺寸 358×176，主题根据文案来" } }));
    expect(result).toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("accepts an in-range non-standard ratio without an acceptance phrase", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Banner", prompt: "activity banner", model: native.id,
      aspectRatio: "358:176", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: "尺寸 358×176，主题根据文案来", nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(result).toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: "358:176" }));
  });

  it("accepts an explicit out-of-range pixel size as approximation authorization", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Banner", prompt: "wide banner", model: native.id,
      aspectRatio: "3:1", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: "尺寸：658×176，主题根据文案来", nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(result).toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: "3:1" }));
  });

  it("keeps an explicit UI ratio ahead of the Skill approximation", async () => {
    const f = fixture();
    await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "3:1", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, image_generation_aspect_ratio: "16:9",
        nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: "16:9" }));
  });

  it("reports the doubled planning reference for an in-range custom ratio too", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "656:288", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: "做 656:288 的图，尺寸差不多就好",
        nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(result).toMatchObject({ status: "processing", approximateSizePlan: {
      target: { width: 656, height: 288 }, scaledTarget: { width: 1312, height: 576 },
      aspectRatio: "656:288", substituted: false } });
    expect("approximateSizePlan" in result ? result.approximateSizePlan?.ratioError : undefined).toBeLessThanOrEqual(0.01);
  });

  it.each(["精确尺寸656:176", "不要改变比例，非标准图片尺寸也不要用",
    "不使用非标准图片尺寸，做656:176"])("does not infer approximation from %s", async (prompt) => {
    const f = fixture();
    const result = await f.generate.execute({ title: "Header", prompt: "blue header", model: native.id,
      aspectRatio: "3:1", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal,
      configurable: { ...configurable, user_prompt: prompt,
        nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(result).toMatchObject({ status: "failed", error: "image_approximation_not_authorized" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("rejects raw 656:176 and accepts the loaded nearest boundary in the edit route", async () => {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const f = fixture({ ...native, upstreamModelId: "gpt-image-2.5-flare" });
    const editConfig = { ...configurable, user_attachment_map: { [assetId]: source } };
    const args = { title: "Edited header", prompt: "keep subject", model: native.id,
      sourceAssetIds: [assetId], sourceUsage: "edit" as const, aspectRatio: "656:176",
      aspectRatioIntent: "resize" as const };
    const failed = await f.edit.execute(args, toolExecutionContext({ signal, configurable: editConfig }));
    expect(failed).toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
    expect(f.submit).not.toHaveBeenCalled();
    const accepted = await f.edit.execute({ ...args, aspectRatio: "3:1", aspectRatioIntent: "approximate" }, toolExecutionContext({ signal, configurable: { ...editConfig, nonstandard_size_skill_loaded_run_id: "run" } }));
    expect(accepted.error).toBeUndefined();
    expect(accepted).toMatchObject({ status: "processing", approximateSizePlan: { aspectRatio: "3:1" } });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      aspectRatio: "3:1", inputImages: [source], quality: "standard", resolution: "1k",
    }));
  });
});
