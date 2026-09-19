import { getServerBaseUrl } from "./env";

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
export function imageToolOperationModel(operation: string) {
  if (operation === "remove-background" || operation === "remove_background") return "gpt-image-2";
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
