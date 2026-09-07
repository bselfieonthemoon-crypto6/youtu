import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateMock, editMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  editMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    images = { generate: generateMock, edit: editMock };
  },
  toFile: vi.fn(),
}));

import { OpenAIImageProvider } from "./openai-image.js";

describe("OpenAIImageProvider API易 transport", () => {
  it.each([["658:172", "2048x688"], ["172:658", "688x2048"], ["1:1", "2048x2048"]])("bounds native HD ratio %s without changing board geometry", async (aspectRatio, size) => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2", prompt: "Ocean background", aspectRatio, quality: "hd" });
    expect(generateMock.mock.calls[0]![0].size).toBe(size);
  });
  beforeEach(() => {
    generateMock.mockReset();
    editMock.mockReset();
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
      quality: "hd",
    });

    expect(generateMock).toHaveBeenCalledWith(
      {
        model: "gpt-image-2-all",
        prompt: expect.stringContaining("aspect ratio 1:1 (width:height), square image"),
        response_format: "url",
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

  it("carries the same ratio constraint into reference image edits", async () => {
    const provider = new OpenAIImageProvider("key");
    await provider.generate({ model: "gpt-image-2-all", prompt: "Keep the subject", aspectRatio: "9:16", inputImages: ["data:image/png;base64,iVBORw0KGgo="] });
    expect(editMock.mock.calls[0]![0].prompt).toContain("aspect ratio 9:16 (width:height), portrait image");
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
    });

    expect(generateMock).toHaveBeenCalledWith(
      {
        model: "gpt-image-2",
        prompt: "generate a logo",
        size: "2048x2048",
        quality: "high",
        n: 1,
      },
      { timeout: 360_000, maxRetries: 0 },
    );
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
        quality: "high",
        n: 1,
      }),
      { timeout: 360_000, maxRetries: 0 },
    );
    expect(result).toMatchObject({ width: 2048, height: 1168 });
  });
});
