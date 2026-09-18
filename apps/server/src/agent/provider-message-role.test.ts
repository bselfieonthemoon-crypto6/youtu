import { describe, expect, it } from "vitest";

import {
  normalizeOpenAICompatibleResponseBody,
  withNormalizedAssistantRole,
} from "./provider-message-role.js";

/**
 * Some Gemini gateways answer with `role: "model"` instead of `"assistant"`.
 * `@ai-sdk/openai-compatible` validates the response with
 * `z.literal("assistant")` (non-streaming) and `z.enum(["assistant",""])`
 * (streaming deltas), so an unnormalized body fails response validation.
 */
describe("OpenAI-compatible response role normalization", () => {
  it("rewrites a non-standard model role on a non-streaming response", () => {
    const body = '{"choices":[{"message":{"role":"model","content":"done"}}]}';
    expect(JSON.parse(normalizeOpenAICompatibleResponseBody(body))).toMatchObject({
      choices: [{ message: { role: "assistant", content: "done" } }],
    });
  });

  it("rewrites a non-standard model role and fills absent roles in streaming deltas", () => {
    const stream = [
      'data: {"choices":[{"delta":{"role":"model","content":"do"}}]}',
      'data: {"choices":[{"delta":{"role":"model","content":"ne"}}]}',
      'data: {"choices":[{"delta":{"content":"!"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"generate_image"}}]}}]}',
      "data: [DONE]",
    ].join("\n\n");
    const normalized = normalizeOpenAICompatibleResponseBody(stream);
    const deltas = normalized
      .split("\n\n")
      .filter(line => line.startsWith("data: {"))
      .map(line => (JSON.parse(line.slice("data: ".length)) as { choices: { delta: { role?: string } }[] }).choices[0]!.delta);
    expect(deltas).toHaveLength(4);
    // Every delta now carries the role the provider schema requires.
    expect(deltas.every(delta => delta.role === "assistant")).toBe(true);
  });

  it("leaves an already-conformant body byte-identical", () => {
    const body = '{"choices":[{"message":{"role":"assistant","content":"fine"}}]}';
    expect(normalizeOpenAICompatibleResponseBody(body)).toBe(body);
    const stream = 'data: {"choices":[{"delta":{"role":"assistant","content":"x"}}]}';
    expect(normalizeOpenAICompatibleResponseBody(stream)).toBe(stream);
  });

  it("never rewrites model text that happens to contain the word role", () => {
    const body = '{"choices":[{"message":{"role":"model","content":"the role is model here"}}]}';
    const normalized = normalizeOpenAICompatibleResponseBody(body);
    expect(JSON.parse(normalized).choices[0].message.content).toBe("the role is model here");
    expect(JSON.parse(normalized).choices[0].message.role).toBe("assistant");
  });

  it("keeps an empty delta a valid JSON object", () => {
    // Gateways emit `"delta":{}` on chunks that only carry `finish_reason`.
    // Injecting a trailing separator would make the frame unparseable.
    for (const raw of [
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[{"delta":{ },"finish_reason":null}]}',
    ]) {
      const normalized = normalizeOpenAICompatibleResponseBody(raw);
      const delta = (JSON.parse(normalized.slice("data: ".length)) as {
        choices: { delta: unknown }[];
      }).choices[0]!.delta;
      expect(delta).toEqual({ role: "assistant" });
    }
  });
});

describe("withNormalizedAssistantRole", () => {
  const respond = (body: string, contentType: string) =>
    (async () => new Response(body, { status: 200, headers: { "content-type": contentType } })) as typeof fetch;

  it("normalizes a JSON response and drops the stale content-length/charset", async () => {
    const wrapped = withNormalizedAssistantRole(respond(
      '{"choices":[{"message":{"role":"model","content":"done"}}]}',
      "application/json; charset=utf-8",
    ));
    const response = await wrapped("https://gateway.example.test/v1/chat/completions", { method: "POST" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBeNull();
    expect((await response.json()).choices[0].message.role).toBe("assistant");
  });

  it("keeps server-sent events incremental while normalizing deltas", async () => {
    const stream = 'data: {"choices":[{"delta":{"role":"model","content":"a"}}]}\n\n';
    const wrapped = withNormalizedAssistantRole(respond(stream, "text/event-stream"));
    const response = await wrapped("https://gateway.example.test/v1/chat/completions", { method: "POST" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain('"role":"assistant"');
  });

  it("does not corrupt a frame split across stream chunks", async () => {
    // Worst case: emit one byte at a time so every JSON object is split at
    // arbitrary offsets, including inside `"delta":{}`.
    const frames = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(frames);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const wrapped = withNormalizedAssistantRole((async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch);
    const response = await wrapped("https://gateway.example.test/v1/chat/completions", { method: "POST" });
    const deltas = (await response.text())
      .split("\n")
      .filter(line => line.startsWith("data: {"))
      .map(line => (JSON.parse(line.slice("data: ".length)) as {
        choices: { delta: unknown }[];
      }).choices[0]!.delta);
    expect(deltas).toEqual([{ role: "assistant", content: "a" }, { role: "assistant" }]);
  });

  it("passes a non-2xx response through untouched for the caller to classify", async () => {
    const original = (async () => new Response('{"error":{"message":"bad key"}}', {
      status: 401, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const wrapped = withNormalizedAssistantRole(original);
    const response = await wrapped("https://gateway.example.test/v1/chat/completions", { method: "POST" });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":{"message":"bad key"}}');
  });

  it("forwards the request unchanged so the inner fetch keeps enforcing confinement", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const inner = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.url = String(input);
      seen.init = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await withNormalizedAssistantRole(inner)("https://gateway.example.test/v1/chat/completions", {
      method: "POST", body: '{"model":"m"}', redirect: "manual",
    });
    expect(seen.url).toBe("https://gateway.example.test/v1/chat/completions");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe('{"model":"m"}');
  });
});
