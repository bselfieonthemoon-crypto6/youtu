import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIImageProvider } from "./openai-image.js";

function providerErrorResponse(code: string, message: string) {
  return new Response(JSON.stringify({
    error: { code, message, type: "provider_error" },
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAIImageProvider paid retry boundary with the real OpenAI SDK", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["ordinary ambiguous generation 503", "server_error", "upstream connection closed", "api_error", undefined, "/v1/images/generations"],
    ["explicit pre-dispatch no-channel rejection", "thirdparty503", "No available channel for nano-banana-2", "provider_rejected", undefined, "/v1/images/generations"],
    ["ordinary ambiguous edit 503", "server_error", "upstream connection closed", "api_error", ["data:image/png;base64,iVBORw0KGgo="], "/v1/images/edits"],
  ])("performs one HTTP request for Nano Banana 2 on %s", async (_label, upstreamCode, detail, expectedCode, inputImages, expectedPath) => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (request: unknown, _init?: unknown) =>
      String(request).startsWith("data:")
        ? nativeFetch(request as Parameters<typeof fetch>[0])
        : providerErrorResponse(upstreamCode, detail));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIImageProvider("test-key");

    await expect(provider.generate({
      model: "nano-banana-2",
      prompt: "One paid request only",
      ...(inputImages ? { inputImages } : {}),
    })).rejects.toMatchObject({ code: expectedCode });

    const providerRequests = fetchMock.mock.calls.filter(([request]) =>
      String(request).includes(expectedPath));
    expect(providerRequests).toHaveLength(1);
  });

  it.each([
    [401, "invalid_api_key", "authentication_error", "provider_rejected"],
    [404, "model_not_found", "not_found_error", "provider_rejected"],
    [429, "rate_limit_exceeded", "rate_limit_error", "provider_rate_limited"],
    [400, "invalid_request", "invalid_request_error", "invalid_input"],
    [403, "permission_denied", "permission_error", "invalid_input"],
    [422, "unprocessable_entity", "invalid_request_error", "invalid_input"],
    [400, "content_policy_violation", "invalid_request_error", "safety_filter"],
    [401, "content_filter", "authentication_error", "safety_filter"],
    [408, "request_timeout", "timeout_error", "api_error"],
    [409, "conflict", "conflict_error", "api_error"],
    [500, "server_error", "server_error", "api_error"],
  ])("classifies a structured HTTP %i response as %s/%s -> %s without an SDK retry", async (status, upstreamCode, type, expectedCode) => {
    const fetchMock = vi.fn(async (_request: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ error: {
        code: upstreamCode,
        type,
        message: `structured ${status} detail`,
      } }), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIImageProvider("test-key");

    await expect(provider.generate({ model: "nano-banana-2", prompt: "Classify only" }))
      .rejects.toMatchObject({ code: expectedCode, message: expect.stringContaining(`structured ${status} detail`) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a connection failure with no HTTP status unknown", async () => {
    const fetchMock = vi.fn(async (_request: unknown, _init?: unknown): Promise<Response> => {
      throw new TypeError("socket closed without a response");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIImageProvider("test-key");

    await expect(provider.generate({ model: "nano-banana-2", prompt: "Do not repeat" }))
      .rejects.toMatchObject({ code: "api_error", message: expect.stringContaining("Connection error") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
