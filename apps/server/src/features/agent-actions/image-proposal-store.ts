import type { ImageGenerateInput } from "../../agent/tools/image-generate.js";

export type ImageProposalContext = {
  access_token: string;
  user_id: string;
  canvas_id: string;
  session_id: string;
  run_id: string;
};

export function createImageProposalStore(createClient: (token: string) => any) {
  function client(context: ImageProposalContext) {
    if (
      !context.access_token ||
      !context.session_id ||
      !context.canvas_id ||
      !context.run_id
    )
      throw new Error("缺少对话身份，未提交图片任务，请重新打开对话。");
    return createClient(context.access_token);
  }
  return {
    async latest(context: ImageProposalContext) {
      const { data, error } = await client(context)
        .from("image_generation_proposals")
        .select("id,input,status")
        .eq("session_id", context.session_id)
        .eq("created_by", context.user_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("读取图片方案失败，请稍后重试。");
      return data as {
        id: string;
        input: ImageGenerateInput;
        status: string;
      } | null;
    },
    async propose(
      context: ImageProposalContext,
      input: ImageGenerateInput,
      details: Record<string, unknown>,
    ) {
      const { data, error } = await client(context).rpc(
        "loomic_propose_image",
        {
          p_session: context.session_id,
          p_canvas: context.canvas_id,
          p_run: context.run_id,
          p_input: input,
          p_details: details,
        },
      );
      if (error) throw new Error("保存图片方案失败，未开始生成。请稍后重试。");
      return {
        confirmationId: data.id,
        canvasId: context.canvas_id,
        kind: "image_generation",
        details: data.details,
        expiresAt: data.expires_at,
      };
    },
    async decide(
      context: ImageProposalContext,
      id: string,
      decision: "confirm" | "cancel",
    ) {
      const { data, error } = await client(context).rpc("loomic_decide_image", {
        p_id: id,
        p_session: context.session_id,
        p_canvas: context.canvas_id,
        p_run: context.run_id,
        p_decision: decision,
      });
      if (error)
        throw new Error(
          "方案已失效、已更新或不属于本对话，请重新读取最新方案再确认。",
        );
      return data as { id: string; input: ImageGenerateInput; status: string };
    },
    async job(context: ImageProposalContext, id: string) {
      const { data, error } = await client(context)
        .from("background_jobs")
        .select("id,status,error_message,payload")
        .eq("id", id)
        .eq("created_by", context.user_id)
        .maybeSingle();
      if (error)
        throw new Error("读取图片任务失败，请重试确认；不会重复创建任务。");
      return data;
    },
  };
}
export type ImageProposalStore = ReturnType<typeof createImageProposalStore>;
