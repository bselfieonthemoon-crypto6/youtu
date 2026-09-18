import { describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch, MockAgent, Request as UndiciRequest } from "undici";
import OpenAI, { toFile } from "openai";

import {
  createSafeProviderFetch,
  normalizePublicProviderBaseUrl,
  SafeProviderUrlError,
} from "./safe-provider-fetch.js";

const publicResolver = async () => ["93.184.216.34"];

describe("safe provider fetch", () => {
  it("carries a real OpenAI SDK image edit through the safe multipart bridge", async () => {
    const upstream = vi.fn(async (target, init) => {
      const wire = new UndiciRequest(String(target), init as never);
      expect(new URL(wire.url).pathname).toBe("/v1/images/edits");
      expect(wire.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const body = await wire.text();
      expect(body).toContain('name="image[]"');
      expect(body).toContain('filename="reference.png"');
      expect(body).toContain("source-image-bytes");
      return new Response(JSON.stringify({ data: [{ url: "https://example.test/result.png" }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new OpenAI({ apiKey: "test-only", baseURL: "https://provider.example/v1", maxRetries: 0,
      fetch: createSafeProviderFetch("https://provider.example/v1", { fetch: upstream, resolve: publicResolver }) });
    await client.images.edit({ model: "gpt-image-2.5-all", prompt: "Keep the reference", image: [
      await toFile(Buffer.from("source-image-bytes"), "reference.png", { type: "image/png" }),
    ] });
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("preserves native multipart image bytes and boundary through package Undici", async () => {
    const form = new FormData();
    form.set("model", "gpt-image-2.5-all");
    form.set("prompt", "Keep the source, 9:16");
    form.append("image[]", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "original.png");
    const upstream = vi.fn(async (target, init) => {
      const wire = new UndiciRequest(String(target), init as never);
      const type = wire.headers.get("content-type");
      expect(type).toMatch(/^multipart\/form-data; boundary=/);
      expect(wire.headers.get("authorization")).toBe("Bearer test-only");
      expect(wire.redirect).toBe("manual");
      const body = Buffer.from(await wire.arrayBuffer());
      expect(body.toString("latin1")).toContain('name="model"');
      expect(body.toString("latin1")).toContain("gpt-image-2.5-all");
      expect(body.toString("latin1")).toContain('filename="original.png"');
      expect(body.includes(Buffer.from([137, 80, 78, 71]))).toBe(true);
      expect(body.toString()).not.toBe("[object FormData]");
      return new Response('{}');
    }) as unknown as typeof fetch;
    const providerFetch = createSafeProviderFetch("https://provider.example/v1", { fetch: upstream, resolve: publicResolver });
    await providerFetch("https://provider.example/v1/images/edits", {
      method: "POST", headers: { authorization: "Bearer test-only" }, body: form,
    });
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("allows canonical custom HTTPS base paths and rejects local/private URL forms", () => {
    expect(normalizePublicProviderBaseUrl("https://Gateway.Example.com:8443/openai/v1/"))
      .toBe("https://gateway.example.com:8443/openai/v1");
    expect(normalizePublicProviderBaseUrl("https://[2606:4700:4700::1111]/v1/"))
      .toBe("https://[2606:4700:4700::1111]/v1");
    for (const value of [
      "http://provider.example/v1",
      "https://user:secret@provider.example/v1",
      "https://127.0.0.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/v1",
      "https://models.internal/v1",
      "https://provider.example/v1?redirect=metadata",
    ]) {
      expect(() => normalizePublicProviderBaseUrl(value), value)
        .toThrow(SafeProviderUrlError);
    }
  });

  it("preserves Request method, authorization, body and signal while disabling redirects", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBeInstanceOf(URL);
      expect(String(input)).toBe("https://provider.example/openai/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-key");
      expect(await new Response(init?.body).text()).toBe('{"model":"custom"}');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit & { duplex?: string })?.duplex).toBe("half");
      expect(init?.redirect).toBe("manual");
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const providerFetch = createSafeProviderFetch("https://provider.example/openai/v1", {
      fetch: upstream,
      resolve: publicResolver,
    });
    const controller = new AbortController();
    const request = new Request("https://provider.example/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer private-key" },
      body: '{"model":"custom"}',
      signal: controller.signal,
    });

    await expect(providerFetch(request)).resolves.toBeInstanceOf(Response);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("bridges a global Request into the package Undici transport", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent.get("https://provider.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });
    const bridge = ((input: string | URL | Request, init?: RequestInit) =>
      undiciFetch(input as string | URL, { ...init, dispatcher: agent } as never) as unknown as Promise<Response>) as typeof fetch;
    const providerFetch = createSafeProviderFetch("https://provider.example/v1", {
      fetch: bridge,
      resolve: publicResolver,
    });
    try {
      const response = await providerFetch(new Request("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer private-key", "content-type": "application/json" },
        body: '{"model":"custom"}',
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await agent.close();
    }
  });

  it("rejects private or mixed DNS at request time and confines origin and base path", async () => {
    const upstream = vi.fn() as unknown as typeof fetch;
    await expect(createSafeProviderFetch("https://provider.example/v1", {
      fetch: upstream,
      resolve: async () => ["93.184.216.34", "10.0.0.8"],
    })("https://provider.example/v1/models")).rejects.toBeInstanceOf(SafeProviderUrlError);
    const confined = createSafeProviderFetch("https://provider.example/openai/v1", {
      fetch: upstream,
      resolve: publicResolver,
    });
    await expect(confined("https://provider.example/admin"))
      .rejects.toBeInstanceOf(SafeProviderUrlError);
    await expect(confined("https://evil.example/openai/v1/models"))
      .rejects.toBeInstanceOf(SafeProviderUrlError);
    expect(upstream).not.toHaveBeenCalled();
  });
});
