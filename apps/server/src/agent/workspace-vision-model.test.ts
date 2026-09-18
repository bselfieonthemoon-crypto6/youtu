import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the real provider pipeline (message conversion, tool schema, usage
 * mapping) against a canned HTTP response, and records exactly what the
 * provider serialized. This proves the wire shape the budget guard estimates is
 * the wire shape actually sent.
 *
 * `withNormalizedAssistantRole` is the seam: in production it wraps the
 * confined fetch. The mock keeps the wrapping contract but swaps the transport
 * for the recording one.
 */
const harness = vi.hoisted(() => ({
  reply: undefined as string | undefined,
  status: 200,
  transport: undefined as typeof fetch | undefined,
}));

vi.mock("./provider-message-role.js", async importOriginal => ({
  ...await importOriginal<typeof import("./provider-message-role.js")>(),
  withNormalizedAssistantRole: (inner: typeof fetch) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      if (harness.transport) return harness.transport(input, init);
      void inner;
      return new Response(harness.reply ?? "{}", {
        status: harness.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
}));

import { createWorkspaceVisionModel } from "./workspace-vision-model.js";
import type { WorkspaceVisionUsageBuffer } from "./workspace-vision-model.js";

const SNAPSHOT = {
  apiKey: "run-secret",
  baseUrl: "https://gateway.example.test/v1",
  upstreamModelId: "deepseek-v4-flash-vision-exp",
};

type CapturedCall = { url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined };

/** Install a recording transport and return the calls it observed. */
function captureProviderCalls(options: { reply?: string; status?: number } = {}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  harness.transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    calls.push({
      url,
      body: raw === undefined ? {} : JSON.parse(String(raw)) as Record<string, unknown>,
      signal: init?.signal,
    });
    return new Response(options.reply ?? harness.reply ?? "{}", {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function replyWith(content: string, usage?: Record<string, number>) {
  return JSON.stringify({
    id: "chatcmpl-1", created: 1, model: SNAPSHOT.upstreamModelId,
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  });
}

beforeEach(() => {
  harness.status = 200;
  harness.transport = undefined;
  harness.reply = replyWith("done", { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 });
});

describe("workspace vision model on the AI SDK", () => {
  it("sends a text part and a media-type-qualified image part to the snapshot endpoint", async () => {
    const calls = captureProviderCalls();
    const model = createWorkspaceVisionModel(SNAPSHOT);
    const result = await model.generate({
      system: "be precise",
      user: "describe",
      images: [{ dataUri: "data:image/webp;base64,AAAA" }],
    });

    expect(result.text).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.example.test/v1/chat/completions");
    expect(calls[0]!.body.model).toBe(SNAPSHOT.upstreamModelId);
    // The AI SDK `doGenerate` path never opens an SSE stream.
    expect(calls[0]!.body.stream).toBeUndefined();
    expect(calls[0]!.body.max_tokens).toBe(model.contextBudget.generationReserveTokens);
    expect(calls[0]!.body.messages).toEqual([
      { role: "system", content: "be precise" },
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("caps an explicit caller output requirement to the frozen generation reserve", async () => {
    const calls = captureProviderCalls();
    const model = createWorkspaceVisionModel(SNAPSHOT);
    const reserve = model.contextBudget.generationReserveTokens;

    await model.generate({ user: "hi", maxOutputTokens: 2_000 });
    await model.generate({ user: "hi", maxOutputTokens: 10_000_000 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.max_tokens).toBe(Math.min(2_000, reserve));
    expect(calls[1]!.body.max_tokens).toBe(reserve);
  });

  it("records an observation after the call with the provider's real usage", async () => {
    captureProviderCalls();
    const onUsage = vi.fn();
    const model = createWorkspaceVisionModel(SNAPSHOT, { onUsage });
    await model.generate({ user: "hi", purpose: "intent_review" });

    expect(onUsage).toHaveBeenCalledTimes(2);
    const [preflight, completed] = onUsage.mock.calls.map(call => call[0]);
    expect(preflight).toMatchObject({ phase: "preflight", actualInputTokens: null, actualOutputTokens: null });
    expect(completed).toMatchObject({
      phase: "completed",
      purpose: "intent_review",
      allowed: true,
      actualInputTokens: 120,
      actualOutputTokens: 7,
    });
    // Estimates are never reported as actual usage.
    expect(completed.actualInputTokens).not.toBe(completed.estimatedInputTokens);
  });

  it("reports null usage rather than inventing numbers when the provider omits it", async () => {
    captureProviderCalls({ reply: replyWith("done") });
    const result = await createWorkspaceVisionModel(SNAPSHOT).generate({ user: "hi" });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("ignores reasoning parts and concatenates only generated text", async () => {
    harness.reply = JSON.stringify({
      id: "x", created: 1, model: SNAPSHOT.upstreamModelId,
      choices: [{ message: { role: "assistant", content: "answer", reasoning_content: "secret thinking" }, finish_reason: "stop" }],
    });
    captureProviderCalls();
    const result = await createWorkspaceVisionModel(SNAPSHOT).generate({ user: "hi" });
    expect(result.text).toBe("answer");
  });

  it("bounds the observation buffer at 64 records", async () => {
    captureProviderCalls();
    const usageBuffer: WorkspaceVisionUsageBuffer = { sequence: 0, records: [] };
    const model = createWorkspaceVisionModel(SNAPSHOT, { usageBuffer });
    for (let index = 0; index < 40; index += 1) await model.generate({ user: "hi" });
    // 40 calls x (preflight + completed) = 80 observations, trimmed to 64.
    expect(usageBuffer.records).toHaveLength(64);
    expect(usageBuffer.sequence).toBe(80);
  });

  it("propagates the abort signal to the provider request", async () => {
    const calls = captureProviderCalls();
    const controller = new AbortController();
    await createWorkspaceVisionModel(SNAPSHOT).generate({ user: "hi", signal: controller.signal });
    expect(calls[0]!.signal).toBeTruthy();
  });
});
