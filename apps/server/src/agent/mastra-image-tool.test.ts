import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type { MastraImageSubmitContext } from "./mastra-image-tool.js";
import { createMastraImageEditTool, createMastraImageTool, createMastraImageTools } from "./mastra-image-tool.js";
import { MastraImagePreflightError } from "./mastra-image-jobs.js";
import { toolExecutionContext } from "./tools/tool-run-context.js";

const assetId = "10000000-0000-4000-8000-000000000001";
const objectId = "10000000-0000-4000-8000-000000000002";
const designId = "20000000-0000-4000-8000-000000000001";
const baseConfig = {
  signal: new AbortController().signal,
  configurable: {
    user_id: "user", access_token: "token", workspace_id: "workspace", session_id: "session", canvas_id: "canvas", run_id: "run",
    user_prompt: "制作横幅", image_generation_aspect_ratio: "16:9",
  },
};
const models = [
  { id: "workspace:auto", provider: "test", upstreamModelId: "upstream-a", displayName: "Auto", description: "" },
  { id: "workspace:selected", provider: "test", upstreamModelId: "upstream-b", displayName: "Selected", description: "" },
];

function fixture(options: {
  groundSources?: Parameters<typeof createMastraImageTool>[0]["groundSources"];
  resolveExplicitSources?: Parameters<typeof createMastraImageTool>[0]["resolveExplicitSources"];
  autoLibrarySources?: Parameters<typeof createMastraImageTool>[0]["autoLibrarySources"];
  availableImageModels?: typeof models;
  currentUserText?: string;
} = {}) {
  const submit = vi.fn(async (_context: MastraImageSubmitContext, _input: any) => ({
    jobId: "job-1", status: "processing" as const,
    creditsCost: 0, pricingVersion: "credits-v1",
    actualQuality: (_input.quality === "ultra" ? "High" : _input.quality === "hd" ? "Medium" : "Low") as "High" | "Medium" | "Low",
    actualResolution: (_input.resolution ?? "1k").toUpperCase() as "1K" | "2K" | "4K",
  }));
  const deps = { createUserClient: vi.fn(), submitter: { submit }, availableImageModels: options.availableImageModels ?? models,
    currentUserMessage: { runId: "run", text: options.currentUserText ?? "制作横幅" },
    ...(options.groundSources ? { groundSources: options.groundSources } : {}),
    ...(options.resolveExplicitSources ? { resolveExplicitSources: options.resolveExplicitSources } : {}),
    ...(options.autoLibrarySources ? { autoLibrarySources: options.autoLibrarySources } : {}) };
  return { generate: createMastraImageTool(deps), edit: createMastraImageEditTool(deps), submit };
}

