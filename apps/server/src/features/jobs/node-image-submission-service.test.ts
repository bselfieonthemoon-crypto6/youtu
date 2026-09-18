import { describe, expect, it, vi } from "vitest";
import { createNodeImageSubmissionService } from "./node-image-submission-service.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), accessToken: "test-token", email: "", userMetadata: {} };
const request = { request_id: uuid(2), canvas_id: uuid(3), element_id: "node-1", prompt: "  元旦\n保持字体  ", model: `workspace:${uuid(4)}`, aspect_ratio: "1:1", quality: "hd" } as const;
const frozen = { prompt: request.prompt, model: request.model, aspect_ratio: request.aspect_ratio, quality: request.quality };

function setup() {
  const state = { canvas: { id: uuid(3), workspace_id: uuid(5), project_id: uuid(6) } as any,
    project: { archived_at: null } as any, existing: null as any, lookupError: null as any,
    rpcError: null as any, rpcData: { job_id: uuid(7), replayed: false } as any };
  const getJob = vi.fn(async () => ({ id: uuid(7), created_by: user.id, canvas_id: uuid(3), job_type: "image_generation", status: "queued" } as any));
  const client = { from: (table: string) => {
    const builder = { select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: table === "canvases" ? state.canvas : table === "projects" ? state.project : state.existing,
        error: table === "node_image_submissions" ? state.lookupError : null }) };
    return builder;
  } };
  const rpc = vi.fn(async (_name: string, args: any) => {
    if (!state.rpcError && state.rpcData) state.existing = { canvas_id: args.p_canvas, element_id: args.p_element, input: args.p_input, job_id: uuid(7) };
    return { data: state.rpcData, error: state.rpcError };
  });
  const catalog = { resolvePublishedModel: vi.fn(async () => ({ capabilities: ["image_generation"], upstreamModelId: "gpt-image-2", revision: 3 })) };
  const credits = { getSubscription: vi.fn(async () => ({ plan: "pro" })), deductCredits: vi.fn() };
  const tier = { checkModelAccess: vi.fn(), checkResolution: vi.fn(), checkVideoResolution: vi.fn(), checkConcurrency: vi.fn(), calculateCreditCost: vi.fn(() => 8) };
  const service = createNodeImageSubmissionService({ createUserClient: () => client as never, getAdminClient: () => ({ rpc }) as never,
    jobService: { getJob } as never, creditService: credits as never, tierGuard: tier,
    workspaceModelCatalogService: catalog as never, builtinModels: () => [{ id: "gpt-image-2" }] });
  return { service, state, rpc, getJob, credits, tier, catalog };
}

describe("durable node image submission", () => {
  it("preserves exact prompt and uses target workspace, selected quality and frozen model", async () => {
    const t = setup();
    expect(await t.service.submit(user, request)).toMatchObject({ replayed: false, job: { id: uuid(7) } });
    expect(t.catalog.resolvePublishedModel).toHaveBeenCalledWith(user, uuid(5), request.model, "image");
    expect(t.tier.checkResolution).toHaveBeenCalledWith("pro", "hd");
    expect(t.tier.calculateCreditCost).toHaveBeenCalledWith("gpt-image-2", "image_generation", { quality: "hd" });
    expect(t.rpc).toHaveBeenCalledWith("loomic_submit_node_image", expect.objectContaining({ p_user: user.id, p_request: request.request_id,
      p_input: frozen, p_cost: 8, p_provider_revision: 3, p_upstream_model: "gpt-image-2" }));
    expect(t.credits.deductCredits).not.toHaveBeenCalled(); // Only the atomic transaction may debit.
  });
  it("lost response recovery reads the same job without another submission or price check", async () => {
    const t = setup(); await t.service.submit(user, request);
    t.catalog.resolvePublishedModel.mockRejectedValue(new Error("model disabled later"));
    expect(await t.service.get(user, { requestId: uuid(2), canvasId: uuid(3), elementId: "node-1" })).toMatchObject({ job: { id: uuid(7) } });
    expect(await t.service.submit(user, request)).toMatchObject({ replayed: true });
    expect(t.rpc).toHaveBeenCalledTimes(1);
    expect(t.credits.getSubscription).toHaveBeenCalledTimes(1);
  });
  it.each(["succeeded", "failed", "canceled", "dead_letter"])("replays %s instead of regenerating", async status => {
    const t = setup(); await t.service.submit(user, request);
    t.getJob.mockResolvedValue({ id: uuid(7), created_by: user.id, canvas_id: uuid(3), job_type: "image_generation", status });
    expect(await t.service.submit(user, request)).toMatchObject({ replayed: true, job: { status } });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([{ prompt: "different" }, { model: "gpt-image-2" }, { quality: "ultra" }, { element_id: "another" }])("rejects changed input under the same key: %j", async change => {
    const t = setup(); await t.service.submit(user, request);
    await expect(t.service.submit(user, { ...request, ...change })).rejects.toMatchObject({ code: "node_submission_conflict" });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(["node_canvas_forbidden", "node_not_saved", "node_generation_active", "node_model_changed", "insufficient_credits"])("maps atomic failure %s without a second call", async code => {
    const t = setup(); t.state.rpcError = { message: code };
    await expect(t.service.submit(user, request)).rejects.toMatchObject({ code });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it("unknown transport errors and malformed success are not success or retry authorization", async () => {
    const t = setup(); t.state.rpcError = { message: "internal connection string is private" };
    await expect(t.service.submit(user, request)).rejects.toMatchObject({ code: "node_submission_unavailable", statusCode: 503 });
    t.state.rpcError = null; t.state.rpcData = {};
    await expect(t.service.submit(user, request)).rejects.toMatchObject({ code: "node_submission_unavailable" });
  });
  it("not found is distinct from failed lookup", async () => {
    const t = setup(); const key = { requestId: uuid(2), canvasId: uuid(3), elementId: "node-1" };
    expect(await t.service.get(user, key)).toEqual({ job: null });
    t.state.lookupError = { message: "offline" };
    await expect(t.service.get(user, key)).rejects.toMatchObject({ code: "node_submission_unavailable" });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it("readable canvas and unarchived project remain prerequisites for replay", async () => {
    const t = setup(); await t.service.submit(user, request); t.state.project.archived_at = "2026-09-09";
    await expect(t.service.submit(user, request)).rejects.toMatchObject({ code: "node_canvas_forbidden" });
    t.state.project.archived_at = null; t.state.canvas = null;
    await expect(t.service.get(user, { requestId: uuid(2), canvasId: uuid(3), elementId: "node-1" })).rejects.toMatchObject({ code: "node_canvas_forbidden" });
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });
  it("refuses unavailable models instead of switching to another model", async () => {
    const t = setup(); t.catalog.resolvePublishedModel.mockResolvedValue(null as never);
    await expect(t.service.submit(user, request)).rejects.toMatchObject({ code: "node_model_unavailable" });
    await expect(t.service.submit(user, { ...request, model: "unknown" })).rejects.toMatchObject({ code: "node_model_unavailable" });
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it("does not accept input images, caller price, job identity or Agent approval fields", async () => {
    const t = setup();
    for (const field of ["input_images", "cost", "job_id", "proposalId", "confirmed"]) {
      await expect(t.service.submit(user, { ...request, [field]: "bad" })).rejects.toThrow();
    }
    expect(t.rpc).not.toHaveBeenCalled();
  });
});
