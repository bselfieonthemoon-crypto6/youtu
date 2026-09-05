import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  job: "00000000-0000-4000-8000-000000000003",
  project: "00000000-0000-4000-8000-000000000004",
};

const user: AuthenticatedUser = {
  id: ids.user,
  accessToken: "token",
  email: "user@example.test",
  userMetadata: {},
};

function job(jobType: "image_generation" | "video_generation") {
  return {
    id: ids.job,
    workspace_id: ids.workspace,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: `${jobType}_jobs`,
    job_type: jobType,
    status: "queued",
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: ids.user,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  } as const;
}

describe("job route payment gate", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it.each([
    [
      "image",
      "/api/jobs/image-generation",
      {
        prompt: "image",
        model: "model",
        output_width: 2048,
        output_height: 1168,
      },
    ],
    [
      "video",
      "/api/jobs/video-generation",
      { prompt: "video", model: "model", duration: 5 },
    ],
  ] as const)(
    "defers %s publication until the ledger deduction commits",
    async (kind, url, payload) => {
      const order: string[] = [];
      const createdJob = job(
        kind === "image" ? "image_generation" : "video_generation",
      );
      const jobService = {
        createJob: vi.fn(async () => {
          order.push("create");
          return createdJob;
        }),
        setCreditsInfo: vi.fn(async () => {
          order.push("billing");
        }),
        enqueueJob: vi.fn(async () => {
          order.push("enqueue");
        }),
        cancelJob: vi.fn(),
      };
      const creditService = {
        getSubscription: vi.fn(async () => ({ plan: "pro" })),
        deductCredits: vi.fn(async () => {
          order.push("deduct");
          return "tx-1";
        }),
        refundCredits: vi.fn(),
      };
      const app = Fastify();
      apps.push(app);
      await registerJobRoutes(app, {
        auth: { authenticate: async () => user },
        viewerService: {
          ensureViewer: async () => ({ workspace: { id: ids.workspace } }),
        } as never,
        creditService: creditService as never,
        tierGuard: {
          checkModelAccess: vi.fn(),
          checkConcurrency: vi.fn(),
          calculateCreditCost: vi.fn(() => 7),
        } as never,
        jobService: jobService as never,
      });

      const response = await app.inject({ method: "POST", url, payload });

      expect(response.statusCode).toBe(201);
      expect(order).toEqual(["create", "deduct", "billing", "enqueue"]);
      expect(jobService.createJob).toHaveBeenCalledWith(
        user,
        expect.objectContaining({ deferEnqueue: true }),
      );
      if (kind === "image") {
        expect(jobService.createJob).toHaveBeenCalledWith(
          user,
          expect.objectContaining({
            payload: expect.objectContaining({
              output_width: 2048,
              output_height: 1168,
            }),
          }),
        );
      }
    },
  );

  it("uses the authorized team design workspace for a local image operation", async () => {
    const teamWorkspace = "00000000-0000-4000-8000-000000000010";
    const projectId = "00000000-0000-4000-8000-000000000011";
    const designId = "00000000-0000-4000-8000-000000000012";
    const objectId = "00000000-0000-4000-8000-000000000013";
    const sourceAssetId = "00000000-0000-4000-8000-000000000014";
    const resolvedTarget = {
      kind: "design" as const,
      design_id: designId,
      expected_revision: 2,
      idempotency_key: "00000000-0000-4000-8000-000000000015",
      source_object_id: objectId,
      expected_object_version: 3,
      source_asset_object_id: sourceAssetId,
      placement: { x: 0, y: 0, replace_object_id: objectId },
    };
    const createdJob = {
      ...job("image_generation"),
      workspace_id: teamWorkspace,
      project_id: projectId,
      target_kind: "design",
      design_id: designId,
    };
    const jobService = {
      resolveDesignOperationTarget: vi.fn(async () => ({
        workspaceId: teamWorkspace,
        projectId,
        target: resolvedTarget,
      })),
      createJobWithReplay: vi.fn(async () => ({
        job: createdJob,
        replayed: false,
        billingCommitted: false,
      })),
      setCreditsInfo: vi.fn(),
      enqueueJob: vi.fn(async () => undefined),
      cancelJob: vi.fn(),
    };
    const app = Fastify();
    apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user },
      viewerService: {
        ensureViewer: async () => ({ workspace: { id: ids.workspace } }),
      } as never,
      jobService: jobService as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      payload: {
        prompt: "remove background",
        operation: "remove_background",
        target: {
          kind: "design",
          design_id: designId,
          expected_revision: 2,
          idempotency_key: resolvedTarget.idempotency_key,
          placement: { x: 0, y: 0, replace_object_id: objectId },
        },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(jobService.createJobWithReplay).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        workspaceId: teamWorkspace,
        projectId,
        target: resolvedTarget,
        payload: expect.not.objectContaining({ target: expect.anything() }),
      }),
    );
  });

  it("does not cancel a replayed design job when republishing fails", async () => {
    const designId = "00000000-0000-4000-8000-000000000012";
    const objectId = "00000000-0000-4000-8000-000000000013";
    const target = {
      kind: "design" as const,
      design_id: designId,
      expected_revision: 2,
      idempotency_key: "00000000-0000-4000-8000-000000000015",
      source_object_id: objectId,
      expected_object_version: 3,
      source_asset_object_id: "00000000-0000-4000-8000-000000000014",
      placement: { x: 0, y: 0, replace_object_id: objectId },
    };
    const replayedJob = {
      ...job("image_generation"),
      workspace_id: ids.workspace,
      project_id: ids.project,
      target_kind: "design",
      design_id: designId,
    };
    const jobService = {
      resolveDesignOperationTarget: vi.fn(async () => ({
        workspaceId: ids.workspace,
        projectId: ids.project,
        target,
      })),
      createJobWithReplay: vi.fn(async () => ({
        job: replayedJob,
        replayed: true,
        billingCommitted: true,
      })),
      setCreditsInfo: vi.fn(),
      enqueueJob: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      cancelJob: vi.fn(),
    };
    const app = Fastify();
    apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user },
      viewerService: {
        ensureViewer: async () => ({ workspace: { id: ids.workspace } }),
      } as never,
      jobService: jobService as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      payload: {
        prompt: "remove background",
        operation: "remove_background",
        target: {
          kind: "design",
          design_id: designId,
          expected_revision: 2,
          idempotency_key: target.idempotency_key,
          placement: { x: 0, y: 0, replace_object_id: objectId },
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(jobService.cancelJob).not.toHaveBeenCalled();
  });

  it("cancels and refunds a charged job when deferred enqueue fails", async () => {
    const createdJob = job("image_generation");
    const jobService = {
      createJob: vi.fn(async () => createdJob),
      setCreditsInfo: vi.fn(async () => undefined),
      enqueueJob: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      cancelJob: vi.fn(async () => ({ ...createdJob, status: "canceled" })),
    };
    const creditService = {
      getSubscription: vi.fn(async () => ({ plan: "pro" })),
      deductCredits: vi.fn(async () => "tx-1"),
      refundCredits: vi.fn(async () => "refund-1"),
    };
    const app = Fastify();
    apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user },
      viewerService: {
        ensureViewer: async () => ({ workspace: { id: ids.workspace } }),
      } as never,
      creditService: creditService as never,
      tierGuard: {
        checkModelAccess: vi.fn(),
        checkConcurrency: vi.fn(),
        calculateCreditCost: vi.fn(() => 7),
      } as never,
      jobService: jobService as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      payload: { prompt: "image", model: "model" },
    });

    expect(response.statusCode).toBe(500);
    expect(jobService.cancelJob).toHaveBeenCalledWith(user, ids.job);
    expect(creditService.refundCredits).toHaveBeenCalledWith(
      ids.workspace,
      ids.user,
      7,
      ids.job,
      "Auto-refund: job was not enqueued",
    );
  });

  it.each([
    ["remove_background", undefined],
    ["smart_erase", "data:image/png;base64,bWFzaw=="],
  ] as const)(
    "queues self-hosted %s without charging generation credits",
    async (operation, maskImage) => {
      const createdJob = job("image_generation");
      const jobService = {
        createJob: vi.fn(async () => createdJob),
        setCreditsInfo: vi.fn(),
        enqueueJob: vi.fn(async () => undefined),
        cancelJob: vi.fn(),
      };
      const creditService = {
        getSubscription: vi.fn(),
        deductCredits: vi.fn(),
        refundCredits: vi.fn(),
      };
      const tierGuard = {
        checkModelAccess: vi.fn(),
        checkConcurrency: vi.fn(),
        calculateCreditCost: vi.fn(),
      };
      const app = Fastify();
      apps.push(app);
      await registerJobRoutes(app, {
        auth: { authenticate: async () => user },
        viewerService: {
          ensureViewer: async () => ({ workspace: { id: ids.workspace } }),
        } as never,
        creditService: creditService as never,
        tierGuard: tierGuard as never,
        jobService: jobService as never,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/jobs/image-generation",
        payload: {
          prompt: "local image operation",
          operation,
          model: "some-client-supplied-model",
          input_images: ["data:image/png;base64,AA=="],
          ...(maskImage ? { mask_image: maskImage } : {}),
        },
      });

      expect(response.statusCode).toBe(201);
      expect(creditService.getSubscription).not.toHaveBeenCalled();
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      expect(jobService.createJob).toHaveBeenCalledWith(
        user,
        expect.objectContaining({
          payload: expect.objectContaining({
            operation,
            model: "local:feynobg",
            ...(maskImage ? { mask_image: maskImage } : {}),
          }),
          providerBilling: expect.objectContaining({ creditsCost: 0 }),
        }),
      );
      expect(jobService.enqueueJob).toHaveBeenCalledWith(user, ids.job);
    },
  );
});
