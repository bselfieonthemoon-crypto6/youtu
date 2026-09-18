import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { generateImage } from "../../../generation/image-generation.js";
import { OpenAIImageProvider } from "../../../generation/providers/openai-image.js";
import { getImageProviderAttempts } from "../../../generation/providers/registry.js";
import { getExecutor } from "../job-executor.js";
import { generationSourceAssetBinding } from "./image-generation-checkpoint.js";
import "./image-generation.js";

vi.mock("../../../generation/image-generation.js", () => ({
  generateImage: vi.fn(),
}));
vi.mock("../../../generation/providers/registry.js", () => ({
  resolveImageProviderName: vi.fn(() => "test-provider"),
  getImageProviderAttempts: vi.fn(() => undefined),
}));
vi.mock("../../images/feynobg-service.js", () => ({
  processWithFeynobg: vi.fn(async (buffer: Buffer) => ({
    width: 7,
    height: 5,
    layers: [
      {
        kind: "foreground",
        buffer,
        x: 0,
        y: 0,
        width: 7,
        height: 5,
      },
    ],
  })),
}));

let pngDataUri = "";
let transparentPngDataUri = "";
let emptyPngDataUri = "";
let mismatchedPortraitPngDataUri = "";
let repaintMaskDataUri = "";
let semanticSourceDataUri = "";
let semanticRepairDataUri = "";
let semanticLeftDataUri = "";
let semanticRightDataUri = "";
let semanticSourceMatchingLayerDataUri = "";

