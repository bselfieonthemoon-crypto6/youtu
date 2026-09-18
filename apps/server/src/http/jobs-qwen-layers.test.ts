import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerJobRoutes } from "./jobs.js";
import { checkQwenLayerBackend } from "../features/images/qwen-layer-separation.js";
vi.mock("../features/images/qwen-layer-separation.js", async original => ({ ...await original<typeof import("../features/images/qwen-layer-separation.js")>(), checkQwenLayerBackend: vi.fn() }));
const ids = { user: "11111111-1111-4111-8111-111111111111", workspace: "22222222-2222-4222-8222-222222222222", job: "33333333-3333-4333-8333-333333333333" };
const status = { configured: true, available: true, model: "qwen-image-layered", remote: false, reason: "专用模型已就绪" };
const user = { id: ids.user, accessToken: "test-token", email: "test@example.test", userMetadata: {} };
function job() { return { id: ids.job, workspace_id: ids.workspace, project_id: null, canvas_id: null, session_id: null, thread_id: null, queue_name: "image_generation_jobs", job_type: "image_generation", status: "queued", payload: {}, result: null, error_code: null, error_message: null, attempt_count: 0, max_attempts: 3, created_by: ids.user, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: null, completed_at: null, failed_at: null, canceled_at: null }; }
const apps: ReturnType<typeof Fastify>[] = [];
async function app(authenticated = true) {
  const server = Fastify(); apps.push(server);
  const jobService = { createJob: vi.fn(async () => job()), enqueueJob: vi.fn(async () => {}) };
  const creditService = { getSubscription: vi.fn(), deductCredits: vi.fn() };
  await registerJobRoutes(server, { auth: { authenticate: async () => authenticated ? user : null }, viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never, jobService: jobService as never, creditService: creditService as never });
  return { server, jobService, creditService };
}
describe("dedicated Qwen layer job route", () => {
  afterEach(async () => { vi.mocked(checkQwenLayerBackend).mockReset(); await Promise.all(apps.splice(0).map(server => server.close())); });
  it("requires authentication before backend probing", async () => {
    const { server } = await app(false);
    expect((await server.inject({ method: "GET", url: "/api/images/layer-backend" })).statusCode).toBe(401);
    expect(checkQwenLayerBackend).not.toHaveBeenCalled();
  });
  it("exposes safe readiness, not an endpoint or token", async () => {
    vi.mocked(checkQwenLayerBackend).mockResolvedValue({ ...status, configured: false, available: false, reason: "尚未配置" });
    const { server } = await app();
    const response = await server.inject({ method: "GET", url: "/api/images/layer-backend" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...status, configured: false, available: false, reason: "尚未配置" });
    expect(response.body).not.toMatch(/url|token|secret/i);
  });
  it("fails before job creation or charging when the dedicated model is unavailable", async () => {
    vi.mocked(checkQwenLayerBackend).mockResolvedValue({ ...status, available: false, reason: "专用模型未配置，不会回退" });
    const { server, jobService, creditService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { operation: "split_layers", model: "qwen-image-layered", prompt: "拆分", input_images: ["https://example.test/source.png"] } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "layer_backend_unavailable" } });
    expect(jobService.createJob).not.toHaveBeenCalled();
    expect(creditService.getSubscription).not.toHaveBeenCalled();
  });
  it("preserves the dedicated model and uses the durable existing queue", async () => {
    vi.mocked(checkQwenLayerBackend).mockResolvedValue(status);
    const { server, jobService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { operation: "split_layers", model: "qwen-image-layered", prompt: "拆分", input_images: ["https://example.test/source.png"] } });
    expect(response.statusCode).toBe(201);
    expect(jobService.createJob).toHaveBeenCalledWith(user, expect.objectContaining({ deferEnqueue: true, payload: expect.objectContaining({ operation: "split_layers", model: "qwen-image-layered" }) }));
    expect(jobService.enqueueJob).toHaveBeenCalledTimes(1);
  });
  it("keeps legacy split_layers local unless the user explicitly selects Qwen", async () => {
    const { server, jobService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { operation: "split_layers", prompt: "拆分", input_images: ["https://example.test/source.png"] } });
    expect(response.statusCode).toBe(201);
    expect(jobService.createJob).toHaveBeenCalledWith(user, expect.objectContaining({ payload: expect.objectContaining({ model: "local:feynobg" }) }));
    expect(checkQwenLayerBackend).not.toHaveBeenCalled();
  });
  it.each(["Qwen/Qwen-Image-Layered", "qwen-image-layered-all"])("does not silently run local matting for unsupported model %s", async model => {
    const { server, jobService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { operation: "split_layers", model, prompt: "拆分", input_images: ["https://example.test/source.png"] } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "invalid_input" } });
    expect(jobService.createJob).not.toHaveBeenCalled();
    expect(checkQwenLayerBackend).not.toHaveBeenCalled();
  });
  it.each([
    { operation: "remove_background", model: "qwen-image-layered", input_images: ["https://example.test/source.png"] },
    { operation: "split_layers", model: "qwen-image-layered", input_images: [] },
    { operation: "split_layers", model: "qwen-image-layered", input_images: ["https://example.test/a.png", "https://example.test/b.png"] },
  ])("rejects incompatible operation/source %#", async payload => {
    const { server, jobService } = await app();
    expect((await server.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { prompt: "拆分", ...payload } })).statusCode).toBe(422);
    expect(jobService.createJob).not.toHaveBeenCalled();
  });
  it("does not accept a user-selected service URL or token", async () => {
    const { server, jobService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { operation: "split_layers", model: "qwen-image-layered", prompt: "拆分", input_images: ["https://example.test/source.png"], backend_url: "https://unapproved.example.test", token: "not-authorized" } });
    expect(response.statusCode).toBe(400);
    expect(checkQwenLayerBackend).not.toHaveBeenCalled();
    expect(jobService.createJob).not.toHaveBeenCalled();
  });
});
