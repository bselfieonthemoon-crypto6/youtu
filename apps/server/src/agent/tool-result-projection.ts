/**
 * Tool-result projection.
 *
 * Raw tool results are application data: the UI reads them (image cards,
 * canvas sync, receipts) and the durable ledger stores them. The model must
 * never receive binary payloads, signed URLs or credentials, so every tool
 * result is projected through {@link compactMastraToolResult} before it reaches
 * the model.
 *
 * Two callers use this module:
 * - `mastra-agent.ts`, which compacts model inputs derived from tool results.
 * - `tools/tool-run-context.ts` via `createAgentTool`, which installs
 *   {@link toolResultForModel} as the Mastra tool `toModelOutput` projection so
 *   the *model* sees the compacted value while the runtime stream, the UI and
 *   `on_tool_end` keep the untouched original.
 *
 * This module deliberately has no imports so tool modules can use it without
 * creating an import cycle with the agent runtime.
 */

/**
 * Keep original artifacts on the UI side; never send binary tool payloads back
 * to the model.
 */
export function compactMastraToolResult(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^data:[^;]+;base64,/i.test(value)) return "[binary asset omitted; use assetId]";
    try { return compactMastraToolResult(JSON.parse(value)); } catch { return value.length > 24000 ? `${value.slice(0, 24000)}\n[truncated; request narrower evidence]` : value; }
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(compactMastraToolResult);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ("content" in record && "tool_call_id" in record) return compactMastraToolResult(record.content);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !/^(base64|buffer|input_images|inputImages|dataUri|access_token|apiKey|signed_url|signedUrl|imageUrl|videoUrl|url)$/i.test(key))
    .map(([key, item]) => [key, compactMastraToolResult(item)]));
}

function safeSerialize(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

/**
 * Model-visible projection installed as a Mastra tool `toModelOutput`.
 *
 * The return value must be an AI SDK tool-result output object, not a bare
 * value: when `toModelOutput` is set, Mastra forwards its result verbatim and
 * the provider adapters switch on `output.type`. A bare object or string has no
 * `type`, so the OpenAI-compatible adapter would send an empty tool message.
 * Returning `{ type: "text", value }` therefore reproduces exactly what the
 * provider received while the tool itself returned a plain value.
 */
export function toolResultForModel(output: unknown): { type: "text"; value: string } {
  const compacted = compactMastraToolResult(output);
  const value = typeof compacted === "string" ? compacted : (safeSerialize(compacted) ?? "");
  return { type: "text", value };
}
