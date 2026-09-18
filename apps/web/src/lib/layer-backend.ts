import { getServerBaseUrl } from "./env";

export type LayerBackendStatus = { configured: boolean; available: boolean; model: "qwen-image-layered"; reason: string; remote: boolean };
export type SemanticLayerQuote = {
  available: true;
  model: string;
  displayName: string;
  calls: number;
  credits: number;
  quality: "standard";
  resolution: "1k";
  layerCount: number;
};
export function imageToolOperationModel(operation: string, layerBackend?: "qwen-image-layered" | "semantic") {
  if (operation === "remove-background" || operation === "remove_background") return "gpt-image-2";
  if ((operation === "split-layers" || operation === "split_layers") && layerBackend === "qwen-image-layered") return "qwen-image-layered";
  return "local:feynobg";
}
export async function fetchSemanticLayerQuote(accessToken: string, layerCount: number): Promise<SemanticLayerQuote> {
  const response = await fetch(`${getServerBaseUrl()}/api/images/semantic-layer-backend?layer_count=${layerCount}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("无法读取 AI 图层拆分报价，请稍后重试。");
  const value = await response.json();
  if (value?.available !== true || typeof value.model !== "string" || typeof value.displayName !== "string" || !Number.isFinite(value.calls) || !Number.isFinite(value.credits)
    || value.quality !== "standard" || value.resolution !== "1k" || value.layerCount !== layerCount) throw new Error("AI 图层拆分报价返回无效数据。");
  return value;
}
export async function fetchLayerBackend(accessToken: string): Promise<LayerBackendStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/images/layer-backend`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("专用分层服务状态读取失败，请稍后重试。");
  const value = await response.json();
  if (value?.model !== "qwen-image-layered" || typeof value.configured !== "boolean" || typeof value.available !== "boolean"
    || typeof value.reason !== "string" || typeof value.remote !== "boolean") throw new Error("专用分层服务返回了无效的配置状态。");
  return { configured: value.configured, available: value.available, model: value.model, reason: value.reason.slice(0, 1000), remote: value.remote };
}
