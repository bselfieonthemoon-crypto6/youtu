import type { AdminSupabaseClient } from "../../../supabase/admin.js";
import { isUuid } from "@loomic/shared";
import { QwenLayerError, type QwenLayerCheckpoint } from "../../images/qwen-layer-separation.js";

/** Private, job-derived raw result checkpoint written before individual layer assets.
 * A signing/finalization failure must not call the model again. */
export function createQwenLayerCheckpoint(admin: AdminSupabaseClient, workspaceId: string, jobId: string): QwenLayerCheckpoint {
  if (!isUuid(workspaceId) || !isUuid(jobId)) throw new QwenLayerError("invalid_input", "分层存档任务范围无效。", 422);
  const objectPath = `${workspaceId}/generated/${jobId}-qwen-layer-checkpoint.json`;
  const bucket = admin.storage.from("workspace-assets");
  return {
    async load() {
      const { data, error } = await bucket.download(objectPath);
      if (error) {
        const status = String((error as { statusCode?: string | number }).statusCode ?? "");
        if (status === "404" || (status === "400" && /not found|does not exist/i.test(error.message))) return null;
        throw new QwenLayerError("layer_checkpoint_unavailable", "读取分层存档失败，未重复调用专用模型。");
      }
      if (!data || data.size > 64 * 1024 * 1024) throw new QwenLayerError("layer_checkpoint_invalid", "分层存档为空或超过大小限制。", 422);
      try { return JSON.parse(await data.text()); }
      catch { throw new QwenLayerError("layer_checkpoint_invalid", "分层存档损坏，未再次生成。", 422); }
    },
    async save(packet) {
      const buffer = Buffer.from(JSON.stringify(packet), "utf8");
      if (buffer.length > 64 * 1024 * 1024) throw new QwenLayerError("layer_checkpoint_invalid", "分层存档超过大小限制。", 422);
      const { error } = await bucket.upload(objectPath, buffer, { contentType: "application/json", upsert: true });
      if (error) throw new QwenLayerError("layer_checkpoint_unavailable", "分层结果已生成，但存档写入失败；未自动重新推理。");
    },
  };
}
