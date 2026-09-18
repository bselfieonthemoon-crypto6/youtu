import { createHash } from "node:crypto";
import sharp, { type OutputInfo } from "sharp";
import { Agent, fetch as undiciFetch } from "undici";
import type { FeynobgResult } from "./feynobg-service.js";
import { isUuid } from "@loomic/shared";

export const QWEN_LAYER_MODEL = "qwen-image-layered";
export const QWEN_UPSTREAM_MODEL = "Qwen/Qwen-Image-Layered";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
// The worker may have a global proxy. A loopback inference request must never
// accidentally send private image bytes through that proxy.
const directDispatcher = new Agent({ keepAliveTimeout: 1000 });
const directFetch: typeof fetch = (url, init) => undiciFetch(url as string, { ...init, dispatcher: directDispatcher } as never) as unknown as Promise<Response>;

export class QwenLayerError extends Error {
  readonly statusCode: number;
  constructor(readonly code: string, message: string, statusCode = 503) {
    super(message);
    this.name = "QwenLayerError";
    this.statusCode = statusCode;
  }
}
export type QwenLayerStatus = { configured: boolean; available: boolean; model: string; reason: string; remote: boolean };
type BackendConfig = { url: URL; token?: string; remote: boolean; timeoutMs: number };
type BackendDependencies = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch };

function readConfig(env: NodeJS.ProcessEnv): BackendConfig {
  const raw = env.LOOMIC_QWEN_LAYER_URL?.trim();
  if (!raw) throw new QwenLayerError("layer_backend_unconfigured", "尚未配置 Qwen-Image-Layered 专用分层服务；不会改用普通抠图冒充分层。");
  let url: URL;
  try { url = new URL(raw); } catch { throw new QwenLayerError("layer_backend_config_invalid", "专用分层服务地址配置无效。"); }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol))
    throw new QwenLayerError("layer_backend_config_invalid", "专用分层服务地址不能包含凭据、查询参数或片段。");
  if (!loopback && (env.LOOMIC_QWEN_LAYER_ALLOW_REMOTE !== "true" || url.protocol !== "https:"))
    throw new QwenLayerError("layer_backend_remote_not_authorized", "远程分层服务需要管理员明确允许并配置 HTTPS；尚未发送任何图片。");
  const timeoutMs = Number(env.LOOMIC_QWEN_LAYER_TIMEOUT_MS ?? 600_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000)
    throw new QwenLayerError("layer_backend_config_invalid", "专用分层超时必须在 1 秒到 30 分钟之间。");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const token = env.LOOMIC_QWEN_LAYER_TOKEN?.trim();
  return { url, ...(token ? { token } : {}), remote: !loopback, timeoutMs };
}

export function getQwenLayerBackendStatus(env: NodeJS.ProcessEnv = process.env): QwenLayerStatus {
  try {
    const config = readConfig(env);
    return { configured: true, available: false, model: QWEN_LAYER_MODEL, remote: config.remote, reason: "已配置，尚未验证专用模型服务。" };
  } catch (error) {
    return { configured: !!env.LOOMIC_QWEN_LAYER_URL?.trim(), available: false, model: QWEN_LAYER_MODEL, remote: false, reason: error instanceof QwenLayerError ? error.message : "专用分层配置不可用。" };
  }
}

async function readBoundedJson(response: Response, maximum = MAX_BYTES): Promise<any> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new QwenLayerError("layer_output_invalid", "专用分层响应超过大小限制。", 422);
  }
  if (!response.body) throw new QwenLayerError("layer_output_invalid", "专用分层服务返回空响应。", 422);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > maximum) throw new QwenLayerError("layer_output_invalid", "专用分层响应超过累计大小限制。", 422);
      chunks.push(value.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new QwenLayerError("layer_output_invalid", "专用分层服务未返回有效 JSON。", 422); }
}

