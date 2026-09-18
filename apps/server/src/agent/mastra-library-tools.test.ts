import { describe, expect, it, vi } from "vitest";

import { createMastraLibraryTools, libraryAssetIdsFromToolResult } from "./mastra-library-tools.js";
import { toolExecutionContext } from "./tools/tool-run-context.js";

type QueryCalls = { eq: Array<[string, unknown]>; is: Array<[string, unknown]>; ilike: Array<[string, unknown]>; limit?: number };

function database(rows: unknown[], filteredRows: unknown[] = rows) {
  const invocations: QueryCalls[] = [];
  const client = {
    from: vi.fn(() => {
      const calls: QueryCalls = { eq: [], is: [], ilike: [] };
      invocations.push(calls);
      const builder: any = {
        select: () => builder,
        eq: (key: string, value: unknown) => { calls.eq.push([key, value]); return builder; },
        is: (key: string, value: unknown) => { calls.is.push([key, value]); return builder; },
        ilike: (key: string, value: unknown) => { calls.ilike.push([key, value]); return builder; },
        limit: async (value: number) => {
          calls.limit = value;
          const hasFilter = calls.eq.some(([key]) => key === "kind") || calls.ilike.length > 0;
          return { data: hasFilter ? filteredRows : rows, error: null };
        },
      };
      return builder;
    }),
  };
  return { invocations, get calls(): QueryCalls { return invocations[0]!; }, client };
}

const row = (id: string, name = "青龙") => ({ id, name, asset_object_id: id, kind: "image", width: 1024, height: 1024 });

function invoke(tools: ReturnType<typeof createMastraLibraryTools>, input: Record<string, unknown>, configurable: Record<string, unknown> = { access_token: "token", workspace_id: "ws" }) {
  return tools.findLibraryAssets.execute(input, toolExecutionContext({ configurable } as never)) as Promise<any>;
}

describe("find_library_assets", () => {
  it("scopes to published, live, workspace resources and returns random assetId values", async () => {
    const db = database([row("11111111-1111-4111-8111-111111111111"), row("22222222-2222-4222-8222-222222222222")]);
    const tools = createMastraLibraryTools({ createUserClient: () => db.client });
    const result = await invoke(tools, { count: 1 });
    expect(result.status).toBe("ok");
    expect(result.assets).toHaveLength(1);
    expect(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]).toContain(result.assets[0].assetId);
    expect(db.calls.eq).toEqual(expect.arrayContaining([
      ["workspace_id", "ws"], ["scope", "workspace"], ["status", "published"],
    ]));
    expect(db.calls.is).toEqual(expect.arrayContaining([["deleted_at", null]]));
    expect(db.calls.limit).toBe(500);
  });

  it("applies an optional kind filter and strips wildcard characters from the name filter", async () => {
    const db = database([row("33333333-3333-4333-8333-333333333333")]);
    const tools = createMastraLibraryTools({ createUserClient: () => db.client });
    await invoke(tools, { kind: "icon", query: "50%_off" });
    expect(db.calls.eq).toEqual(expect.arrayContaining([["kind", "icon"]]));
    expect(db.calls.ilike).toEqual([["name", "%50off%"]]);
  });

  it("reports an empty library without inventing materials", async () => {
    const db = database([]);
    const tools = createMastraLibraryTools({ createUserClient: () => db.client });
    await expect(invoke(tools, {})).resolves.toMatchObject({ status: "empty", assets: [] });
  });

  it("falls back to a random unfiltered selection when a filter matches nothing", async () => {
    const db = database([row("44444444-4444-4444-8444-444444444444")], []);
    const tools = createMastraLibraryTools({ createUserClient: () => db.client });
    const result = await invoke(tools, { kind: "icon" });
    expect(result).toMatchObject({ status: "ok", filterFallback: true });
    expect(result.assets).toHaveLength(1);
    expect(db.invocations).toHaveLength(2);
  });

  it("extracts the asset IDs the model actually received", () => {
    expect(libraryAssetIdsFromToolResult({ assets: [{ assetId: "a" }, { assetId: "b" }, {}, { assetId: 5 }] }))
      .toEqual(["a", "b"]);
    expect(libraryAssetIdsFromToolResult(null)).toEqual([]);
    expect(libraryAssetIdsFromToolResult({})).toEqual([]);
  });

  it("fails closed without an authenticated workspace context", async () => {
    const tools = createMastraLibraryTools({ createUserClient: () => database([]).client });
    await expect(invoke(tools, {}, {})).resolves.toMatchObject({ status: "unavailable", error: "library_context_unavailable" });
  });
});