beforeAll(async () => {
  const source = await sharp({ create: { width: 32, height: 16, channels: 4,
    background: { r: 40, g: 50, b: 60, alpha: 1 } } }).png().toBuffer();
  semanticSourceDataUri = `data:image/png;base64,${source.toString("base64")}`;
  const repair = await sharp({ create: { width: 32, height: 16, channels: 4,
    background: { r: 210, g: 20, b: 180, alpha: 1 } } }).png().toBuffer();
  semanticRepairDataUri = `data:image/png;base64,${repair.toString("base64")}`;
  const createRegion = async (left: number) => {
    const pixels = Buffer.alloc(32 * 16 * 4);
    for (let y = 3; y < 13; y++) for (let x = left; x < left + 8; x++) {
      const i = (y * 32 + x) * 4;
      pixels[i] = 200; pixels[i + 1] = 30; pixels[i + 2] = 50; pixels[i + 3] = 255;
    }
    const png = await sharp(pixels, { raw: { width: 32, height: 16, channels: 4 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  };
  semanticLeftDataUri = await createRegion(2);
  semanticRightDataUri = await createRegion(22);
  const matchingPixels = Buffer.alloc(32 * 16 * 4);
  for (let y = 3; y < 13; y++) for (let x = 2; x < 10; x++) {
    const i = (y * 32 + x) * 4;
    matchingPixels[i] = 40; matchingPixels[i + 1] = 50;
    matchingPixels[i + 2] = 60; matchingPixels[i + 3] = 255;
  }
  semanticSourceMatchingLayerDataUri = `data:image/png;base64,${(
    await sharp(matchingPixels, { raw: { width: 32, height: 16, channels: 4 } }).png().toBuffer()
  ).toString("base64")}`;
  const png = await sharp({
    create: {
      width: 7,
      height: 5,
      channels: 4,
      background: { r: 30, g: 80, b: 120, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  pngDataUri = `data:image/png;base64,${png.toString("base64")}`;
  transparentPngDataUri = `data:image/png;base64,${(
    await sharp({
      create: {
        width: 7,
        height: 5,
        channels: 4,
        background: { r: 30, g: 80, b: 120, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer()
  ).toString("base64")}`;
  emptyPngDataUri = `data:image/png;base64,${(
    await sharp({
      create: {
        width: 7,
        height: 5,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer()
  ).toString("base64")}`;
  mismatchedPortraitPngDataUri = `data:image/png;base64,${(
    await sharp({ create: { width: 8, height: 12, channels: 4, background: "white" } }).png().toBuffer()
  ).toString("base64")}`;
  repaintMaskDataUri = `data:image/png;base64,${(
    await sharp(Buffer.from(Array.from({ length: 35 }, (_, index) =>
      index === 17 ? 255 : 0)), {
      raw: { width: 7, height: 5, channels: 1 },
    }).png().toBuffer()
  ).toString("base64")}`;
});

beforeEach(() => {
  vi.mocked(generateImage).mockReset();
  vi.mocked(getImageProviderAttempts).mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image generation executor durable provider recovery", () => {
  it("archives each semantic paid stage and retries layer storage without three new provider calls", async () => {
    const jobId = randomUUID(); const workspaceId = randomUUID();
    const model = "workspace:77777777-7777-4777-8777-777777777777";
    const assets = memoryAssets();
    assets.failNextUploadEnding("-1-element.png");
    vi.mocked(getImageProviderAttempts).mockReturnValue([{ ordinal: 0,
      providerName: "test-provider", modelId: model,
      upstreamModelId: "gpt-image-2.5-flare" }]);
    const returned = [semanticLeftDataUri, semanticRightDataUri, semanticRepairDataUri];
    vi.mocked(generateImage).mockImplementation(async () => ({
      url: returned.shift()!, mimeType: "image/png", width: 32, height: 16,
    }));
    const row = imageJob({ jobId, workspaceId, target: null,
      operation: "split_layers", model, inputImages: [semanticSourceDataUri],
      layerBackend: "semantic", layerNames: ["left", "right"], repairBackground: true });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);
    await expect(executor(jobId, {}, context as never)).rejects.toThrow("Storage upload failed");
    const result = await executor(jobId, {}, context as never);
    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ operation: "split_layers", model,
      source_width: 32, source_height: 16,
      layers: [{ kind: "background", name: "修补底图", width: 32, height: 16 },
        { kind: "element", name: "left", x: 2, y: 3, width: 8, height: 10 },
        { kind: "element", name: "right", x: 22, y: 3, width: 8, height: 10 }] });
    expect(assets.objects.has(`${workspaceId}/generated/${jobId}-semantic-layer-stage-0-source.png`)).toBe(true);
    expect(assets.objects.has(`${workspaceId}/generated/${jobId}-semantic-layer-stage-1-source.png`)).toBe(true);
    expect(assets.objects.has(`${workspaceId}/generated/${jobId}-semantic-layer-stage-2-source.png`)).toBe(true);
    expect(vi.mocked(generateImage).mock.calls[2]?.[1]).toMatchObject({ inputImages: [
      semanticSourceDataUri, expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/png;base64,/),
    ] });
    const background = assets.objects.get(`${workspaceId}/generated/${jobId}-0-background.png`)!;
    const pixels = await sharp(background).raw().toBuffer({ resolveWithObject: true });
    const outside = (0 * pixels.info.width + 15) * pixels.info.channels;
    const inside = (6 * pixels.info.width + 5) * pixels.info.channels;
    expect([...pixels.data.subarray(outside, outside + 3)]).toEqual([40, 50, 60]);
    expect(pixels.data[inside]).toBeGreaterThan(150);
  });
  it("rejects overlapping semantic element masks before generating a repaired background", async () => {
    const jobId = randomUUID(); const workspaceId = randomUUID();
    const model = "workspace:77777777-7777-4777-8777-777777777777";
    const assets = memoryAssets();
    vi.mocked(getImageProviderAttempts).mockReturnValue([{ ordinal: 0,
      providerName: "test-provider", modelId: model,
      upstreamModelId: "gpt-image-2.5-flare" }]);
    vi.mocked(generateImage).mockResolvedValue({ url: semanticSourceMatchingLayerDataUri,
      mimeType: "image/png", width: 32, height: 16 });
    const row = imageJob({ jobId, workspaceId, target: null,
      operation: "split_layers", model, inputImages: [semanticSourceDataUri],
      layerBackend: "semantic", layerNames: ["文字", "文字背景框"], repairBackground: true });
    const executor = getExecutor("image_generation")!;
    await expect(executor(jobId, {}, executorContext(row, assets.admin) as never))
      .rejects.toMatchObject({ code: "layer_output_overlap" });
    expect(generateImage).toHaveBeenCalledTimes(2);
  });
  it("allows legitimate nested layers when overlapping pixels contain different visual content", async () => {
    const jobId = randomUUID(); const workspaceId = randomUUID();
    const model = "workspace:77777777-7777-4777-8777-777777777777";
    const assets = memoryAssets();
    vi.mocked(getImageProviderAttempts).mockReturnValue([{ ordinal: 0,
      providerName: "test-provider", modelId: model,
      upstreamModelId: "gpt-image-2.5-flare" }]);
    const returned = [semanticSourceMatchingLayerDataUri, semanticLeftDataUri, semanticRepairDataUri];
    vi.mocked(generateImage).mockImplementation(async () => ({
      url: returned.shift()!, mimeType: "image/png", width: 32, height: 16,
    }));
    const row = imageJob({ jobId, workspaceId, target: null,
      operation: "split_layers", model, inputImages: [semanticSourceDataUri],
      layerBackend: "semantic", layerNames: ["文字", "文字背景框"], repairBackground: true });
    const executor = getExecutor("image_generation")!;
    await expect(executor(jobId, {}, executorContext(row, assets.admin) as never))
      .resolves.toMatchObject({ layers: [{ kind: "background" },
        { kind: "element", name: "文字" }, { kind: "element", name: "文字背景框" }] });
    expect(generateImage).toHaveBeenCalledTimes(3);
  });
  it("stops semantic stages after an unknown paid result instead of charging the next stage", async () => {
    const jobId = randomUUID(); const workspaceId = randomUUID();
    const model = "workspace:77777777-7777-4777-8777-777777777777";
    const assets = memoryAssets();
    vi.mocked(getImageProviderAttempts).mockReturnValue([{ ordinal: 0,
      providerName: "test-provider", modelId: model,
      upstreamModelId: "gpt-image-2.5-flare" }]);
    let calls = 0;
    vi.mocked(generateImage).mockImplementation(async () => {
      calls++;
      if (calls === 2) throw Object.assign(new Error("provider timeout"), { code: "timeout" });
      return { url: semanticLeftDataUri, mimeType: "image/png", width: 32, height: 16 };
    });
    const row = imageJob({ jobId, workspaceId, target: null,
      operation: "split_layers", model, inputImages: [semanticSourceDataUri],
      layerBackend: "semantic", layerNames: ["left", "right"], repairBackground: true });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);
    await expect(executor(jobId, {}, context as never)).rejects.toThrow("provider timeout");
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown" });
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(assets.objects.has(`${workspaceId}/generated/${jobId}-semantic-layer-stage-2-checkpoint.json`)).toBe(false);
  });
  it("does not deliver opaque semantic foregrounds or call later stages", async () => {
    const jobId = randomUUID(); const workspaceId = randomUUID();
    const model = "workspace:77777777-7777-4777-8777-777777777777";
    const assets = memoryAssets();
    vi.mocked(getImageProviderAttempts).mockReturnValue([{ ordinal: 0,
      providerName: "test-provider", modelId: model,
      upstreamModelId: "gpt-image-2.5-flare" }]);
    vi.mocked(generateImage).mockResolvedValue({ url: semanticSourceDataUri,
      mimeType: "image/png", width: 32, height: 16 });
    const row = imageJob({ jobId, workspaceId, target: null,
      operation: "split_layers", model, inputImages: [semanticSourceDataUri],
      layerBackend: "semantic", layerNames: ["left", "right"], repairBackground: true });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "background_removal_invalid_output" });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "background_removal_invalid_output" });
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
  it("archives one paid local repaint and restores exact source dimensions after final upload interruption", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    assets.failNextUploadEnding(`${jobId}.png`);
    const row = imageJob({
      jobId,
      workspaceId,
      target: {
        kind: "canvas",
        canvas_id: "77777777-7777-4777-8777-777777777777",
        element_id: "outpaint-placeholder-1",
      },
      operation: "local_repaint",
      inputImages: [pngDataUri],
      maskImage: repaintMaskDataUri,
    });
    vi.mocked(generateImage).mockResolvedValue({
      url: mismatchedPortraitPngDataUri,
      mimeType: "image/png",
      width: 8,
      height: 12,
    });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);

    await expect(executor(jobId, {}, context as never)).rejects.toThrow(
      "Storage upload failed",
    );
    await expect(executor(jobId, {}, context as never)).resolves.toMatchObject({
      width: 7,
      height: 5,
      mime_type: "image/png",
    });
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage).toHaveBeenCalledWith(
      "test-provider",
      expect.objectContaining({
        prompt: expect.stringContaining("A durable image"),
        inputImages: [expect.stringMatching(/^data:image\/png;base64,/)],
        maskImage: expect.stringMatching(/^data:image\/png;base64,/),
        aspectRatio: "7:5",
        outputFormat: "png",
      }),
    );
    expect(
      assets.objects.has(
        `${workspaceId}/generated/${jobId}-source-before-matting.png`,
      ),
    ).toBe(true);
  });

  it("archives direct outpaint once and preserves the provider result without compositing", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    assets.failNextUploadEnding(`${jobId}.png`);
    const margins = { top: 1, right: 2, bottom: 3, left: 4 };
    const row = imageJob({
      jobId,
      workspaceId,
      target: {kind:"canvas",canvas_id:"77777777-7777-4777-8777-777777777777",element_id:"outpaint-placeholder-1"},
      operation: "outpaint",
      inputImages: [pngDataUri],
      outpaintMargins: margins,
    });
    vi.mocked(generateImage).mockResolvedValue({
      url: mismatchedPortraitPngDataUri,
      mimeType: "image/png",
      width: 8,
      height: 12,
    });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);

    await expect(executor(jobId, {}, context as never)).rejects.toThrow(
      "Storage upload failed",
    );
    const result = await executor(jobId, {}, context as never);

    expect(result).toMatchObject({
      width: 8,
      height: 12,
      mime_type: "image/png",
      operation: "outpaint",
    });
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage).toHaveBeenCalledWith(
      "test-provider",
      expect.objectContaining({
        model: "test-image-model",
        aspectRatio: "16:16",
        outputWidth: 16,
        outputHeight: 16,
        background: "opaque",
        outputFormat: "png",
        inputImages: [expect.stringMatching(/^data:image\/png;base64,/)],
      }),
    );
    const providerRequest = vi.mocked(generateImage).mock.calls[0]![1];
    expect(providerRequest.prompt).toContain("扩展到");
    expect(providerRequest).not.toHaveProperty("maskImage");

    const output = assets.objects.get(String(result.object_path));
    expect(output).toBeDefined();
    const sourcePixels = await sharp(
      Buffer.from(mismatchedPortraitPngDataUri.split(",")[1]!, "base64"),
    ).ensureAlpha().raw().toBuffer();
    const outputPixels = await sharp(output!).ensureAlpha().raw().toBuffer();
    expect(outputPixels).toEqual(sourcePixels);
  });
  it("does not begin paid foreground processing after cancellation during generation", async () => {
    const jobId = randomUUID();
    const assets = memoryAssets();
    const row = imageJob({ jobId, workspaceId: randomUUID(), target: designSubjectTarget(), foregroundPolicy: apiForegroundPolicy() });
    let canceled = false;
    vi.mocked(generateImage).mockImplementationOnce(async () => {
      canceled = true;
      return { url: pngDataUri, mimeType: "image/png", width: 7, height: 5 };
    });
    const context = { getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => ({ ...row, ...(canceled ? { status: "canceled" } : {}) }) }, renewVt: vi.fn() };
    await expect(getExecutor("image_generation")!(jobId, {}, context as never)).rejects.toMatchObject({ code: "job_canceled" });
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
  it("does not begin a fallback after cancellation during the first provider", async () => {
    vi.mocked(getImageProviderAttempts).mockReturnValue([
      { ordinal: 0, providerName: "first", modelId: "test-image-model", upstreamModelId: "test-image-model" },
      { ordinal: 1, providerName: "second", modelId: "test-image-model", upstreamModelId: "test-image-model" },
    ]);
    const jobId = randomUUID();
    const assets = memoryAssets();
    const row = imageJob({ jobId, workspaceId: randomUUID(), target: null });
    let canceled = false;
    vi.mocked(generateImage).mockImplementationOnce(async () => {
      canceled = true;
      throw Object.assign(new Error("no available channel"), { code: "provider_rejected" });
    });
    const context = { getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => ({ ...row, ...(canceled ? { status: "canceled" } : {}) }) }, renewVt: vi.fn() };
    await expect(getExecutor("image_generation")!(jobId, {}, context as never)).rejects.toMatchObject({ code: "job_canceled" });
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "unknown", "rejected"])("tries the fallback once after definite rejection, then %s without repeating paid calls", async outcome => {
    vi.mocked(getImageProviderAttempts).mockReturnValue([
      { ordinal: 0, providerName: "first", modelId: "test-image-model", upstreamModelId: "test-image-model" },
      { ordinal: 1, providerName: "second", modelId: "test-image-model", upstreamModelId: "test-image-model" },
    ]);
    const rejected = Object.assign(new Error("no available channel"), { code: "provider_rejected" });
    const provider = vi.mocked(generateImage).mockRejectedValueOnce(rejected);
    if (outcome === "success") provider.mockResolvedValueOnce({ url: pngDataUri, mimeType: "image/png", width: 7, height: 5 });
    else provider.mockRejectedValueOnce(outcome === "unknown" ? new Error("connection lost") : rejected);
    const jobId = randomUUID();
    const assets = memoryAssets();
    const refs = Array.from({ length: 9 }, (_, i) => `https://example.invalid/${i}.png`);
    const row = imageJob({ jobId, workspaceId: randomUUID(), target: null, inputImages: refs });
    const context = { getAdminClient: () => assets.admin, jobService: { getJobAdmin: async () => row }, renewVt: vi.fn() };
    const invoke = () => getExecutor("image_generation")!(jobId, {}, context as never);
    if (outcome === "success") {
      await expect(invoke()).resolves.toMatchObject({ provider_attempt: 2, provider_fallback_used: true });
      await expect(invoke()).resolves.toMatchObject({ provider_attempt: 2 });
    } else {
      const code = outcome === "unknown" ? "image_generation_result_unknown" : "provider_rejected";
      await expect(invoke()).rejects.toMatchObject({ code });
      await expect(invoke()).rejects.toMatchObject({ code });
    }
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls.map(call => call[0])).toEqual(["first", "second"]);
    expect(provider.mock.calls[0]![1]).toEqual(provider.mock.calls[1]![1]);
    expect(provider.mock.calls[1]![1].inputImages).toEqual(refs);
  });

  it("carries a real SDK 401 through provider classification and a rejected checkpoint before one fallback call", async () => {
    vi.mocked(getImageProviderAttempts).mockReturnValue([
      { ordinal: 0, providerName: "first", modelId: "nano-banana-2", upstreamModelId: "nano-banana-2" },
      { ordinal: 1, providerName: "second", modelId: "nano-banana-2", upstreamModelId: "nano-banana-2" },
    ]);
    let providerRequests = 0;
    const fetchMock = vi.fn(async (_request: unknown, _init?: unknown) => {
      providerRequests += 1;
      return providerRequests === 1
        ? new Response(JSON.stringify({ error: {
            code: "invalid_api_key", type: "authentication_error", message: "channel credential rejected",
          } }), { status: 401, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ data: [{ url: pngDataUri }] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sdkProvider = new OpenAIImageProvider("test-key");
    vi.mocked(generateImage).mockImplementation((_providerName, request) => sdkProvider.generate(request));
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const row = imageJob({ jobId, workspaceId, target: null, model: "nano-banana-2" });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);

    await expect(executor(jobId, {}, context as never)).resolves.toMatchObject({
      provider_attempt: 2,
      provider_fallback_used: true,
    });
    await expect(executor(jobId, {}, context as never)).resolves.toMatchObject({ provider_attempt: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(assets.objects.get(
      `${workspaceId}/generated/${jobId}-image-generation-checkpoint.json`,
    )!.toString())).toMatchObject({ status: "rejected", errorCode: "provider_rejected" });
    expect(JSON.parse(assets.objects.get(
      `${workspaceId}/generated/${jobId}-image-generation-attempt-1-checkpoint.json`,
    )!.toString())).toMatchObject({ status: "archived", attemptOrdinal: 1 });
  });

  it("keeps one real SDK 404 rejection terminal for a single-candidate plan without calling again on recovery", async () => {
    vi.mocked(getImageProviderAttempts).mockReturnValue([
      { ordinal: 0, providerName: "only", modelId: "nano-banana-2", upstreamModelId: "nano-banana-2" },
    ]);
    const fetchMock = vi.fn(async (_request: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ error: {
        code: "model_not_found", type: "not_found_error", message: "channel model route missing",
      } }), { status: 404, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sdkProvider = new OpenAIImageProvider("test-key");
    vi.mocked(generateImage).mockImplementation((_providerName, request) => sdkProvider.generate(request));
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const row = imageJob({ jobId, workspaceId, target: null, model: "nano-banana-2" });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);

    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({ code: "provider_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ordinary image", null, undefined, "test-image-model", () => pngDataUri],
    [
      "design background",
      {
        kind: "design",
        design_id: "33333333-3333-4333-8333-333333333333",
        expected_revision: 4,
        idempotency_key: "44444444-4444-4444-8444-444444444444",
        placement: { x: 0, y: 0, role: "background" },
      },
      undefined,
      "test-image-model",
      () => pngDataUri,
    ],
    [
      "design subject",
      {
        kind: "design",
        design_id: "55555555-5555-4555-8555-555555555555",
        expected_revision: 5,
        idempotency_key: "66666666-6666-4666-8666-666666666666",
        placement: { x: 12, y: 24, role: "product" },
      },
      nativeForegroundPolicy(),
      "gpt-image-2",
      () => transparentPngDataUri,
    ],
  ])("does not call the provider again when %s source storage is retried", async (_label, target, foregroundPolicy, model, resultUrl) => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: resultUrl(),
      mimeType: "image/png",
      width: 7,
      height: 5,
    });
    const row = imageJob({
      jobId,
      workspaceId,
      target,
      model,
      ...(foregroundPolicy ? { foregroundPolicy } : {}),
    });
    const context = {
      getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => row },
      renewVt: vi.fn(),
    };
    const executor = getExecutor("image_generation")!;

    assets.failNextSourceUpload();
    await expect(executor(jobId, {}, context as never)).rejects.toThrow(
      "Storage upload failed",
    );
    expect(provider).toHaveBeenCalledTimes(1);
    const checkpointPath = `${workspaceId}/generated/${jobId}-image-generation-checkpoint.json`;
    expect(JSON.parse(assets.objects.get(checkpointPath)!.toString())).toMatchObject({
      status: "returned",
      result: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });

    const result = await executor(jobId, {}, context as never);
    expect(result).toMatchObject({ width: 7, height: 5, mime_type: "image/png" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(assets.objects.get(checkpointPath)!.toString())).toMatchObject({
      status: "archived",
      assetId: generationSourceAssetBinding(
        workspaceId,
        jobId,
        "image-generation-source",
      ).assetId,
      objectPath: generationSourceAssetBinding(
        workspaceId,
        jobId,
        "image-generation-source",
      ).objectPath,
    });
  });

  it("does not repeat either paid call when two-stage source storage is retried", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage)
      .mockResolvedValueOnce({ url: pngDataUri, mimeType: "image/png", width: 7, height: 5 })
      .mockResolvedValueOnce({ url: transparentPngDataUri, mimeType: "image/png", width: 7, height: 5 });
    const row = imageJob({
      jobId,
      workspaceId,
      target: designSubjectTarget(),
      foregroundPolicy: apiForegroundPolicy(),
    });
    const context = executorContext(row, assets.admin);
    const executor = getExecutor("image_generation")!;

    assets.failNextSourceUpload();
    await expect(executor(jobId, {}, context as never)).rejects.toThrow("Storage upload failed");
    await expect(executor(jobId, {}, context as never)).resolves.toMatchObject({
      width: 7,
      height: 5,
      mime_type: "image/png",
    });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls.map(([, request]) => request.model)).toEqual([
      "test-image-model",
      "gpt-image-2",
    ]);
  });

  it("passes explicit transparency to the provider without a second matting call", async () => {
    const jobId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({ url: transparentPngDataUri, mimeType: "image/png", width: 7, height: 5 });
    const row = imageJob({ jobId, workspaceId: randomUUID(), target: null });
    Object.assign(row.payload, { background: "transparent", output_format: "jpg" });
    await getExecutor("image_generation")!(jobId, {}, executorContext(row, assets.admin) as never);
    expect(provider).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ background: "transparent", outputFormat: "png" }));
  });

  it.each(["opaque", "empty"])("rejects a native transparent request's %s result without repeating the paid call", async (kind) => {
    const jobId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: kind === "opaque" ? pngDataUri : emptyPngDataUri,
      mimeType: "image/png", width: 7, height: 5,
    });
    const row = imageJob({ jobId, workspaceId: randomUUID(), target: null });
    Object.assign(row.payload, { background: "transparent", output_format: "png" });
    const context = executorContext(row, assets.admin);
    const executor = getExecutor("image_generation")!;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({ code: "background_removal_invalid_output" });
    }
    expect(provider).toHaveBeenCalledOnce();
    expect([...assets.objects.keys()].some(path => path.endsWith("-source-before-matting.png"))).toBe(true);
    expect([...assets.objects.keys()].some(path => path.endsWith(`-${jobId}.png`))).toBe(false);
  });

  it("delivers a mismatched source at actual dimensions without repeating the paid call", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: mismatchedPortraitPngDataUri, mimeType: "image/png", width: 1024, height: 1280,
    });
    const row = imageJob({ jobId, workspaceId, target: null, aspectRatio: "4:5" });
    const executor = getExecutor("image_generation")!;
    const context = executorContext(row, assets.admin);

    const result = await executor(jobId, {}, context as never);
    expect(result).toMatchObject({ width: 8, height: 12 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect([...assets.objects.keys()].some(path => path.endsWith("-source-before-matting.png"))).toBe(true);
    expect([...assets.objects.keys()].some(path => path.endsWith(`-${jobId}.png`))).toBe(true);
  });

  it("does not repeat either paid call when two-stage matte storage is retried", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage)
      .mockResolvedValueOnce({ url: pngDataUri, mimeType: "image/png", width: 7, height: 5 })
      .mockResolvedValueOnce({ url: transparentPngDataUri, mimeType: "image/png", width: 7, height: 5 });
    const row = imageJob({
      jobId,
      workspaceId,
      target: designSubjectTarget(),
      foregroundPolicy: apiForegroundPolicy(),
    });
    const context = executorContext(row, assets.admin);
    const executor = getExecutor("image_generation")!;

    assets.failNextUploadEnding("-design-foreground.png");
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_postprocess_failed",
    });
    await expect(executor(jobId, {}, context as never)).resolves.toMatchObject({
      width: 7,
      height: 5,
      mime_type: "image/png",
    });

    expect(provider).toHaveBeenCalledTimes(2);
    const checkpointPath = `${workspaceId}/generated/${jobId}-design-foreground-checkpoint.json`;
    expect(JSON.parse(assets.objects.get(checkpointPath)!.toString())).toMatchObject({
      status: "archived",
      variant: "design-foreground-matting",
    });
  });

  it("does not repeat an unknown paid matting call", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage)
      .mockResolvedValueOnce({ url: pngDataUri, mimeType: "image/png", width: 7, height: 5 })
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { code: "timeout" }));
    const row = imageJob({
      jobId,
      workspaceId,
      target: designSubjectTarget(),
      foregroundPolicy: apiForegroundPolicy(),
    });
    const context = executorContext(row, assets.admin);
    const executor = getExecutor("image_generation")!;

    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown",
    });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown",
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("rejects legacy design foreground jobs without a confirmed policy before a paid call", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: pngDataUri,
      mimeType: "image/png",
      width: 7,
      height: 5,
    });
    const row = imageJob({ jobId, workspaceId, target: designSubjectTarget() });

    await expect(
      getExecutor("image_generation")!(jobId, {}, executorContext(row, assets.admin) as never),
    ).rejects.toMatchObject({ code: "foreground_policy_required" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("uses one native transparent call and never falls back after alpha validation fails", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: pngDataUri,
      mimeType: "image/png",
      width: 7,
      height: 5,
    });
    const row = imageJob({
      jobId,
      workspaceId,
      target: designSubjectTarget(),
      model: "gpt-image-2",
      foregroundPolicy: nativeForegroundPolicy(),
    });
    const context = executorContext(row, assets.admin);
    const executor = getExecutor("image_generation")!;

    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "background_removal_invalid_output",
    });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "background_removal_invalid_output",
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("test-provider", expect.objectContaining({
      model: "gpt-image-2",
      background: "transparent",
      outputFormat: "png",
    }));
  });

  it("stops after an upstream timeout whose provider outcome cannot be known", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi
      .mocked(generateImage)
      .mockRejectedValue(Object.assign(new Error("gateway timeout"), { code: "timeout" }));
    const row = imageJob({ jobId, workspaceId, target: null });
    const context = {
      getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => row },
      renewVt: vi.fn(),
    };
    const executor = getExecutor("image_generation")!;

    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown",
    });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit preflight invalid-input rejection", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    vi.mocked(generateImage).mockRejectedValue(
      Object.assign(new Error("invalid aspect ratio"), { code: "invalid_input" }),
    );
    const row = imageJob({ jobId, workspaceId, target: null });
    const executor = getExecutor("image_generation")!;
    await expect(
      executor(jobId, {}, {
        getAdminClient: () => assets.admin,
        jobService: { getJobAdmin: async () => row },
        renewVt: vi.fn(),
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("retries paid background-removal storage without another provider call", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: transparentPngDataUri,
      mimeType: "image/png",
      width: 7,
      height: 5,
    });
    const row = imageJob({
      jobId,
      workspaceId,
      target: null,
      operation: "remove_background",
      model: "gpt-image-2",
      inputImages: [pngDataUri],
    });
    const context = {
      getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => row },
      renewVt: vi.fn(),
    };
    const executor = getExecutor("image_generation")!;

    assets.failNextUploadEnding("-0-foreground.png");
    await expect(executor(jobId, {}, context as never)).rejects.toThrow(
      "Storage upload failed",
    );
    const checkpointPath = `${workspaceId}/generated/${jobId}-background-removal-checkpoint.json`;
    expect(JSON.parse(assets.objects.get(checkpointPath)!.toString())).toMatchObject({
      status: "returned",
      variant: "background-removal-foreground",
      result: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });

    await expect(executor(jobId, {}, context as never)).resolves.toMatchObject({
      operation: "remove_background",
      model: "gpt-image-2",
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(assets.objects.get(checkpointPath)!.toString())).toMatchObject({
      status: "archived",
      assetId: generationSourceAssetBinding(
        workspaceId,
        jobId,
        "background-removal-foreground",
      ).assetId,
    });
  });

  it("stops paid background removal after an unknown upstream timeout", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi
      .mocked(generateImage)
      .mockRejectedValue(Object.assign(new Error("gateway timeout"), { code: "timeout" }));
    const row = imageJob({
      jobId,
      workspaceId,
      target: null,
      operation: "remove_background",
      model: "gpt-image-2",
      inputImages: [pngDataUri],
    });
    const context = {
      getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => row },
      renewVt: vi.fn(),
    };
    const executor = getExecutor("image_generation")!;

    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown",
    });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "image_generation_result_unknown",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", () => emptyPngDataUri],
    ["opaque", () => pngDataUri],
  ])("keeps an explicitly invalid %s alpha result terminal without repaying", async (_label, resultUrl) => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const assets = memoryAssets();
    const provider = vi.mocked(generateImage).mockResolvedValue({
      url: resultUrl(),
      mimeType: "image/png",
      width: 7,
      height: 5,
    });
    const row = imageJob({
      jobId,
      workspaceId,
      target: null,
      operation: "remove_background",
      model: "gpt-image-2",
      inputImages: [pngDataUri],
    });
    const context = {
      getAdminClient: () => assets.admin,
      jobService: { getJobAdmin: async () => row },
      renewVt: vi.fn(),
    };
    const executor = getExecutor("image_generation")!;

    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "background_removal_invalid_output",
    });
    await expect(executor(jobId, {}, context as never)).rejects.toMatchObject({
      code: "background_removal_invalid_output",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

function imageJob(input: {
  jobId: string;
  workspaceId: string;
  target: Record<string, unknown> | null;
  operation?: string;
  layerBackend?: string;
  layerNames?: string[];
  repairBackground?: boolean;
  model?: string;
  inputImages?: string[];
  maskImage?: string;
  foregroundPolicy?: Record<string, unknown>;
  aspectRatio?: string;
  outpaintMargins?: { top: number; right: number; bottom: number; left: number };
}) {
  const now = new Date().toISOString();
  return {
    id: input.jobId,
    workspace_id: input.workspaceId,
    project_id: null,
    canvas_id:
      input.target?.kind === "canvas" ? String(input.target.canvas_id) : null,
    target_kind:
      input.target?.kind === "canvas"
        ? "canvas"
        : input.target?.kind === "design"
          ? "design"
          : null,
    design_id:
      input.target?.kind === "design" ? String(input.target.design_id) : null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "running",
    payload: {
      prompt: "A durable image",
      model: input.model ?? "test-image-model",
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.layerBackend ? { layer_backend: input.layerBackend } : {}),
      ...(input.layerNames ? { layer_names: input.layerNames } : {}),
      ...(input.repairBackground ? { repair_background: input.repairBackground } : {}),
      ...(input.inputImages ? { input_images: input.inputImages } : {}),
      ...(input.maskImage ? { mask_image: input.maskImage } : {}),
      ...(input.foregroundPolicy ? { foreground_policy: input.foregroundPolicy } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.outpaintMargins
        ? { outpaint_margins: input.outpaintMargins }
        : {}),
      target: input.target,
    },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: randomUUID(),
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}

function designSubjectTarget() {
  return {
    kind: "design",
    design_id: "55555555-5555-4555-8555-555555555555",
    expected_revision: 5,
    idempotency_key: "66666666-6666-4666-8666-666666666666",
    placement: { x: 12, y: 24, role: "product" },
  };
}

function nativeForegroundPolicy() {
  return {
    version: 1,
    mode: "native_transparent",
    generationModel: "gpt-image-2",
    mattingModel: "gpt-image-2",
    generationCredits: 10,
    mattingCredits: 0,
    totalCredits: 10,
    pricingVersion: "credits-v1",
  };
}

function apiForegroundPolicy() {
  return {
    version: 1,
    mode: "api_matting",
    generationModel: "test-image-model",
    mattingModel: "gpt-image-2",
    generationCredits: 10,
    mattingCredits: 10,
    totalCredits: 20,
    pricingVersion: "credits-v1",
  };
}

function executorContext(row: ReturnType<typeof imageJob>, admin: ReturnType<typeof memoryAssets>["admin"]) {
  return {
    getAdminClient: () => admin,
    jobService: { getJobAdmin: async () => row },
    renewVt: vi.fn(),
  };
}

function memoryAssets() {
  const records = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, Buffer>();
  let failingUploadSuffix: string | null = null;
  const upload = vi.fn(
    async (path: string, bytes: Buffer, options: { upsert: boolean }) => {
      if (failingUploadSuffix && path.endsWith(failingUploadSuffix)) {
        failingUploadSuffix = null;
        return { error: { message: "simulated source storage interruption" } };
      }
      if (!options.upsert && objects.has(path)) {
        return { error: { statusCode: "409", message: "resource already exists" } };
      }
      objects.set(path, Buffer.from(bytes));
      return { error: null };
    },
  );
  const download = vi.fn(async (path: string) => {
    const bytes = objects.get(path);
    return bytes
      ? { data: new Blob([bytes]), error: null }
      : { data: null, error: { statusCode: "404", message: "not found" } };
  });
  const createSignedUrl = vi.fn(async (path: string) => ({
    data: { signedUrl: `https://private.test/${path}` },
    error: null,
  }));
  const admin = {
    storage: { from: vi.fn(() => ({ upload, download, createSignedUrl })) },
    from: vi.fn((table: string) => {
      if (table === "subscriptions") return subscriptionQuery();
      return assetQuery(records);
    }),
  };
  return {
    admin,
    objects,
    failNextSourceUpload: () => {
      failingUploadSuffix = "-source-before-matting.png";
    },
    failNextUploadEnding: (suffix: string) => {
      failingUploadSuffix = suffix;
    },
  };
}

function subscriptionQuery() {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: { plan: "pro" }, error: null })),
  };
  return query;
}

function assetQuery(records: Map<string, Record<string, unknown>>) {
  let selectedId = "";
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((_key: string, value: string) => {
      selectedId = value;
      return query;
    }),
    maybeSingle: vi.fn(async () => ({
      data: records.get(selectedId) ?? null,
      error: null,
    })),
    upsert: vi.fn((row: Record<string, unknown>) => {
      records.set(String(row.id), {
        deletion_pending_at: null,
        ...structuredClone(row),
      });
      return {
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: row, error: null })),
        })),
      };
    }),
    insert: vi.fn((row: Record<string, unknown>) => {
      const saved = { id: randomUUID(), ...structuredClone(row) };
      records.set(String(saved.id), saved);
      return {
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: saved, error: null })),
        })),
      };
    }),
  };
  return query;
}
