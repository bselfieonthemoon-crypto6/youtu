import { describe, it, expect, vi } from "vitest";
import { createDesignDiscoveryTool } from "./design-discovery.js";
import { toolExecutionContext } from "./tool-run-context.js";
import type { AgentToolExecutionContext } from "./tool-run-context.js";

/**
 * Mastra declares `execute` optional because a tool may be schema-only. This tool
 * is always built with a handler, so these direct calls use a view that makes it
 * required. The schema takes no arguments.
 */
function directTool(tool: { execute?: unknown }) {
  return tool as unknown as {
    execute: (input: Record<string, never>, context: AgentToolExecutionContext) => Promise<unknown>;
  };
}

describe("native design discovery", () => {
  it("lists real board metadata and constrains the query to the active canvas/workspace", async () => {
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      is: vi.fn(() => query),
      limit: vi.fn(async () => ({
        data: [{ design_id: "design-real" }],
        error: null,
      })),
    };
    const get = vi.fn(async () => ({
      id: "design-real",
      workspace_id: "workspace",
      name: "Poster",
      width: 800,
      height: 600,
      revision: 3,
    }));
    const t = directTool(createDesignDiscoveryTool({
      createUserClient: () => ({ from: () => query }),
      designService: { get },
      designResourceService: {},
      designTemplateService: {},
    } as any));
    const result = await t.execute({}, toolExecutionContext({
        configurable: {
          access_token: "token",
          canvas_id: "canvas",
          workspace_id: "workspace",
          user_id: "user",
        },
      }));
    expect(result).toMatchObject({
      designs: [
        { design_id: "design-real", width: 800, height: 600, revision: 3 },
      ],
    });
    expect(query.eq).toHaveBeenCalledWith("canvas_id", "canvas");
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace");
  });
  it("fails closed without authenticated canvas context", async () => {
    const client = vi.fn();
    const t = directTool(createDesignDiscoveryTool({ createUserClient: client } as any));
    expect(await t.execute({}, toolExecutionContext({}))).toMatchObject({
      error: "design_context_missing",
    });
    expect(client).not.toHaveBeenCalled();
  });
});