async function request(config: BackendConfig, path: string, init: RequestInit, fetcher = directFetch, health = false) {
  try {
    const response = await fetcher(new URL(path, config.url), {
      ...init, redirect: "error", signal: AbortSignal.timeout(health ? 3000 : config.timeoutMs),
      headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}), ...init.headers },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new QwenLayerError("layer_backend_unavailable", `专用分层服务返回 HTTP ${response.status}，未改用其他模型。`);
    }
    return await readBoundedJson(response, health ? 16_384 : MAX_BYTES);
  } catch (error) {
    if (error instanceof QwenLayerError) throw error;
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    throw new QwenLayerError(timedOut ? "layer_backend_timeout" : "layer_backend_unavailable", timedOut ? "专用分层服务超时，未重新提交推理或切换模型。" : "无法连接专用分层服务，未发送到其他服务。");
  }
}

function validHealth(value: any): boolean {
  return value?.protocol_version === 1 && value.model_id === QWEN_UPSTREAM_MODEL && value.model_loaded === true && value.idempotency === true;
}
export async function checkQwenLayerBackend(deps: BackendDependencies = {}): Promise<QwenLayerStatus> {
  const status = getQwenLayerBackendStatus(deps.env);
  try {
    const config = readConfig(deps.env ?? process.env);
    if (!validHealth(await request(config, "health", { method: "GET" }, deps.fetch, true)))
      throw new QwenLayerError("layer_backend_model_unavailable", "服务未加载 Qwen-Image-Layered 或不支持安全幂等协议，暂不可用。");
    return { ...status, available: true, reason: "专用模型服务已就绪；外部服务或算力可能产生费用，不代表免费。结果仍需视觉核对，不能恢复原始字体或 PSD。" };
  } catch (error) {
    return { ...status, available: false, reason: error instanceof QwenLayerError ? error.message : "专用分层服务不可用。" };
  }
}

export type QwenLayerPacket = {
  protocol_version: 1; model_id: string; request_id: string; source_sha256: string;
  order: "back-to-front"; width: number; height: number;
  layers: Array<{ index: number; png_base64: string }>;
};
export type QwenLayerCheckpoint = {
  load: () => Promise<unknown | null>;
  save: (packet: QwenLayerPacket) => Promise<void>;
};

/** Validate all outputs before returning any asset. A PNG extension is not alpha evidence. */
export async function validateQwenLayerPacket(packet: any, input: { jobId: string; sourceSha256: string; width: number; height: number; layerCount: number }): Promise<FeynobgResult> {
  if (packet?.protocol_version !== 1 || packet.model_id !== QWEN_UPSTREAM_MODEL || packet.request_id !== input.jobId || packet.source_sha256 !== input.sourceSha256 || packet.order !== "back-to-front")
    throw new QwenLayerError("layer_output_invalid", "专用分层结果的模型、原图、任务或层序不匹配。", 422);
  if (!Number.isInteger(packet.width) || !Number.isInteger(packet.height) || packet.width < 1 || packet.height < 1 || packet.width * packet.height > MAX_PIXELS || !Array.isArray(packet.layers) || packet.layers.length !== input.layerCount)
    throw new QwenLayerError("layer_output_invalid", "专用分层结果尺寸或图层数量无效。", 422);
  const layers: FeynobgResult["layers"] = [];
  let bytes = 0;
  let transparentLayers = 0;
  let normalizedBytes = 0;
  const hashes = new Set<string>();
  for (const [index, layer] of packet.layers.entries()) {
    if (layer?.index !== index || typeof layer.png_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(layer.png_base64) || layer.png_base64.length > MAX_SOURCE_BYTES * 4 / 3 + 4)
      throw new QwenLayerError("layer_output_invalid", "专用分层返回无效的 PNG 图层或层序。", 422);
    const buffer = Buffer.from(layer.png_base64, "base64");
    bytes += buffer.length;
    if (bytes > MAX_BYTES) throw new QwenLayerError("layer_output_invalid", "专用分层图层累计过大。", 422);
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hashes.has(hash)) throw new QwenLayerError("layer_output_invalid", "专用分层返回重复图层，未将重复原图视为成功。", 422);
    hashes.add(hash);
    try {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
      if (meta.format !== "png" || !meta.hasAlpha || (meta.pages ?? 1) !== 1 || meta.width !== packet.width || meta.height !== packet.height) throw new Error("not a matching RGBA PNG");
      const alpha = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).extractChannel("alpha").raw().toBuffer();
      if (!alpha.some(value => value > 0)) throw new Error("empty layer");
      if (alpha.some(value => value < 255)) transparentLayers++;
      // Every layer shares the same source-relative transform; no independent crop.
      const normalized = await sharp(buffer).resize(input.width, input.height, { fit: "fill" }).png().toBuffer();
      normalizedBytes += normalized.length;
      if (normalizedBytes > MAX_BYTES) throw new Error("normalized output budget exceeded");
      layers.push({ kind: index === 0 ? "background" : "element", index, buffer: normalized, x: 0, y: 0, width: input.width, height: input.height });
    } catch {
      throw new QwenLayerError("layer_output_invalid", "专用分层图层不是有效、非空、同尺寸 RGBA PNG。", 422);
    }
  }
  if (!transparentLayers) throw new QwenLayerError("layer_output_invalid", "专用分层未返回透明图层，未将普通图片视为分层结果。", 422);
  return { model: QWEN_UPSTREAM_MODEL, width: input.width, height: input.height, layers };
}

