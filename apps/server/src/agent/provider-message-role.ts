/**
 * Normalizes non-standard OpenAI-compatible response roles.
 *
 * Some Gemini gateways emit `"role":"model"` instead of `"role":"assistant"`,
 * including in streaming deltas and in deltas that omit the role entirely.
 * `@ai-sdk/openai-compatible` validates the response payload with a strict
 * `z.literal("assistant")` (see `OpenAICompatibleChatResponseSchema`) and
 * `z.enum(["assistant",""])` for deltas, so an unnormalized `"model"` role
 * fails response validation and loses the whole generation.
 *
 * The provider pipeline offers no response-side hook that repairs a role, so
 * this rewrites the raw response bytes at the existing security boundary: the
 * wrapped fetch. Only the JSON `role` field is touched; model text is never
 * rewritten.
 */

const MODEL_ROLE = /"role"\s*:\s*"model"/g;
/**
 * An EMPTY delta object must receive the role without a trailing separator.
 * Gateways routinely send `"delta":{}` (e.g. a final chunk carrying only
 * `finish_reason`), and `"delta":{"role":"assistant",}` is not valid JSON —
 * it would fail the provider's own response parsing.
 */
const EMPTY_DELTA = /"delta"(\s*:\s*)\{\s*\}/g;
/** A non-empty delta with no top-level role gets the role prepended. */
const MISSING_ASSISTANT_ROLE = /"delta"(\s*:\s*)(?!\{[^{}]*"role"\s*:)\{(?!\})/g;

export function normalizeOpenAICompatibleResponseBody(body: string): string {
  return body
    .replace(MODEL_ROLE, '"role":"assistant"')
    .replace(EMPTY_DELTA, '"delta"$1{"role":"assistant"}')
    .replace(MISSING_ASSISTANT_ROLE, '"delta"$1{"role":"assistant",');
}

/**
 * Wrap an already-confined provider fetch and normalize response roles.
 *
 * The upstream request is untouched, so the caller's origin/path confinement
 * and DNS checks still run exactly as before. This is a pure response adapter.
 */
export function withNormalizedAssistantRole(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchImpl(input, init);
    if (!response.ok) return response;
    if (!response.body) return response;
    const contentType = response.headers.get("content-type") ?? "";
    // Server-sent events must stay incremental; a JSON body is small enough to
    // buffer. Never decode-encode a stream that a caller reads incrementally.
    const streaming = /event-stream/i.test(contentType);
    if (streaming) {
      const decoded = response.body.pipeThrough(new TextDecoderStream());
      // Rewrites must be applied to COMPLETE SSE lines only. A decoder chunk can
      // split a JSON object anywhere (including inside `"delta":{}`), and a
      // half-rewritten object would corrupt the stream. Buffering up to the last
      // newline keeps the response incremental frame-by-frame while guaranteeing
      // every rewrite sees a whole line.
      let pending = "";
      const normalized = decoded.pipeThrough(
        new TransformStream<string, string>({
          transform(chunk, controller) {
            pending += chunk;
            const boundary = pending.lastIndexOf("\n");
            if (boundary === -1) return;
            const complete = pending.slice(0, boundary + 1);
            pending = pending.slice(boundary + 1);
            controller.enqueue(normalizeOpenAICompatibleResponseBody(complete));
          },
          flush(controller) {
            if (pending) controller.enqueue(normalizeOpenAICompatibleResponseBody(pending));
          },
        }),
      );
      return new Response(normalized.pipeThrough(new TextEncoderStream()), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(contentType),
      });
    }
    const body = normalizeOpenAICompatibleResponseBody(await response.text());
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(contentType),
    });
  }) as typeof fetch;
}

/** Preserve the provider's media type but drop a length/charset we invalidated. */
function responseHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set("content-type", /^\s*[^;\s]+/.exec(contentType)?.[0] ?? "application/json");
  return headers;
}
