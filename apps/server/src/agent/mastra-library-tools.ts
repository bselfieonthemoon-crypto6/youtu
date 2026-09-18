import { randomInt } from "node:crypto";
import { z } from "zod";

import { compactMastraToolResult } from "./tool-result-projection.js";
import { createAgentTool, runContextOf } from "./tools/tool-run-context.js";

const libraryKindSchema = z.enum(["image", "illustration", "icon", "background", "mockup", "svg"]);

const findLibraryAssetsSchema = z.object({
  kind: libraryKindSchema.optional()
    .describe("Restrict to one material kind. Omit to draw from every image-like kind."),
  count: z.number().int().min(1).max(8).default(4)
    .describe("How many distinct materials to return. The server picks them at random."),
  query: z.string().trim().min(1).max(100).optional()
    .describe("Optional case-insensitive name filter, e.g. a character or theme keyword."),
}).strict();

const LIBRARY_COLUMNS = "id,name,asset_object_id,kind,width,height";

/** Unbiased Fisher-Yates sample using a CSPRNG. */
export function sampleRandom<T>(values: readonly T[], count: number): T[] {
  const pool = [...values];
  const taken = Math.min(count, pool.length);
  for (let index = 0; index < taken; index += 1) {
    const swap = index + randomInt(pool.length - index);
    const current = pool[index]!;
    pool[index] = pool[swap]!;
    pool[swap] = current;
  }
  return pool.slice(0, taken);
}

/**
 * Read-only access to the workspace's published design-resource library (the
 * "素材库"). The server draws materials at random; the model can then submit the
 * returned assetId values through `edit_image` (sourceUsage=reference). Nothing
 * here authorizes execution or billing by itself.
 */
/** Asset IDs the model actually received from find_library_assets this run. */
export function libraryAssetIdsFromToolResult(result: unknown): string[] {
  const assets = (result as { assets?: unknown } | null | undefined)?.assets;
  if (!Array.isArray(assets)) return [];
  return assets
    .map(asset => (asset as { assetId?: unknown } | null | undefined)?.assetId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Published, live, workspace-scoped library rows for an authenticated client. */
export async function loadLibraryAssetRows(
  client: any,
  workspaceId: string,
  filters: { kind?: string; query?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  let request = client.from("design_resources").select(LIBRARY_COLUMNS)
    .eq("workspace_id", workspaceId).eq("scope", "workspace").eq("status", "published").is("deleted_at", null);
  if (filters.kind) request = request.eq("kind", filters.kind);
  const query = filters.query?.replace(/[%_]/g, "");
  if (query) request = request.ilike("name", `%${query}%`);
  const { data, error } = await request.limit(500);
  if (error) throw new Error("library_unavailable");
  return (data ?? []).filter((row: any) => typeof row?.asset_object_id === "string");
}

export function createMastraLibraryTools(deps: {
  createUserClient: (accessToken: string) => any;
}) {
  const findLibraryAssets = createAgentTool({
    id: "find_library_assets",
    description:
      "Read-only: draw a server-random selection from this workspace's published design-resource library (游戏活动素材). The default is a random draw across all published materials: omit kind and query unless the user explicitly asks for a specific material type or keyword. Returns assetId values to submit through edit_image (sourceUsage=reference). It cannot browse other workspaces, drafts or deleted materials, and never generates or charges by itself. Use it before generating when the task needs library characters, props or backgrounds.",
    inputSchema: findLibraryAssetsSchema,
    execute: async (input, context) => {
      const runContext = runContextOf(context);
      const accessToken = typeof runContext.access_token === "string" ? runContext.access_token : "";
      const workspaceId = typeof runContext.workspace_id === "string" ? runContext.workspace_id : "";
      if (!accessToken || !workspaceId)
        return { status: "unavailable" as const, error: "library_context_unavailable",
          summary: "缺少经过认证的工作区上下文，未读取素材库。" };
      const client = deps.createUserClient(accessToken);
      const filtered = input.kind !== undefined || input.query !== undefined;
      let rows: Array<Record<string, unknown>>;
      let filterFallback = false;
      try {
        rows = await loadLibraryAssetRows(client, workspaceId,
          { ...(input.kind ? { kind: input.kind } : {}), ...(input.query ? { query: input.query } : {}) });
        // A query that matches nothing must not look like an empty library;
        // fall back to a random unfiltered selection so generation still has
        // real workspace material to reference.
        if (!rows.length && filtered) {
          rows = await loadLibraryAssetRows(client, workspaceId, {});
          filterFallback = rows.length > 0;
        }
      } catch {
        return { status: "unavailable" as const, error: "library_unavailable",
          summary: "读取素材库失败，请重试；未提交生成。" };
      }
      if (rows.length === 0)
        return { status: "empty" as const, total: 0, assets: [],
          summary: "当前工作区素材库没有已发布素材；未提交生成。" };
      const picked = sampleRandom(rows, input.count).map((row: any) => ({
        assetId: row.asset_object_id,
        name: typeof row.name === "string" ? row.name : undefined,
        kind: row.kind,
        width: row.width,
        height: row.height,
      }));
      return compactMastraToolResult({
        status: "ok" as const,
        total: rows.length,
        note: filterFallback
          ? "No published material matched the filter; returned a random unfiltered selection. Pass these assetId values to edit_image with sourceUsage=reference."
          : "Random library pick. Pass these assetId values to edit_image with sourceUsage=reference; the server re-authorizes each one against the published workspace library before any generation.",
        ...(filterFallback ? { filterFallback: true } : {}),
        assets: picked,
      });
    },
  });
  return { findLibraryAssets };
}
