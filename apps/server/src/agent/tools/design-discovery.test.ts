import { describe, it, expect, vi } from "vitest";
import { createDesignDiscoveryTool } from "./design-discovery.js";

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
    const t = createDesignDiscoveryTool({
      createUserClient: () => ({ from: () => query }),
      designService: { get },
      designResourceService: {},
      designTemplateService: {},
    } as any);
    const result = await t.invoke(
      {},
      {
        configurable: {
          access_token: "token",
          canvas_id: "canvas",
          workspace_id: "workspace",
          user_id: "user",
        },
      },
    );
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
    const t = createDesignDiscoveryTool({ createUserClient: client } as any);
    expect(await t.invoke({})).toMatchObject({
      error: "design_context_missing",
    });
    expect(client).not.toHaveBeenCalled();
  });
});