describe("Mastra direct image tool", () => {
  it("auto-attaches workspace library references for a promo skill that supplied none", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const autoLibrarySources = vi.fn(async () => ({ sourceAssetIds: [assetId], inputImages: [source] }));
    const f = fixture({ autoLibrarySources });
    await expect(f.generate.execute({ title: "Banner", prompt: "casino promo", model: "workspace:selected" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, promo_library_auto_run_id: "run" },
    }))).resolves.toMatchObject({ status: "processing" });
    expect(autoLibrarySources).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [source] }));
  });
  it("never auto-attaches library references without the promo run marker", async () => {
    const autoLibrarySources = vi.fn(async () => ({ sourceAssetIds: [assetId], inputImages: ["data:image/png;base64,AAAA"] }));
    const f = fixture({ autoLibrarySources });
    await f.generate.execute({ title: "Banner", prompt: "casino promo", model: "workspace:selected" }, toolExecutionContext(baseConfig));
    expect(autoLibrarySources).not.toHaveBeenCalled();
  });
  it("prefers workspace library references over canvas grounding for a promo skill", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "green" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const groundSources = vi.fn(async () => ({ decision: "bind" as const, usage: "reference" as const,
      sourceAssetIds: [assetId], inputImages: [source], authorizationGranted: false as const }));
    const autoLibrarySources = vi.fn(async () => ({ sourceAssetIds: [objectId], inputImages: [source] }));
    const f = fixture({ groundSources: groundSources as never, autoLibrarySources });
    await expect(f.generate.execute({ title: "Banner", prompt: "casino promo", model: "workspace:selected" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, promo_library_auto_run_id: "run" },
    }))).resolves.toMatchObject({ status: "processing" });
    expect(autoLibrarySources).toHaveBeenCalledTimes(1);
    expect(groundSources).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [source] }));
  });
  it("adds workspace library references to a promo reference-style edit", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const autoLibrarySources = vi.fn(async () => ({ sourceAssetIds: [objectId], inputImages: [source] }));
    const f = fixture({ autoLibrarySources });
    await expect(f.edit.execute({ title: "Restyle", prompt: "change to ocean style", model: "workspace:selected",
      sourceAssetIds: [assetId], sourceUsage: "reference" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, promo_library_auto_run_id: "run",
        user_attachment_map: { [assetId]: source } } }))).resolves.toMatchObject({ status: "processing" });
    expect(autoLibrarySources).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [source, source] }));
  });
  it("leaves a strict edit and non-promo edits without library additions", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const autoLibrarySources = vi.fn(async () => ({ sourceAssetIds: [objectId], inputImages: [source] }));
    const f = fixture({ autoLibrarySources });
    await f.edit.execute({ title: "Recolor", prompt: "recolor the logo", model: "workspace:selected",
      sourceAssetIds: [assetId], sourceUsage: "edit" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, promo_library_auto_run_id: "run",
        user_attachment_map: { [assetId]: source } } }));
    await f.edit.execute({ title: "Recolor", prompt: "recolor the logo", model: "workspace:selected",
      sourceAssetIds: [assetId], sourceUsage: "reference" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, user_attachment_map: { [assetId]: source } } }));
    expect(autoLibrarySources).not.toHaveBeenCalled();
  });
  it("validates the full explicit source set even when a stale source is already attached", async () => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const resolveExplicitSources = vi.fn(async () => {
      throw new Error("explicit_source_conflicts_with_canvas_selection");
    });
    const f = fixture({ resolveExplicitSources });
    await expect(f.edit.execute({ title: "改色", prompt: "把 aaaa 改成红色", sourceAssetIds: [assetId] }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, user_attachment_map: { [assetId]: source } },
    }))).resolves.toMatchObject({ status: "failed", error: "source_selection_conflict" });
    expect(resolveExplicitSources).toHaveBeenCalledWith(expect.objectContaining({ sourceAssetIds: [assetId] }));
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("returns a no-write correction for default Low legacy removal before resolving sources or submitting", async () => {
    const resolveExplicitSources = vi.fn();
    const f = fixture({ resolveExplicitSources });
    await expect(f.edit.execute({ operation: "remove_background", title: "去背景", prompt: "remove background", sourceAssetIds: [assetId] }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ error: "image_legacy_background_removal_contract_required" });
    expect(resolveExplicitSources).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects model/history/config-only quality and resolution upgrades before grounding", async () => {
    const groundSources = vi.fn(async () => ({ decision: "skip" as const }));
    const f = fixture({ groundSources: groundSources as never });
    await expect(f.generate.execute({ title: "Logo", prompt: "use High at 4K", quality: "ultra", resolution: "4k" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, user_prompt: "使用High生成4K" },
    }))).resolves.toMatchObject({ error: "image_quality_not_authorized" });
    expect(groundSources).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects explicitly authorized 2K on a pinned legacy all model", async () => {
    const f = fixture({ currentUserText: "生成2K海报", availableImageModels: [{ ...models[0]!, upstreamModelId: "gpt-image-2-all" }] });
    await expect(f.generate.execute({ title: "Poster", prompt: "poster", model: models[0]!.id, resolution: "2k" }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ error: "image_resolution_not_supported" });
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("keeps the two outputs of a multi-ratio original request in one shared run", async () => {
    const submit = vi.fn(async () => ({ jobId: "job", status: "processing" as const }));
    const tools = createMastraImageTools({ createUserClient: vi.fn(), submitter: { submit }, availableImageModels: models,
      currentUserMessage: { runId: "run", text: "生成一张1:1和一张16:9的宣传图" } });
    const config = { ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto" } };
    for (const aspectRatio of ["1:1", "16:9"])
      await expect(tools.generateImage.execute({ title: "宣传图", prompt: "brand", aspectRatio, aspectRatioIntent: "resize" }, toolExecutionContext(config))).resolves.toMatchObject({ status: "processing" });
    await expect(tools.generateImage.execute({ title: "第三张", prompt: "brand", aspectRatio: "1:1" }, toolExecutionContext(config))).resolves.toMatchObject({ error: "image_generation_run_limit", limit: 2 });
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it("shares the output counter across generation/edit, permits exact replay and rejects concurrent excess", async () => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const config = { ...baseConfig, configurable: { ...baseConfig.configurable, user_attachment_map: { [assetId]: `data:image/png;base64,${bytes.toString("base64")}` } } };
    const submit = vi.fn(async () => ({ jobId: "job", status: "processing" as const }));
    const tools = createMastraImageTools({ createUserClient: vi.fn(), submitter: { submit }, availableImageModels: models,
      currentUserMessage: { runId: "run", text: "制作海报" } });
    const first = { title: "First", prompt: "poster" };
    await tools.generateImage.execute(first, toolExecutionContext(config));
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, index) => tools.editImage.execute({ title: `Edit${index}`, prompt: "edit", sourceAssetIds: [assetId] }, toolExecutionContext(config))));
    expect(outcomes.filter(result => result.error === "image_generation_run_limit")).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(4);
    await expect(tools.generateImage.execute(first, toolExecutionContext(config))).resolves.toMatchObject({ status: "processing" });
    expect(submit).toHaveBeenCalledTimes(5);
    await expect(tools.generateImage.execute({ title: "New", prompt: "poster" }, toolExecutionContext(config))).resolves.toMatchObject({ error: "image_generation_run_limit" });
  });
  it("does not consume output budget for proven no-write failures", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new MastraImagePreflightError("no_write", "not submitted"));
    await expect(f.generate.execute({ title: "Bad", prompt: "poster" }, toolExecutionContext(baseConfig))).resolves.toMatchObject({ error: "no_write" });
    for (let i = 0; i < 4; i++) await expect(f.generate.execute({ title: `Good${i}`, prompt: "poster" }, toolExecutionContext(baseConfig))).resolves.toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledTimes(5);
  });
  it("serializes concurrent requests so an unknown transport receipt freezes later submissions", async () => {
    let reject!: (error: Error) => void;
    const submit = vi.fn(() => new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const tools = createMastraImageTools({ createUserClient: vi.fn(), submitter: { submit }, availableImageModels: models });
    const first = tools.generateImage.execute({ title: "First", prompt: "poster" }, toolExecutionContext(baseConfig));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const second = tools.generateImage.execute({ title: "Second", prompt: "poster" }, toolExecutionContext(baseConfig));
    reject(new Error("transport unknown"));
    expect(await first).toMatchObject({ status: "unknown" });
    expect(await second).toMatchObject({ status: "unknown" });
    expect(submit).toHaveBeenCalledOnce();
  });
  it("strips incidental metadata before submission while validating known fields", async () => {
    const f = fixture();
    await f.generate.execute({ title: "Logo", prompt: "logo", title_unused: "x" } as any, toolExecutionContext(baseConfig));
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]![1]).not.toHaveProperty("title_unused");
    await expect(f.generate.execute({ title: "Logo", prompt: "logo", model: 123 } as any, toolExecutionContext(baseConfig))).rejects.toThrow();
    await expect(f.generate.execute({ title: "Logo", prompt: "logo", inputImages: ["https://example.com/x"] } as any, toolExecutionContext(baseConfig))).rejects.toThrow();
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it("passes native transparency and PNG through one normal generation", async () => {
    const f = fixture({ availableImageModels: [models[0]!, { ...models[1]!, upstreamModelId: "gpt-image-2" }] });
    await f.generate.execute({ title: "透明Logo", prompt: "transparent logo", background: "transparent", outputFormat: "jpg" }, toolExecutionContext(baseConfig));
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      background: "transparent", outputFormat: "png", operation: "generate", model: models[1]!.id,
    }));
  });
  it.each(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])("submits transparent source editing with the current %s model without the legacy removal operation", async (upstreamModelId) => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const source = `data:image/png;base64,${bytes.toString("base64")}`;
    const current = { ...models[0]!, upstreamModelId };
    const f = fixture({ availableImageModels: [current] });
    await expect(f.edit.execute({ title: "去背景", prompt: "只去掉背景，保留主体，返回真实透明 PNG", sourceAssetIds: [assetId], sourceUsage: "edit", background: "transparent", outputFormat: "png" }, toolExecutionContext({
      signal: baseConfig.signal,
      configurable: { ...baseConfig.configurable, user_prompt: "把这张图片抠成透明底", image_generation_aspect_ratio: "auto", user_attachment_map: { [assetId]: source } },
    }))).resolves.toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      operation: "generate", model: current.id, inputImages: [source], background: "transparent", outputFormat: "png", aspectRatio: "30:40",
    }));
  });
  it.each([undefined, "2k", "4k"] as const)("keeps Low quality independent of resolution %s", async (resolution) => {
    const f = fixture({ currentUserText: `制作${resolution ?? "1k"}海报` });
    const result = await f.generate.execute({ title: "海报", prompt: "poster", ...(resolution ? { resolution } : {}) }, toolExecutionContext(baseConfig));
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quality: "standard", resolution: resolution ?? "1k" }));
    expect(result).toMatchObject({ actualQuality: "Low", actualResolution: (resolution ?? "1k").toUpperCase() });
  });
  it("reports hd as Medium rather than High", async () => {
    const f = fixture({ currentUserText: "使用Medium制作海报" });
    expect(await f.generate.execute({ title: "海报", prompt: "poster", quality: "hd" }, toolExecutionContext(baseConfig)))
      .toMatchObject({ actualQuality: "Medium", actualResolution: "1K" });
  });
  it("preserves terminal error classification through the tool receipt", async () => {
    for (const errorCode of ["provider_rejected", "image_generation_result_unknown"]) {
      const submit = vi.fn(async () => ({ jobId: "job-terminal", error: "provider did not deliver",
        errorCode, retryEligible: errorCode === "provider_rejected" }));
      const generate = createMastraImageTool({ createUserClient: vi.fn(), submitter: { submit }, availableImageModels: models });
      await expect(generate.execute({ title: "海报", prompt: "poster" }, toolExecutionContext(baseConfig))).resolves.toMatchObject({
        status: "failed", jobId: "job-terminal", errorCode, retryEligible: errorCode === "provider_rejected",
      });
      expect(submit).toHaveBeenCalledOnce();
    }
  });
  it("uses the semantic frame of each output instead of rejecting a multi-ratio brief", async () => {
    for (const aspectRatio of ["1:1", "16:9"]) {
      const f = fixture();
      await expect(f.generate.execute({ title: "宣传图", prompt: "brand visual", aspectRatio, aspectRatioIntent: "resize" }, toolExecutionContext({
        ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto",
          user_prompt: "生成一张1:1和一张16:9的宣传图" },
      }))).resolves.toMatchObject({ status: "processing" });
      expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio }));
    }
  });
  it("chooses the explicit-size adapter for Auto non-square requests without replacing manual choices", async () => {
    const availableImageModels = [
      { ...models[0]!, upstreamModelId: "nano-banana-2" },
      { ...models[1]!, upstreamModelId: "gpt-image-2" },
    ];
    const f = fixture({ availableImageModels });
    await f.generate.execute({ title: "海报", prompt: "brand poster" }, toolExecutionContext(baseConfig));
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "workspace:selected" }));
    const manual = fixture({ availableImageModels });
    await manual.generate.execute({ title: "海报", prompt: "brand poster" }, toolExecutionContext({ ...baseConfig,
      configurable: { ...baseConfig.configurable, image_generation_model_constraint: { manualModelIds: ["workspace:auto"] } } }));
    expect(manual.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "workspace:auto" }));
  });
  it("inherits actual source dimensions when an edit omits its ratio", async () => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const f = fixture();
    await expect(f.edit.execute({ title: "修改", prompt: "only change text", aspectRatio: "1:1", sourceAssetIds: [assetId] }, toolExecutionContext({
      signal: baseConfig.signal,
      configurable: { ...baseConfig.configurable, user_prompt: "只改文字，比例不变", image_generation_aspect_ratio: "auto",
        user_attachment_map: { [assetId]: `data:image/png;base64,${bytes.toString("base64")}` } },
    }))).resolves.toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: "30:40" }));
  });
  it.each(["explicit", "grounded"] as const)("keeps source-frame preservation and semantic resize distinct for %s edits", async (route) => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const reference = `data:image/png;base64,${bytes.toString("base64")}`;
    for (const resize of [false, true]) {
      const f = fixture({ groundSources: async () => ({ decision: "bind", usage: "edit",
        sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false }) });
      const result = await (route === "explicit" ? f.edit : f.generate).execute({
        title: "Banner", prompt: "modify previous image", aspectRatio: "16:9",
        ...(resize ? { aspectRatioIntent: "resize" as const } : {}),
        ...(route === "explicit" ? { sourceAssetIds: [assetId] } : {}),
      }, toolExecutionContext({ ...baseConfig, configurable: { ...baseConfig.configurable,
        image_generation_aspect_ratio: "auto", user_prompt: resize ? "修改上一张图，改成16:9" : "修改上一张图",
        user_attachment_map: { [assetId]: reference } } }));
      expect(result).toMatchObject({ status: "processing", actualQuality: "Low", actualResolution: "1K" });
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
        aspectRatio: resize ? "16:9" : "30:40", inputImages: [reference],
      }));
      expect(f.submit.mock.calls[0]![1]).not.toHaveProperty("aspectRatioIntent");
      expect(f.submit.mock.calls[0]![1]).not.toHaveProperty("sourceUsage");
    }
  });
  it.each(["explicit", "grounded"] as const)("requires current output-frame authorization for %s edits", async (route) => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const reference = `data:image/png;base64,${bytes.toString("base64")}`;
    for (const userPrompt of ["修改上一张图", "把这个16:9的图改成蓝色", "把16:9的图改成蓝色", "这张图是16:9，改成蓝色", "把这张比例为16:9的图片改蓝色", "Make this 16:9 image blue", "change the 16:9 image to blue", "This image is 16:9, make it blue", "这个16:9的图只改文字，比例不变"]) {
      const f = fixture({ groundSources: async () => ({ decision: "bind", usage: "edit",
        sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false }) });
      await expect((route === "explicit" ? f.edit : f.generate).execute({
        title: "Banner", prompt: "make source blue", aspectRatio: "16:9", aspectRatioIntent: "resize",
        ...(route === "explicit" ? { sourceAssetIds: [assetId] } : {}),
      }, toolExecutionContext({ ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto",
        user_prompt: userPrompt, user_attachment_map: { [assetId]: reference } } }))).resolves.toMatchObject({ status: "processing" });
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ aspectRatio: "30:40" }));
    }
  });
  it.each(["explicit", "grounded"] as const)("uses current Chinese and English output specifications for %s edits", async (route) => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const reference = `data:image/png;base64,${bytes.toString("base64")}`;
    for (const [userPrompt, aspectRatio] of [
      ["把这个16:9的图改成4:3", "4:3"],
      ["Resize this 16:9 image to 4:3", "4:3"],
      ["把上一张图调整到1200×628", "1200:628"],
      ["Change the output dimensions to 1200 x 628", "1200:628"],
    ]) {
      const f = fixture({ groundSources: async () => ({ decision: "bind", usage: "edit",
        sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false }) });
      await expect((route === "explicit" ? f.edit : f.generate).execute({
        title: "Banner", prompt: "resize source", aspectRatio: "1:1",
        ...(route === "explicit" ? { sourceAssetIds: [assetId] } : {}),
      }, toolExecutionContext({ ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto",
        user_prompt: userPrompt, user_attachment_map: { [assetId]: reference },
        nonstandard_size_skill_loaded_run_id: "run" } }))).resolves.toMatchObject({ status: "processing" });
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ aspectRatio }));
    }
    for (const aspectRatio of ["1:1", "16:9"]) {
      const f = fixture({ groundSources: async () => ({ decision: "bind", usage: "edit",
        sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false }) });
      await expect((route === "explicit" ? f.edit : f.generate).execute({
        title: "宣传图", prompt: "adapt source for each output", aspectRatio, aspectRatioIntent: "resize",
        ...(route === "explicit" ? { sourceAssetIds: [assetId] } : {}),
      }, toolExecutionContext({ ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto",
        user_prompt: "把上一张图生成一张1:1和一张16:9的宣传图", user_attachment_map: { [assetId]: reference } } }))).resolves.toMatchObject({ status: "processing" });
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ aspectRatio }));
    }
  });
  it.each(["explicit", "grounded"] as const)("retains the authorized approximation and original target for %s edits", async (route) => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const reference = `data:image/png;base64,${bytes.toString("base64")}`;
    const nativeModels = [{ ...models[0]!, upstreamModelId: "gpt-image-2" }];
    for (const skillRunId of [undefined, "other-run", "run"]) {
      const f = fixture({ availableImageModels: nativeModels, groundSources: async () => ({ decision: "bind", usage: "edit",
        sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false }) });
      const result = await (route === "explicit" ? f.edit : f.generate).execute({
        title: "Banner", prompt: "resize source", aspectRatio: "3:1", aspectRatioIntent: "approximate",
        ...(route === "explicit" ? { sourceAssetIds: [assetId] } : {}),
      }, toolExecutionContext({ ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto",
        user_prompt: "把上一张图改成656×176，尺寸差不多就好", nonstandard_size_skill_loaded_run_id: skillRunId,
        user_attachment_map: { [assetId]: reference } } }));
      if (skillRunId === "run") {
        expect(result).toMatchObject({ status: "processing", actualQuality: "Low", actualResolution: "1K",
          approximateSizePlan: { target: { width: 656, height: 176 }, aspectRatio: "3:1" } });
        expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
          aspectRatio: "3:1", inputImages: [reference], quality: "standard", resolution: "1k" }));
      } else {
        expect(result).toMatchObject({ status: "failed", error: "image_nonstandard_size_skill_required" });
        expect(f.submit).not.toHaveBeenCalled();
      }
    }
  });
  it("uses the current UI model and ratio before durable submission", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "横幅", prompt: "蓝色横幅", model: "stale" }, toolExecutionContext({
      signal: baseConfig.signal,
      configurable: { ...baseConfig.configurable, image_generation_model_constraint: { manualModelIds: ["workspace:selected"] } },
    }));
    expect(result).toMatchObject({ status: "processing", jobId: "job-1" });
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ runId: "run" }), expect.objectContaining({
      model: "workspace:selected", aspectRatio: "16:9", quality: "standard",
    }));
    expect((f.submit.mock.calls as unknown as Array<[MastraImageSubmitContext, unknown]>)[0]![0].signal).toBe(baseConfig.signal);
    expect((f.submit.mock.calls as unknown as Array<[unknown, { target?: unknown }]>)[0]![1].target).toBeUndefined();
  });

  it("keeps a manual output ratio for both explicit and automatically grounded edits", async () => {
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).png().toBuffer();
    const reference = `data:image/png;base64,${bytes.toString("base64")}`;
    for (const route of ["explicit", "grounded"] as const) {
      const f = fixture({ groundSources: async () => ({ decision: "bind", usage: "edit",
        sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false }) });
      const input = { title: "修改", prompt: "Modify the previous poster", aspectRatio: "1:1",
        ...(route === "explicit" ? { sourceAssetIds: [assetId] } : {}) };
      const result = await (route === "explicit" ? f.edit : f.generate).execute(input, toolExecutionContext({
        ...baseConfig, configurable: { ...baseConfig.configurable, user_prompt: "修改上一张图",
          image_generation_aspect_ratio: "16:9", user_attachment_map: { [assetId]: reference } },
      }));
      expect(result).toMatchObject({ status: "processing" });
      expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: "16:9", inputImages: [reference] }));
    }
  });

  it("maps a unique upstream catalog model name to its workspace model ID", async () => {
    const f = fixture({ availableImageModels: [
      { id: "workspace:nano", provider: "test", upstreamModelId: "nano-banana-2", displayName: "Nano Banana", description: "" },
      { id: "workspace:gpt", provider: "test", upstreamModelId: "gpt-image-2", displayName: "GPT Image", description: "" },
    ] });
    await expect(f.generate.execute({ title: "海报", prompt: "3:4 海报", model: "gpt-image-2" }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "workspace:gpt" }));
  });

  it("rejects an ambiguous upstream alias instead of selecting the first catalog model", async () => {
    const f = fixture({ availableImageModels: [
      { id: "workspace:one", provider: "test", upstreamModelId: "gpt-image-2", displayName: "GPT Image A", description: "" },
      { id: "workspace:two", provider: "test", upstreamModelId: "gpt-image-2", displayName: "GPT Image B", description: "" },
    ] });
    await expect(f.generate.execute({ title: "海报", prompt: "海报", model: "gpt-image-2" }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ status: "failed", error: "image_model_identifier_ambiguous" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("keeps the manual UI model authoritative over a stale model-shaped tool argument", async () => {
    const f = fixture();
    await f.generate.execute({ title: "海报", prompt: "海报", model: "gpt-image-2" }, toolExecutionContext({
      signal: baseConfig.signal,
      configurable: { ...baseConfig.configurable, image_generation_model_constraint: { manualModelIds: ["workspace:auto"] } },
    }));
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "workspace:auto" }));
  });

  it("rejects an explicitly unconfigured model but permits Auto", async () => {
    const f = fixture();
    await expect(f.generate.execute({ title: "海报", prompt: "海报", model: "not-in-catalog" }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ status: "failed", error: "image_model_identifier_unavailable" });
    expect(f.submit).not.toHaveBeenCalled();
    await expect(f.generate.execute({ title: "海报", prompt: "海报", model: "auto" }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "workspace:auto" }));
  });

  it("binds an authenticated attachment asset instead of forwarding its ID or URL", async () => {
    const f = fixture();
    const reference = "data:image/png;base64,aGVsbG8=";
    const result = await f.edit.execute({ title: "改图", prompt: "改成蓝色", sourceAssetIds: [assetId], sourceUsage: "edit" }, toolExecutionContext({
      signal: baseConfig.signal,
      configurable: { ...baseConfig.configurable, user_attachment_map: { [assetId]: reference } },
    }));
    expect(result).toMatchObject({ status: "processing", sourceAssetIds: [assetId] });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [reference] }));
  });

  it("keeps new generation and source-bound editing as separate contracts", async () => {
    const f = fixture();
    await expect(f.generate.execute({ title: "新图", prompt: "蓝色", inputImages: [assetId] } as any, toolExecutionContext(baseConfig))).rejects.toThrow();
    await expect(f.edit.execute({ title: "改图", prompt: "蓝色", sourceAssetIds: ["https://attacker.example/reference.png"] } as any, toolExecutionContext(baseConfig))).rejects.toThrow();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("binds an explicit source for a visual-reference variant without guessing a latest job", async () => {
    const f = fixture();
    const reference = "data:image/png;base64,aGVsbG8=";
    await expect(f.edit.execute({ title: "同系列图", prompt: "保持视觉风格", sourceAssetIds: [assetId], sourceUsage: "reference" }, toolExecutionContext({
      signal: baseConfig.signal,
      configurable: { ...baseConfig.configurable, user_attachment_map: { [assetId]: reference } },
    }))).resolves.toMatchObject({ status: "processing", sourceAssetIds: [assetId] });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [reference] }));
  });

  it("materializes an authenticated native-design source before falling back to live canvas lookup", async () => {
    const reference = "data:image/png;base64,bmF0aXZlLWRlc2lnbg==";
    const resolveExplicitSources = vi.fn(async ({ sourceAssetIds }: { sourceAssetIds: readonly string[] }) => ({
      sourceAssetIds: [...sourceAssetIds], inputImages: [reference],
    }));
    const f = fixture({ resolveExplicitSources });
    const result = await f.edit.execute({ title: "设计内改图", prompt: "改成蓝色", sourceAssetIds: [assetId] }, toolExecutionContext(baseConfig));
    expect(result).toMatchObject({ status: "processing", sourceAssetIds: [assetId] });
    expect(resolveExplicitSources).toHaveBeenCalledOnce();
    expect(resolveExplicitSources).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ runId: "run", signal: baseConfig.signal }), sourceAssetIds: [assetId],
    }));
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [reference] }));
  });

  it("grounds a trusted current-turn source once and submits it without a second model tool call", async () => {
    const reference = "data:image/png;base64,aGVsbG8=";
    const groundSources = vi.fn(async () => ({ decision: "bind" as const, usage: "reference" as const,
      sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false as const }));
    const f = fixture({ groundSources });
    const result = await f.generate.execute({ title: "同系列横幅", prompt: "参考刚才图的风格" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, image_generation_aspect_ratio: "auto" },
    }));
    expect(result).toMatchObject({ status: "processing", sourceAssetIds: [assetId] });
    expect(groundSources).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [reference], aspectRatio: "16:9" }));
  });

  it("does not submit when trusted source grounding is ambiguous or unavailable", async () => {
    const groundSources = vi.fn(async () => ({ decision: "recoverable" as const,
      code: "source_grounding_ambiguous" as const, summary: "请明确参考图", authorizationGranted: false as const }));
    const f = fixture({ groundSources });
    await expect(f.generate.execute({ title: "横幅", prompt: "参考刚才图片" }, toolExecutionContext(baseConfig)))
      .resolves.toMatchObject({ status: "failed", error: "source_grounding_ambiguous" });
    expect(f.submit).not.toHaveBeenCalled();
    expect(groundSources).toHaveBeenCalledOnce();
  });

  it("reselects Auto after a square generation gains references, without overriding explicit choices", async () => {
    const availableImageModels = [
      { ...models[0]!, upstreamModelId: "nano-banana-2" },
      { ...models[1]!, upstreamModelId: "gpt-image-2" },
    ];
    const groundSources = vi.fn(async () => ({ decision: "bind" as const, usage: "reference" as const,
      sourceAssetIds: [assetId], inputImages: ["data:image/png;base64,aGVsbG8="], authorizationGranted: false as const }));
    for (const selection of ["auto", "manual", "explicit"] as const) {
      const f = fixture({ availableImageModels, groundSources });
      const result = await f.generate.execute({ title: "Logo", prompt: "Use the previous logo style",
        ...(selection === "explicit" ? { model: "workspace:auto" } : {}) }, toolExecutionContext({
        ...baseConfig, configurable: { ...baseConfig.configurable, user_prompt: "参考上一张logo做一个新logo",
          image_generation_aspect_ratio: "1:1",
          ...(selection === "manual" ? { image_generation_model_constraint: { manualModelIds: ["workspace:auto"] } } : {}) },
      }));
      expect(result).toMatchObject({ status: "processing" });
      expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        model: selection === "auto" ? "workspace:selected" : "workspace:auto", aspectRatio: "1:1",
      }));
    }
  });

  it("does not retry source grounding or submission after an unknown receipt", async () => {
    const reference = "data:image/png;base64,aGVsbG8=";
    const groundSources = vi.fn(async () => ({ decision: "bind" as const, usage: "edit" as const,
      sourceAssetIds: [assetId], inputImages: [reference], authorizationGranted: false as const }));
    const f = fixture({ groundSources });
    f.submit.mockRejectedValueOnce(new Error("transport lost"));
    const first = await f.generate.execute({ title: "横幅", prompt: "参考刚才图片" }, toolExecutionContext(baseConfig));
    const second = await f.generate.execute({ title: "横幅", prompt: "换个词再试" }, toolExecutionContext(baseConfig));
    expect(first).toMatchObject({ status: "unknown" });
    expect(second).toEqual(first);
    expect(groundSources).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("fails closed when the runtime did not bind a cancellation signal", async () => {
    const f = fixture();
    const result = await f.generate.execute({ title: "横幅", prompt: "蓝色横幅" }, toolExecutionContext({
      configurable: baseConfig.configurable,
    }));
    expect(result).toMatchObject({ status: "failed", error: "image_context_unavailable" });
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("does not submit changed arguments again after an unknown transport outcome", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new Error("transport lost"));
    const first = await f.generate.execute({ title: "横幅", prompt: "蓝色横幅" }, toolExecutionContext(baseConfig));
    const second = await f.generate.execute({ title: "再试一次", prompt: "蓝色横幅，重新提交" }, toolExecutionContext(baseConfig));
    expect(first).toMatchObject({ status: "unknown" });
    expect(second).toEqual(first);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("allows another canvas attempt after a proven no-write preflight rejection", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new MastraImagePreflightError("image_preflight_rejected", "未创建任务。"));
    await expect(f.generate.execute({ title: "海报", prompt: "poster" }, toolExecutionContext(baseConfig))).resolves.toMatchObject({ status: "failed" });
    await expect(f.generate.execute({ title: "海报", prompt: "poster" }, toolExecutionContext(baseConfig))).resolves.toMatchObject({ status: "processing" });
    expect(f.submit).toHaveBeenCalledTimes(2);
  });

  it("supports a bounded multi-image reference set", async () => {
    const f = fixture();
    const sourceAssetIds = Array.from({ length: 9 }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`);
    const user_attachment_map = Object.fromEntries(sourceAssetIds.map((id, index) =>
      [id, `data:image/png;base64,cmVm${index}`]));
    const result = await f.edit.execute({ title: "九图参考", prompt: "融合视觉参考", sourceAssetIds, sourceUsage: "reference" }, toolExecutionContext({
      signal: baseConfig.signal, configurable: { ...baseConfig.configurable, user_attachment_map },
    }));
    expect(result).toMatchObject({ status: "processing", sourceAssetIds });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: Object.values(user_attachment_map) }));
  });

  it("accepts all sixteen authenticated references and rejects seventeen before submission", async () => {
    const f = fixture();
    const sixteen = Array.from({ length: 16 }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
    const user_attachment_map = Object.fromEntries(sixteen.map((id, index) =>
      [id, `data:image/png;base64,c2l4dGVlbi0${index}`]));
    await expect(f.edit.execute({ title: "十六图参考", prompt: "融合全部参考", sourceAssetIds: sixteen, sourceUsage: "reference" }, toolExecutionContext({
      signal: baseConfig.signal, configurable: { ...baseConfig.configurable, user_attachment_map },
    }))).resolves.toMatchObject({ status: "processing", sourceAssetIds: sixteen });
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: Object.values(user_attachment_map) }));

    await expect(f.edit.execute({ title: "十七图参考", prompt: "融合全部参考", sourceAssetIds: [...sixteen,
      "10000000-0000-4000-8000-000000000117"] } as any, toolExecutionContext(baseConfig))).rejects.toThrow();
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("shares an unknown-submission receipt across generate and edit", async () => {
    const submit = vi.fn(async (_context: MastraImageSubmitContext, _input: unknown) => { throw new Error("transport lost"); });
    const tools = createMastraImageTools({ createUserClient: vi.fn(), submitter: { submit }, availableImageModels: models });
    const first = await tools.generateImage.execute({ title: "横幅", prompt: "蓝色横幅" }, toolExecutionContext(baseConfig));
    const second = await tools.editImage.execute({ title: "改图", prompt: "蓝色", sourceAssetIds: [assetId] }, toolExecutionContext(baseConfig));
    expect(first).toMatchObject({ status: "unknown" });
    expect(second).toEqual(first);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("never exposes or accepts a board target, while an open board does not block canvas generation", async () => {
    const f = fixture();
    for (const imageTool of [f.generate, f.edit]) {
      expect(imageTool.inputSchema!.safeParse({ title: "test", prompt: "test", target: {} } as never).success).toBe(false);
      await expect(imageTool.execute({ title: "海报", prompt: "poster", sourceAssetIds: [assetId],
        target: { kind: "design", design_id: designId, expected_revision: 7 } } as any, toolExecutionContext(baseConfig))).rejects.toThrow();
    }
    expect(f.submit).not.toHaveBeenCalled();
    await expect(f.generate.execute({ title: "海报", prompt: "poster" }, toolExecutionContext({
      ...baseConfig, configurable: { ...baseConfig.configurable, active_design_id: designId },
    }))).resolves.toMatchObject({ status: "processing" });
    expect(f.submit.mock.calls[0]![1]).not.toHaveProperty("target");
  });
});
