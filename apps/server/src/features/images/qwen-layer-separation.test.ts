import { createHash } from "node:crypto";
import { createServer } from "node:http";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkQwenLayerBackend, getQwenLayerBackendStatus, processWithQwenLayers, QWEN_UPSTREAM_MODEL, validateQwenLayerPacket } from "./qwen-layer-separation.js";

const jobId = "11111111-2222-4333-8444-555555555555";
const env = { LOOMIC_QWEN_LAYER_URL: "http://127.0.0.1:8875", LOOMIC_QWEN_LAYER_TOKEN: "not-logged" };
const health = { protocol_version: 1, model_id: QWEN_UPSTREAM_MODEL, model_loaded: true, idempotency: true };
async function fixtures() {
  const source = await sharp({ create: { width: 12, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const layers = await Promise.all([0, 1, 2, 3].map(async index => ({ index, png_base64: (await sharp({ create: { width: 6, height: 4, channels: 4, background: { r: 50 + index, g: index, b: 0, alpha: index === 0 ? 1 : 0.5 } } }).png().toBuffer()).toString("base64") })));
  const normalized = await sharp(source).rotate().png().toBuffer();
  const packet = { ...health, request_id: jobId, source_sha256: createHash("sha256").update(normalized).digest("hex"), order: "back-to-front", width: 6, height: 4, layers };
  return { source, packet, validation: { jobId, sourceSha256: packet.source_sha256, width: 12, height: 8, layerCount: 4 } };
}
describe("dedicated Qwen layer backend", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("rechecks cancellation after health before starting remote inference", async () => {
    const { source } = await fixtures();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(health));
    const beforeInference = vi.fn(async () => {
      throw Object.assign(new Error("canceled"), { code: "job_canceled" });
    });
    await expect(processWithQwenLayers(source, { jobId, beforeInference }, { env, fetch: fetcher }))
      .rejects.toMatchObject({ code: "job_canceled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(beforeInference).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]?.method).toBe("GET");
  });
  it("does not send images or pretend ready when no backend is configured", async () => {
    const fetcher = vi.fn();
    expect(getQwenLayerBackendStatus({})).toMatchObject({ configured: false, available: false });
    expect(await checkQwenLayerBackend({ env: {}, fetch: fetcher })).toMatchObject({ available: false });
    const { source } = await fixtures();
    await expect(processWithQwenLayers(source, { jobId }, { env: {}, fetch: fetcher })).rejects.toMatchObject({ code: "layer_backend_unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { LOOMIC_QWEN_LAYER_URL: "https://remote.example.test" },
    { LOOMIC_QWEN_LAYER_URL: "http://remote.example.test", LOOMIC_QWEN_LAYER_ALLOW_REMOTE: "true" },
    { LOOMIC_QWEN_LAYER_URL: "https://user:password@remote.example.test", LOOMIC_QWEN_LAYER_ALLOW_REMOTE: "true" },
    { LOOMIC_QWEN_LAYER_URL: "http://127.0.0.1:8875?token=secret" },
  ])("fails closed on unauthorized/unsafe endpoint %#", async config => {
    const fetcher = vi.fn();
    expect(await checkQwenLayerBackend({ env: config, fetch: fetcher })).toMatchObject({ available: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies the dedicated model and durable idempotency before posting a source", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...health, model_id: "BiRefNet" }));
    const { source } = await fixtures();
    await expect(processWithQwenLayers(source, { jobId }, { env, fetch: fetcher })).rejects.toMatchObject({ code: "layer_backend_model_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error" });
  });
  it("rejects missing idempotency support", async () => {
    expect(await checkQwenLayerBackend({ env, fetch: vi.fn(async () => Response.json({ ...health, idempotency: false })) })).toMatchObject({ available: false });
  });
  it("sends real HTTP protocol data to a loopback fixture and preserves all ordered RGBA layers", async () => {
    const { source, packet } = await fixtures();
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/health") return response.end(JSON.stringify(health));
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(packet));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const result = await processWithQwenLayers(source, { jobId }, { env: { ...env, LOOMIC_QWEN_LAYER_URL: `http://127.0.0.1:${port}` } });
      expect(result).toMatchObject({ model: QWEN_UPSTREAM_MODEL, width: 12, height: 8 });
      expect(result.layers).toHaveLength(4);
      for (const [index, layer] of result.layers.entries()) {
        expect(layer).toMatchObject({ index, width: 12, height: 8, x: 0, y: 0, kind: index === 0 ? "background" : "element" });
        expect(await sharp(layer.buffer).metadata()).toMatchObject({ format: "png", hasAlpha: true, width: 12, height: 8 });
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ headers: { "idempotency-key": jobId, authorization: "Bearer not-logged" }, body: { request_id: jobId, model_id: QWEN_UPSTREAM_MODEL, layers: 4, resolution: 640, seed: 777 } });
      expect(requests[0].body).not.toHaveProperty("url");
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("replays a private raw checkpoint without network after layer storage interruption", async () => {
    const { source, packet } = await fixtures();
    let cached: unknown = null;
    const checkpoint = { load: vi.fn(async () => cached), save: vi.fn(async value => { cached = structuredClone(value); }) };
    const fetcher = vi.fn(async (_url, init) => Response.json(init.method === "GET" ? health : packet));
    await processWithQwenLayers(source, { jobId, checkpoint }, { env, fetch: fetcher });
    const replay = await processWithQwenLayers(source, { jobId, checkpoint }, { env: {}, fetch: fetcher });
    expect(replay.layers).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(checkpoint.save).toHaveBeenCalledTimes(1);
  });
  it.each(["model", "task", "source", "order", "count", "dimensions", "duplicate", "empty", "opaque", "jpeg"])("rejects invalid %s output before checkpointing", async failure => {
    const { packet, validation } = await fixtures();
    if (failure === "model") packet.model_id = "FeyNoBG";
    if (failure === "task") packet.request_id = "another";
    if (failure === "source") packet.source_sha256 = "another";
    if (failure === "order") packet.order = "front-to-back";
    if (failure === "count") packet.layers.pop();
    if (failure === "dimensions") packet.width = 8;
    if (failure === "duplicate") packet.layers[1]!.png_base64 = packet.layers[0]!.png_base64;
    if (failure === "empty") packet.layers[1]!.png_base64 = (await sharp({ create: { width: 6, height: 4, channels: 4, background: "transparent" } }).png().toBuffer()).toString("base64");
    if (failure === "opaque") for (const layer of packet.layers) layer.png_base64 = (await sharp(Buffer.from(layer.png_base64, "base64")).removeAlpha().ensureAlpha().png().toBuffer()).toString("base64");
    if (failure === "jpeg") packet.layers[1]!.png_base64 = (await sharp(Buffer.from(packet.layers[1]!.png_base64, "base64")).jpeg().toBuffer()).toString("base64");
    await expect(validateQwenLayerPacket(packet, validation)).rejects.toMatchObject({ code: "layer_output_invalid" });
  });
  it("rejects oversized streamed responses and never retries a timed-out inference", async () => {
    const { source } = await fixtures();
    const oversized = vi.fn(async () => new Response("{}", { headers: { "content-length": String(65 * 1024 * 1024) } }));
    expect(await checkQwenLayerBackend({ env, fetch: oversized })).toMatchObject({ available: false });
    const timeout = vi.fn(async (_url, init) => {
      if (init.method === "GET") return Response.json(health);
      throw new DOMException("timeout", "TimeoutError");
    });
    await expect(processWithQwenLayers(source, { jobId }, { env, fetch: timeout })).rejects.toMatchObject({ code: "layer_backend_timeout" });
    expect(timeout).toHaveBeenCalledTimes(2);
  });
});
