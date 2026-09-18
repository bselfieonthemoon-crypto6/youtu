import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerJobRoutes } from "./jobs.js";

describe("job route input validation", () => {
  it.each([
    ["GET", "/api/jobs?status=invalid"],
    ["GET", "/api/jobs?job_type=invalid"],
    ["GET", "/api/jobs?status=queued&status=running"],
    ["GET", "/api/jobs/not-a-uuid"],
    ["POST", "/api/jobs/not-a-uuid/cancel"],
    ["POST", "/api/jobs/not-a-uuid/restore-to-canvas"],
  ] as const)("rejects %s %s without querying storage", async (method, url) => {
    const app = Fastify();
    const jobService = { listJobs: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn() };
    try {
      await registerJobRoutes(app, {
        auth: { authenticate: async () => ({ id: "test", accessToken: "test" }) } as never,
        viewerService: {} as never,
        jobService: jobService as never,
      });
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(400);
      for (const method of Object.values(jobService)) expect(method).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
