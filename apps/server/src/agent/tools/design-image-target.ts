import type { DesignJobTarget } from "@loomic/shared";
import type { DesignToolDependencies } from "./design-tools.js";

export function createDesignImageTargetValidator(deps: {
  designTools?: DesignToolDependencies;
  createUserClient: (token: string) => any;
}) {
  return async (target: DesignJobTarget, context: any) => {
    if (!deps.designTools) throw new Error("设计画板服务不可用");
    const design = await deps.designTools.designService.get(
      {
        id: context.user_id,
        accessToken: context.access_token,
        email: "",
        userMetadata: {},
      },
      target.design_id,
    );
    if (design.workspace_id !== context.workspace_id)
      throw new Error("画板不属于当前工作区");
    const { data, error } = await deps
      .createUserClient(context.access_token)
      .from("design_nodes")
      .select("design_id")
      .eq("design_id", design.id)
      .eq("canvas_id", context.canvas_id)
      .eq("workspace_id", context.workspace_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !data)
      throw new Error("画板不属于当前画布，请先 list_designs 确定目标");
    if (design.revision !== target.expected_revision)
      throw new Error(
        "画板版本已改变，请重新 inspect_design 后生成方案并确认。",
      );
  };
}
