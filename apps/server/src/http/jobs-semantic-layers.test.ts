import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerJobRoutes } from "./jobs.js";

const ids = { user: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
  job: "33333333-3333-4333-8333-333333333333",
  model: "workspace:44444444-4444-4444-8444-444444444444" };
const user = { id: ids.user, accessToken: "test-token", email: "test@example.test", userMetadata: {} };
const apps: ReturnType<typeof Fastify>[] = [];
function job() { return { id: ids.job, workspace_id: ids.workspace, project_id: null,
  canvas_id: null, session_id: null, thread_id: null, queue_name: "image_generation_jobs",
  job_type: "image_generation", status: "queued", payload: {}, result: null,
  error_code: null, error_message: null, attempt_count: 0, max_attempts: 3,
  created_by: ids.user, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  started_at: null, completed_at: null, failed_at: null, canceled_at: null }; }
async function app() {
  const server = Fastify(); apps.push(server);
  const jobService = { createJob: vi.fn(async () => job()), enqueueJob: vi.fn(async () => {}),
    setCreditsInfo: vi.fn(async () => {}) };
  const creditService = { getSubscription: vi.fn(async () => ({ plan: "basic" })),
    deductCreditsIdempotent: vi.fn(async () => ({ transactionId: ids.job, chargedNew: true })) };
  const tierGuard = { checkModelAccess: vi.fn(), checkResolution: vi.fn(),
    checkConcurrency: vi.fn(), calculateCreditCost: vi.fn(() => 12) };
  const catalog = { listPublished: vi.fn(async () => [{ model: {
      id: ids.model, displayName: "GPT Image Flare", modality: "image",
      capabilities: ["image_generation"] }, upstreamModelId: "gpt-image-2.5-flare" }]),
    resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2.5-flare" })) };
  await registerJobRoutes(server, { auth: { authenticate: async () => user },
    viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never,
    jobService: jobService as never, creditService: creditService as never,
    tierGuard: tierGuard as never, workspaceModelCatalogService: catalog as never });
  return { server, jobService, creditService, tierGuard, catalog };
}

describe("published semantic layer splitting", () => {
  afterEach(async () => { await Promise.all(apps.splice(0).map(server => server.close())); });
  it("quotes the complete bounded model bill before submitting", async () => {
    const { server, jobService, creditService } = await app();
    const response = await server.inject({ method: "GET",
      url: "/api/images/semantic-layer-backend?layer_count=2" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, model: ids.model,
      displayName: "GPT Image Flare", calls: 3, credits: 36,
      quality: "standard", resolution: "1k" });
    expect(jobService.createJob).not.toHaveBeenCalled();
    expect(creditService.deductCreditsIdempotent).not.toHaveBeenCalled();
  });
  it("charges all three stages once and freezes the actual published alias", async () => {
    const { server, jobService, creditService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation",
      payload: { operation: "split_layers", layer_backend: "semantic",
        layer_names: ["蛇形角色", "右侧人物"], repair_background: true,
        prompt: "拆出人物，修补背景", quality: "standard", resolution: "1k",
        input_images: ["https://example.test/source.png"] } });
    expect(response.statusCode).toBe(201);
    expect(jobService.createJob).toHaveBeenCalledWith(user, expect.objectContaining({
      providerBilling: expect.objectContaining({ creditsCost: 36 }),
      payload: expect.objectContaining({ model: ids.model,
        layer_backend: "semantic", layer_names: ["蛇形角色", "右侧人物"] }) }));
    expect(creditService.deductCreditsIdempotent).toHaveBeenCalledWith(ids.workspace,
      ids.user, 36, ids.job, expect.any(String));
  });
  it("rejects an unapproved model before creating a paid job", async () => {
    const { server, jobService, creditService } = await app();
    const response = await server.inject({ method: "POST", url: "/api/jobs/image-generation",
      payload: { operation: "split_layers", layer_backend: "semantic",
        layer_names: ["a", "b"], repair_background: true,
        model: "gpt-image-2.5-flare", prompt: "拆分",
        input_images: ["https://example.test/source.png"] } });
    expect(response.statusCode).toBe(409);
    expect(jobService.createJob).not.toHaveBeenCalled();
    expect(creditService.deductCreditsIdempotent).not.toHaveBeenCalled();
  });
});
