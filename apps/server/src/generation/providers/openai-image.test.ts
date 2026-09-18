import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateMock, editMock, toFileMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  editMock: vi.fn(),
  toFileMock: vi.fn((_: Buffer, name: string, options: { type: string }) => ({ name, ...options })),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    images = { generate: generateMock, edit: editMock };
  },
  toFile: toFileMock,
}));

import { OpenAIImageProvider } from "./openai-image.js";

describe("OpenAIImageProvider API易 transport", () => {
  it("forwards a local repaint alpha mask through the edit endpoint", async () => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({
      model: "gpt-image-2",
      prompt: "Replace the selected flower",
      inputImages: ["data:image/png;base64,iVBORw0KGgo="],
      maskImage: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(editMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-image-2",
        mask: expect.objectContaining({ name: "mask.png", type: "image/png" }),
      }),
      { timeout: 360_000, maxRetries: 0 },
    );
    expect(toFileMock).toHaveBeenCalledTimes(2);
  });
  it("sends native transparent PNG parameters through the edit endpoint", async () => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2", prompt: "Remove background", background: "transparent", outputFormat: "png", inputImages: ["data:image/png;base64,iVBORw0KGgo="] });
    expect(editMock).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-2", background: "transparent", output_format: "png" }), { timeout: 360_000, maxRetries: 0 });
    expect(generateMock).not.toHaveBeenCalled();
  });
  it.each(["gpt-image-2-all", "gpt-image-2-vip", "nano-banana-2"])("forwards transparency on %s to the selected endpoint", async (model) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model, prompt: "Transparent logo", background: "transparent", outputFormat: "png" });
    expect(generateMock).toHaveBeenCalledWith(expect.objectContaining({ model, background: "transparent", output_format: "png" }), expect.anything());
    await provider.generate({ model, prompt: "Transparent logo", background: "transparent", outputFormat: "png", inputImages: ["data:image/png;base64,iVBORw0KGgo="] });
    expect(editMock).toHaveBeenCalledWith(expect.objectContaining({ model, background: "transparent", output_format: "png" }), expect.anything());
  });
  it("rejects more than 16 GPT Image 2 references before calling the provider", async () => {
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({
      model: "gpt-image-2",
      prompt: "Combine references",
      inputImages: Array.from({ length: 17 }, () => "data:image/png;base64,iVBORw0KGgo="),
    })).rejects.toMatchObject({ code: "image_reference_limit_exceeded" });
    expect(editMock).not.toHaveBeenCalled();
  });
  it("keeps a compatible nine-reference edit bounded to one request", async () => {
    const provider = new OpenAIImageProvider("key");
    const references = Array.from(
      { length: 9 },
      () => "data:image/png;base64,iVBORw0KGgo=",
    );
    await provider.generate({
      model: "gpt-image-2",
      prompt: "Preserve the supplied composition",
      aspectRatio: "16:9",
      quality: "hd", resolution: "2k",
      inputImages: references,
    });

    expect(editMock).toHaveBeenCalledTimes(1);
    const [request] = editMock.mock.calls[0]!;
    expect(request).toMatchObject({
      model: "gpt-image-2",
      quality: "medium",
      size: "2048x1152",
      n: 1,
    });
    expect(request.prompt).toContain("Preserve the supplied composition");
    expect(request.image).toHaveLength(9);
    expect(request.image.map((item: { name?: string }) => item.name)).toEqual(
      references.map((_, index) => `input-${index}.png`),
    );
    expect(generateMock).not.toHaveBeenCalled();
  });
  it.each([
    ["generation", generateMock, undefined],
    ["editing", editMock, ["data:image/png;base64,iVBORw0KGgo="]],
  ])("disables SDK retries for Nano Banana 2 %s at the paid provider boundary", async (_label, requestMock, inputImages) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({
      model: "nano-banana-2",
      prompt: "Keep this request single-attempt",
      ...(inputImages ? { inputImages } : {}),
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]![1]).toEqual({ maxRetries: 0 });
  });
  it("rejects a GPT Image 2 prompt over 32,000 characters before calling the provider", async () => {
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({
      model: "gpt-image-2",
      prompt: "x".repeat(32_001),
    })).rejects.toMatchObject({ code: "image_prompt_too_long" });
    expect(generateMock).not.toHaveBeenCalled();
  });
  it("classifies the gateway's explicit no-channel rejection as no provider result", async () => {
    generateMock.mockRejectedValueOnce(Object.assign(
      new Error("503 No available channel for gpt-image-2"),
      { status: 503, code: "thirdparty503" },
    ));
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({ model: "gpt-image-2", prompt: "Logo" }))
      .rejects.toMatchObject({ code: "provider_rejected" });
  });
  it("recognizes the legacy gateway rejection fingerprint even when its structured code is lost", async () => {
    generateMock.mockRejectedValueOnce(new Error(
      "503 获取分组 default 下模型 gpt-image-2 的可用渠道失败（distributor）: no available channel for model_name: gpt-image-2",
    ));
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({ model: "gpt-image-2", prompt: "Logo" }))
      .rejects.toMatchObject({ code: "provider_rejected" });
  });
  it("keeps an ordinary provider 503 outcome unknown", async () => {
    generateMock.mockRejectedValueOnce(Object.assign(
      new Error("503 upstream unavailable"),
      { status: 503, code: "server_error" },
    ));
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({ model: "gpt-image-2", prompt: "Logo" }))
      .rejects.toMatchObject({ code: "api_error" });
  });
  it.each([["3:1", "2048x688"], ["1:3", "688x2048"], ["1:1", "2048x2048"]])("resolves native 2k ratio %s without cropping", async (aspectRatio, size) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2", prompt: "Ocean background", aspectRatio, resolution: "2k" });
    expect(generateMock.mock.calls[0]![0].size).toBe(size);
  });
  beforeEach(() => {
    generateMock.mockReset();
    editMock.mockReset();
    toFileMock.mockClear();
    generateMock.mockResolvedValue({
      data: [{ url: "https://example.com/generated.png" }],
    });
    editMock.mockResolvedValue({
      data: [{ url: "https://example.com/edited.png" }],
    });
  });

  it("requests a lightweight URL and allows the documented long tail", async () => {
    const provider = new OpenAIImageProvider("key", "https://api.example/v1");

    await provider.generate({
      model: "gpt-image-2-all",
      prompt: "生成 Logo",
      aspectRatio: "1:1",
      quality: "hd", resolution: "2k",
    });

    expect(generateMock).toHaveBeenCalledWith(
      {
        model: "gpt-image-2-all",
        prompt: expect.stringContaining("square 1:1, aspect ratio 1:1 (width:height)"),
        response_format: "url",
        quality: "medium",
      },
      { timeout: 300_000, maxRetries: 0 },
    );
  });

  it.each(["16:9", "9:16", "3:2"])("preserves requested %s instead of rounding to native size presets", async (aspectRatio) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2-all", prompt: "Keep brand ABC", aspectRatio });
    const request = generateMock.mock.calls[0]![0];
    expect(request.prompt).toContain("Keep brand ABC");
    expect(request.prompt).toContain(`aspect ratio ${aspectRatio} (width:height)`);
    expect(request).not.toHaveProperty("size");
  });

  it("does not force APIYI point-release all models from 4:5 to the generic 2:3 portrait preset", async () => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2.5-all", prompt: "Mellow Coffee poster", aspectRatio: "4:5", quality: "hd" });
    expect(generateMock).toHaveBeenCalledWith({
      model: "gpt-image-2.5-all",
      prompt: expect.stringContaining("portrait 4:5, aspect ratio 4:5 (width:height)"),
      response_format: "url",
      quality: "medium",
    }, { timeout: 300_000, maxRetries: 0 });
    expect(generateMock.mock.calls[0]![0]).not.toHaveProperty("size");
  });

  it("carries the same ratio constraint into reference image edits", async () => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2-all", prompt: "Keep the subject", aspectRatio: "9:16", inputImages: ["data:image/png;base64,iVBORw0KGgo="] });
    expect(editMock.mock.calls[0]![0].prompt).toContain("portrait 9:16, aspect ratio 9:16 (width:height)");
    expect(editMock.mock.calls[0]![0].prompt).toContain("Keep the subject");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("defaults to square when no ratio was supplied", async () => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2-all", prompt: "Logo" });
    expect(generateMock.mock.calls[0]![0].prompt).toContain("aspect ratio 1:1");
  });

  it.each(["0:1", "16:0", "NaN:1", "1:2:3"])("rejects invalid ratio %s before requesting the provider", async (aspectRatio) => {
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({ model: "gpt-image-2-all", prompt: "Logo", aspectRatio })).rejects.toMatchObject({ code: "invalid_input" });
    expect(generateMock).not.toHaveBeenCalled();
    expect(editMock).not.toHaveBeenCalled();
  });

  it("sends the documented native 2K parameters to GPT Image 2", async () => {
    const provider = new OpenAIImageProvider("key", "https://api.example/v1");

    await provider.generate({
      model: "gpt-image-2",
      prompt: "generate a logo",
      aspectRatio: "1:1",
      quality: "hd",
      resolution: "2k",
    });

    expect(generateMock).toHaveBeenCalledWith(
      {
        model: "gpt-image-2",
        prompt: "generate a logo",
        size: "2048x2048",
        quality: "medium",
        n: 1,
      },
      { timeout: 360_000, maxRetries: 0 },
    );
  });

  it.each([
    [undefined, "low"],
    ["standard", "low"],
    ["hd", "medium"],
    ["ultra", "high"],
  ] as const)("maps the %s billing tier to OpenAI-compatible quality %s", async (quality, expectedQuality) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2", prompt: "quality mapping", ...(quality ? { quality } : {}) });
    expect(generateMock.mock.calls[0]![0]).toMatchObject({
      model: "gpt-image-2",
      quality: expectedQuality,
    });
  });

  it.each([
    ["standard", "low"],
    ["hd", "medium"],
    ["ultra", "high"],
  ] as const)("forwards %s as %s through the APIYI all branch", async (quality, expectedQuality) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2-all", prompt: "all quality mapping", quality });
    expect(generateMock.mock.calls[0]![0]).toMatchObject({
      model: "gpt-image-2-all",
      quality: expectedQuality,
    });
  });

  it.each(["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2-all"])("keeps raw quality and resolution independent for every %s matrix row", async (model) => {
    const provider = new OpenAIImageProvider("key");
    const expectedQuality = { standard: "low", hd: "medium", ultra: "high" } as const;
    for (const quality of ["standard", "hd", "ultra"] as const) for (const resolution of ["1k", "2k", "4k"] as const) {
      generateMock.mockClear();
      await provider.generate({ model, prompt: "matrix", quality, resolution, aspectRatio: "1:1" });
      const request = generateMock.mock.calls[0]![0];
      expect(request.quality).toBe(expectedQuality[quality]);
      if (model === "gpt-image-2-all") expect(request).not.toHaveProperty("size");
      else expect(request.size).toBeDefined();
    }
  });

  it("passes an exact 2K custom size through the GPT Image 2 edit endpoint", async () => {
    const provider = new OpenAIImageProvider("key", "https://api.example/v1");

    const result = await provider.generate({
      model: "gpt-image-2",
      prompt: "enhance details without changing composition",
      quality: "hd",
      outputWidth: 2048,
      outputHeight: 1168,
      inputImages: ["data:image/png;base64,iVBORw0KGgo="],
    });

    expect(editMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-image-2",
        size: "2048x1168",
        quality: "medium",
        n: 1,
      }),
      { timeout: 360_000, maxRetries: 0 },
    );
    expect(result).toMatchObject({ width: 2048, height: 1168 });
  });

  it.each(["gpt-image-2", "gpt-image-2-2026-09-01", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst-2026-09-01"]) ("uses native size and 360 second timeout for %s", async (model) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model, prompt: "native", aspectRatio: "16:9", resolution: "4k" });
    expect(generateMock).toHaveBeenCalledWith(expect.objectContaining({ size: "3840x2160", quality: "low" }), { timeout: 360_000, maxRetries: 0 });
  });

  it.each([["16:9", "1536x1024"], ["9:16", "1024x1536"]])("preserves non-native presets for %s", async (aspectRatio, size) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-1", prompt: "existing adapter", aspectRatio });
    expect(generateMock.mock.calls[0]![0]).toMatchObject({ size });
  });

  it("rejects invalid explicit native dimensions before calling the provider", async () => {
    const provider = new OpenAIImageProvider("key");
    await expect(provider.generate({ model: "gpt-image-2", prompt: "native", outputWidth: 1025, outputHeight: 1024 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(generateMock).not.toHaveBeenCalled();
  });
});
