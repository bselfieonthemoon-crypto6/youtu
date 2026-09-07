import { tool } from "langchain";
import { z } from "zod";
import type { DesignToolDependencies } from "./design-tools.js";

export function createDesignDiscoveryTool(
  deps: DesignToolDependencies & { createUserClient: (token: string) => any },
) {
  return tool(
    async (_input, config) => {
      const c = config?.configurable;
      if (!c?.access_token || !c?.canvas_id || !c?.workspace_id || !c?.user_id)
        return { error: "design_context_missing" };
      const { data, error } = await deps
        .createUserClient(c.access_token)
        .from("design_nodes")
        .select("design_id")
        .eq("canvas_id", c.canvas_id)
        .eq("workspace_id", c.workspace_id)
        .is("deleted_at", null)
        .limit(101);
      if (error)
        return {
          error: "design_list_failed",
          summary: "读取画板列表失败，请重试，不要编造 design_id。",
        };
      const designs = [];
      for (const row of (data ?? []).slice(0, 100)) {
        const design = await deps.designService.get(
          {
            id: c.user_id,
            accessToken: c.access_token,
            email: "",
            userMetadata: {},
          },
          row.design_id,
        );
        if (design.workspace_id === c.workspace_id)
          designs.push({
            design_id: design.id,
            name: design.name,
            width: design.width,
            height: design.height,
            revision: design.revision,
          });
      }
      return {
        designs,
        truncated: (data ?? []).length > 100,
        summary:
          designs.length === 1
            ? "当前画布有一个设计画板，请读取其图层后操作。"
            : "按用户指定名称选择画板；不明确时请询问，不要猜测。",
      };
    },
    {
      name: "list_designs",
      description:
        "Discover real native design IDs, names and dimensions linked to the current infinite canvas. Call this before inspect_design when the user refers to a design board without providing its ID. Never invent an ID.",
      schema: z.object({}),
    },
  );
}
