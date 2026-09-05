import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiYiVideoProvider } from "./apiyi-video.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ApiYiVideoProvider", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the documented JSON fields for text-to-video", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "task-1", status: "queued" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "task-1", status: "completed" }),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([0, 1, 2, 3]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      );

    const provider = new ApiYiVideoProvider(
      "secret",
      "https://api.apiyi.com/v1/",
    );
    const result = await provider.generate({
      model: "veo-3.1-fast-generate-preview",
      prompt: "A paper crane takes flight",
      duration: 6,
      resolution: "720p",
      aspectRatio: "9:16",
    });

    expect(result).toMatchObject({
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
      durationSeconds: 6,
    });
    expect(result.url).toBe("data:video/mp4;base64,AAECAw==");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.apiyi.com/v1/videos");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "veo-3.1-fast-generate-preview",
      prompt: "A paper crane takes flight",
      duration: "6",
      size: "720x1280",
      metadata: { resolution: "720p", aspectRatio: "9:16" },
    });
  });

  it("uploads a single reference image as input_reference multipart data", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "task-2", status: "queued" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "task-2", status: "completed" }),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([4, 5]), { status: 200 }),
      );

    const provider = new ApiYiVideoProvider(
      "secret",
      "https://api.apiyi.com/v1",
    );
    await provider.generate({
      model: "veo-3.1-fast-generate-preview",
      prompt: "Animate the reference",
      inputImages: ["data:image/png;base64,iVBORw0KGgo="],
      duration: 8,
      resolution: "1080p",
      aspectRatio: "16:9",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("veo-3.1-fast-generate-preview");
    expect(form.get("duration")).toBe("8");
    expect(form.get("resolution")).toBe("1080p");
    expect(form.get("aspectRatio")).toBe("16:9");
    expect(form.get("size")).toBe("1920x1080");
    expect(form.get("input_reference")).toBeInstanceOf(Blob);
  });

  it("rejects unsupported short 1080p requests before submission", async () => {
    const provider = new ApiYiVideoProvider(
      "secret",
      "https://api.apiyi.com/v1",
    );

    await expect(
      provider.generate({
        model: "veo-3.1-fast-generate-preview",
        prompt: "A short clip",
        duration: 4,
        resolution: "1080p",
      }),
    ).rejects.toMatchObject({
      provider: "apiyi",
      code: "invalid_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
