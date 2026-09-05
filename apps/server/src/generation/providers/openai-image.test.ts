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
        prompt: "生成 Logo",
        response_format: "url",
      },
      { timeout: 300_000, maxRetries: 0 },
    );
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
