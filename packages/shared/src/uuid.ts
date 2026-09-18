/**
 * RFC 4122/9562 UUID text accepted by Loomic. The project persists UUID
 * versions 1-8; the variant nibble remains restricted to the RFC variant.
 */
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const workspaceModelIdPattern =
  /^workspace:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function parseWorkspaceModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return workspaceModelIdPattern.exec(value)?.[1]?.toLowerCase() ?? null;
}

/** Returns distinct UUIDs in encounter order without sharing mutable RegExp state. */
export function extractUuids(value: string, limit = Number.POSITIVE_INFINITY): string[] {
  if (!Number.isSafeInteger(limit) && limit !== Number.POSITIVE_INFINITY) return [];
  if (limit <= 0) return [];
  const matches = value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi) ?? [];
  return [...new Set(matches.map(item => item.toLowerCase()))].slice(0, limit);
}
