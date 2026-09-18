/**
 * Upstream model identifiers whose adapters accept Loomic's native 1K/2K/4K
 * dimensions. Keep this exact and case-sensitive: provider model IDs are
 * canonical protocol values, not user-facing labels.
 */
export const nativeGptImageModelPattern =
  /^gpt-image-(?:2|2\.5-(?:flare|sunburst))(?:-\d{4}-\d{2}-\d{2})?$/;

export function isNativeGptImageModel(value: unknown): value is string {
  return typeof value === "string" && nativeGptImageModelPattern.test(value);
}

/** APIYI aggregate routes have a separate, URL-only response contract. */
export const apiYiAggregateGptImageModelPattern =
  /^gpt-image-\d+(?:\.\d+)?-all$/;

export function isApiYiAggregateGptImageModel(value: unknown): value is string {
  return typeof value === "string" && apiYiAggregateGptImageModelPattern.test(value);
}
