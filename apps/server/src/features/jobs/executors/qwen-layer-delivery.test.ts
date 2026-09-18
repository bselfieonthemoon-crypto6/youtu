import { createServer } from "node:http";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getExecutor } from "../job-executor.js";
import { processWithFeynobg } from "../../images/feynobg-service.js";
import { QWEN_UPSTREAM_MODEL } from "../../images/qwen-layer-separation.js";
import { createQwenLayerCheckpoint } from "./qwen-layer-checkpoint.js";
import "./image-generation.js";
vi.mock("../../images/feynobg-service.js", () => ({ processWithFeynobg: vi.fn(async () => { throw new Error("Local removal must not run for a dedicated model"); }) }));

const jobId = "11111111-2222-4333-8444-555555555555";
const workspaceId = "22222222-2222-4222-8222-222222222222";
function memoryAssets() {
  const records = new Map<string, any>();
  const objects = new Map<string, Buffer>();
  let failSign = false;
  const storage = {
    download: vi.fn(async (path: string) => objects.has(path) ? { data: new Blob([objects.get(path)!]), error: null } : { data: null, error: { statusCode: "404", message: "Object not found" } }),
    upload: vi.fn(async (path: string, bytes: Buffer) => { objects.set(path, Buffer.from(bytes)); return { error: null }; }),
    createSignedUrl: vi.fn(async (path: string) => {
      if (failSign) { failSign = false; return { data: null, error: { message: "simulated signing interruption" } }; }
      return { data: { signedUrl: `https://private.example.test/${path}` }, error: null };
    }),
  };
  const admin = {
    storage: { from: vi.fn(() => storage) },
    from: vi.fn(() => {
      let selectedId: string;
      const query = {
        select: vi.fn(() => query), eq: vi.fn((_key, value) => { selectedId = value; return query; }),
        maybeSingle: vi.fn(async () => ({ data: records.get(selectedId) ?? null, error: null })),
        upsert: vi.fn(row => { records.set(row.id, structuredClone(row)); return { select: () => ({ single: async () => ({ data: row, error: null }) }) }; }),
      };
      return query;
    }),
  };
  return { admin, storage, objects, records, failNextSign: () => { failSign = true; } };
}

describe("dedicated layer job checkpoint and asset delivery", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("runs the real executor and protocol, survives asset-signing failure without rerunning the model", async () => {
    const source = await sharp({ create: { width: 8, height: 6, channels: 4, background: "white" } }).png().toBuffer();
    const layers = await Promise.all([0, 1, 2, 3].map(async index => ({ index, png_base64: (await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: index + 3, g: 80, b: 40, alpha: index === 0 ? 1 : 0.5 } } }).png().toBuffer()).toString("base64") })));
    let posts = 0;
    const server = createServer(async (req, res) => {
      const health = { protocol_version: 1, model_id: QWEN_UPSTREAM_MODEL, model_loaded: true, idempotency: true };
      if (req.url === "/health") return res.end(JSON.stringify(health));
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString()); posts++;
      res.end(JSON.stringify({ ...health, request_id: request.request_id, source_sha256: request.source_sha256, order: "back-to-front", width: 8, height: 6, layers }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("LOOMIC_QWEN_LAYER_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const assets = memoryAssets();
    const row = { id: jobId, workspace_id: workspaceId, project_id: null, canvas_id: null, session_id: null, thread_id: null, queue_name: "image_generation_jobs", job_type: "image_generation", status: "running", payload: { operation: "split_layers", model: "qwen-image-layered", prompt: "Split the existing poster", input_images: [`data:image/png;base64,${source.toString("base64")}`], target: null }, result: null, error_code: null, error_message: null, attempt_count: 1, max_attempts: 3, created_by: jobId, created_at: "2026-09-09", updated_at: "2026-09-09", started_at: "2026-09-09", completed_at: null, failed_at: null, canceled_at: null };
    const context = { getAdminClient: () => assets.admin, jobService: { getJobAdmin: async () => row }, renewVt: vi.fn() };
    const executor = getExecutor("image_generation")!;
    try {
      assets.failNextSign();
      await expect(executor(jobId, {}, context as never)).rejects.toThrow("private image URL");
      expect(posts).toBe(1);
      expect(assets.objects.has(`${workspaceId}/generated/${jobId}-qwen-layer-checkpoint.json`)).toBe(true);
      const result = await executor(jobId, {}, context as never);
      expect(result).toMatchObject({ model: QWEN_UPSTREAM_MODEL, operation: "split_layers", source_width: 8, source_height: 6 });
      expect(result.layers).toHaveLength(4);
      expect(assets.records.size).toBe(4);
      expect(assets.storage.upload).toHaveBeenCalledTimes(5); // raw checkpoint + exactly four layer files
      expect(posts).toBe(1);
      expect(processWithFeynobg).not.toHaveBeenCalled();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("does not ignore a checkpoint permission/read failure and regenerate", async () => {
    const admin = { storage: { from: () => ({ download: async () => ({ data: null, error: { statusCode: "403", message: "denied" } }) }) } };
    await expect(createQwenLayerCheckpoint(admin as never, workspaceId, jobId).load()).rejects.toMatchObject({ code: "layer_checkpoint_unavailable" });
  });
  it("does not permit arbitrary checkpoint path construction", () => {
    expect(() => createQwenLayerCheckpoint({} as never, workspaceId, "../../outside")).toThrow("范围无效");
  });
});
