import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNodeImageSubmissionRoutes } from "./node-image-submissions.js";
import { NodeImageSubmissionError } from "../features/jobs/node-image-submission-service.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = { id: id(1), accessToken: "token", email: "", userMetadata: {} };
const request = { request_id: id(2), canvas_id: id(3), element_id: "node-1", prompt: "  原样生成\n  ", model: "gpt-image-2", aspect_ratio: "1:1", quality: "hd" };
const job = { id: id(4), workspace_id: id(5), project_id: id(6), canvas_id: id(3), target_kind: "canvas", design_id: null,
  session_id: null, thread_id: null, queue_name: "image_generation_jobs", job_type: "image_generation", status: "queued", payload: {}, result: null,
  error_code: null, error_message: null, attempt_count: 0, max_attempts: 3, created_by: id(1), created_at: "2026-09-09", updated_at: "2026-09-09",
  started_at: null, completed_at: null, failed_at: null, canceled_at: null };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup(authenticated = true) {
  const service = { submit: vi.fn(async () => ({ job, replayed: false })), get: vi.fn(async () => ({ job: null })) };
  const app = Fastify(); apps.push(app);
  await registerNodeImageSubmissionRoutes(app, { auth: { authenticate: async () => authenticated ? user : null }, service: service as never });
  return { app, service };
}
describe("node submission routes", () => {
  it("returns a durable job and passes the literal prompt unchanged", async () => {
    const t = await setup(); const response = await t.app.inject({ method: "POST", url: "/api/jobs/node-image-generation", payload: request });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ job: { id: id(4) }, replayed: false });
    expect(t.service.submit).toHaveBeenCalledWith(user, request);
  });
  it("replay responds 200 without inventing a new submission", async () => {
    const t = await setup(); t.service.submit.mockResolvedValue({ job, replayed: true });
    const response = await t.app.inject({ method: "POST", url: "/api/jobs/node-image-generation", payload: request });
    expect(response.statusCode).toBe(200); expect(response.json().replayed).toBe(true);
  });
  it("lookup is read-only and distinguishes an unaccepted request", async () => {
    const t = await setup(); const response = await t.app.inject({ method: "GET", url: `/api/jobs/node-image-generation/${id(2)}?canvas_id=${id(3)}&element_id=node-1` });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ job: null });
    expect(t.service.get).toHaveBeenCalledWith(user, { requestId: id(2), canvasId: id(3), elementId: "node-1" });
    expect(t.service.submit).not.toHaveBeenCalled();
  });
  it("requires authentication for both operations", async () => {
    const t = await setup(false);
    for (const method of ["POST", "GET"] as const) {
      const response = await t.app.inject({ method, url: method === "POST" ? "/api/jobs/node-image-generation" : `/api/jobs/node-image-generation/${id(2)}`, ...(method === "POST" ? { payload: request } : {}) });
      expect(response.statusCode).toBe(401);
    }
    expect(t.service.submit).not.toHaveBeenCalled(); expect(t.service.get).not.toHaveBeenCalled();
  });
  it.each(["input_images", "jobId", "creditsCost", "confirmed", "placement"])("rejects forbidden field %s", async field => {
    const t = await setup(); const response = await t.app.inject({ method: "POST", url: "/api/jobs/node-image-generation", payload: { ...request, [field]: "untrusted" } });
    expect(response.statusCode).toBe(400); expect(t.service.submit).not.toHaveBeenCalled();
  });
  it("keeps known conflict readable but hides raw infrastructure errors", async () => {
    const t = await setup(); t.service.submit.mockRejectedValue(new NodeImageSubmissionError("node_submission_conflict", "请求已改变。", 409));
    expect((await t.app.inject({ method: "POST", url: "/api/jobs/node-image-generation", payload: request })).statusCode).toBe(409);
    t.service.submit.mockRejectedValue(new Error("secret database credentials"));
    const response = await t.app.inject({ method: "POST", url: "/api/jobs/node-image-generation", payload: request });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("secret");
  });
});