export async function processWithQwenLayers(source: Buffer, options: { jobId: string; layerCount?: number; checkpoint?: QwenLayerCheckpoint; beforeInference?: () => Promise<void> }, deps: BackendDependencies = {}): Promise<FeynobgResult> {
  const layerCount = options.layerCount ?? 4;
  if (!isUuid(options.jobId) || !Number.isInteger(layerCount) || layerCount < 2 || layerCount > 8 || source.length > MAX_SOURCE_BYTES)
    throw new QwenLayerError("invalid_input", "专用分层需要有效任务、单张原图和 2–8 层。", 422);
  let normalized: { data: Buffer; info: OutputInfo };
  try { normalized = await sharp(source, { limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer({ resolveWithObject: true }); }
  catch { throw new QwenLayerError("invalid_input", "专用分层原图不是有效图片或超过像素限制。", 422); }
  if (normalized.data.length > MAX_SOURCE_BYTES) throw new QwenLayerError("invalid_input", "专用分层原图解码后超过大小限制。", 422);
  const sourceSha256 = createHash("sha256").update(normalized.data).digest("hex");
  const validation = { jobId: options.jobId, sourceSha256, width: normalized.info.width, height: normalized.info.height, layerCount };
  if (options.checkpoint) {
    const cached = await options.checkpoint.load();
    if (cached !== null) return validateQwenLayerPacket(cached, validation);
  }
  const config = readConfig(deps.env ?? process.env);
  if (!validHealth(await request(config, "health", { method: "GET" }, deps.fetch, true)))
    throw new QwenLayerError("layer_backend_model_unavailable", "专用模型尚未加载或缺少幂等保护，未提交原图。");
  // Health/normalization can take time. Re-check the owning job immediately
  // before starting a new potentially paid remote inference request.
  await options.beforeInference?.();
  const packet = await request(config, "v1/layers", {
    method: "POST", headers: { "idempotency-key": options.jobId },
    body: JSON.stringify({ protocol_version: 1, request_id: options.jobId, model_id: QWEN_UPSTREAM_MODEL, source_sha256: sourceSha256, image_base64: normalized.data.toString("base64"), layers: layerCount, resolution: 640, seed: 777 }),
  }, deps.fetch);
  const result = await validateQwenLayerPacket(packet, validation);
  if (options.checkpoint) await options.checkpoint.save(packet as QwenLayerPacket);
  return result;
}
