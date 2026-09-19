import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../supabase/user.js";
import { registerJobRoutes, resolveBackgroundRemovalModel } from "./jobs.js";

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
      "local repaint",
      "local_repaint" as const,
      { mask_image: "data:image/png;base64,bWFzaw==" },
    ],
    [
      "outpaint",
      "outpaint" as const,
      { outpaint_margins: { top: 20, right: 40, bottom: 0, left: 0 } },
    ],
  ])("uses canvas placeholder replay for paid %s submissions", async (
    _label,
    operation,
    operationFields,
  ) => {
    const createJobWithReplay = vi.fn(async () => ({
      job: job("image_generation"),
      replayed: false,
      billingCommitted: false,
    }));
    const jobService = {
      createJob: vi.fn(),
      createJobWithReplay,
      setCreditsInfo: vi.fn(),
      enqueueJob: vi.fn(),
    };
    const app = Fastify();
    apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user },
      viewerService: {
        ensureViewer: async () => ({ workspace: { id: ids.workspace } }),
      } as never,
      jobService: jobService as never,
      creditService: {
        getSubscription: async () => ({ plan: "pro" }),
        deductCredits: async () => "tx",
      } as never,
      tierGuard: {
        checkModelAccess: vi.fn(),
        checkResolution: vi.fn(),
        checkConcurrency: vi.fn(),
        calculateCreditCost: vi.fn(() => 7),
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      payload: {
        canvas_id: "00000000-0000-4000-8000-000000000005",
        placeholder_element_id: "repaint-placeholder-1",
        placement_x: 100,
        placement_y: 50,
        prompt: "Replace the selected flower",
        operation,
        model: "gpt-image-2",
        input_images: ["data:image/png;base64,aWFnZQ=="],
        ...operationFields,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(jobService.createJob).not.toHaveBeenCalled();
    expect(createJobWithReplay).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "canvas",
          element_id: "repaint-placeholder-1",
        }),
        payload: expect.objectContaining({ operation, ...operationFields }),
      }),
    );
  });

  it.each([["2k", "hd"], ["4k", "ultra"]])("bills %s pixels independently from low quality", async (resolution, billingQuality) => {
    const jobService = { createJob: vi.fn(async () => job("image_generation")), setCreditsInfo: vi.fn(), enqueueJob: vi.fn() };
    const tierGuard = { checkModelAccess: vi.fn(), checkResolution: vi.fn(), checkConcurrency: vi.fn(), calculateCreditCost: vi.fn(() => 7) };
    const app = Fastify(); apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user }, viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never,
      jobService: jobService as never,
      creditService: { getSubscription: async () => ({ plan: "pro" }), deductCredits: async () => "tx" } as never,
      tierGuard: tierGuard as never,
    });
    const response = await app.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { model: "gpt-image-2", prompt: "native resolution", quality: "standard", resolution, aspect_ratio: "16:9" } });
    expect(response.statusCode).toBe(201);
    expect(tierGuard.checkResolution).toHaveBeenCalledWith("pro", billingQuality);
    expect(tierGuard.calculateCreditCost).toHaveBeenCalledWith("gpt-image-2", "image_generation", { quality: billingQuality, imageResolution: resolution });
    expect(jobService.createJob).toHaveBeenCalledWith(user, expect.objectContaining({ payload: expect.objectContaining({ quality: "standard", resolution }) }));
  });

  it("does not enqueue or deduct when the selected pixel tier is forbidden", async () => {
    const createJob = vi.fn(), deductCredits = vi.fn();
    const app = Fastify(); apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user }, viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never,
      jobService: { createJob } as never,
      creditService: { getSubscription: async () => ({ plan: "free" }), deductCredits } as never,
      tierGuard: { checkModelAccess: vi.fn(), checkResolution: () => { throw new Error("resolution_not_allowed"); }, checkConcurrency: vi.fn(), calculateCreditCost: vi.fn() } as never,
    });
    const response = await app.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { model: "gpt-image-2", prompt: "native resolution", quality: "standard", resolution: "4k" } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(createJob).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("binds background removal to the exact native workspace model and bills before publishing", async () => {
    const nativeId = "workspace:00000000-0000-4000-8000-000000000099";
    const order: string[] = [];
    const entries = ["gpt-image-2-all", "gpt-image-2-vip", "gpt-image-2", "gpt-image-2.5-flare"].map(upstreamModelId => ({ upstreamModelId, model: { id: upstreamModelId === "gpt-image-2.5-flare" ? nativeId : upstreamModelId, modality: "image", capabilities: ["image_generation"] } }));
    const catalog = { listPublished: vi.fn(async () => entries), resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2.5-flare" })) };
    const jobService = { createJob: vi.fn(async () => { order.push("create"); return job("image_generation"); }), setCreditsInfo: vi.fn(async () => { order.push("billing"); }), enqueueJob: vi.fn(async () => { order.push("enqueue"); }) };
    const creditService = { getSubscription: vi.fn(async () => ({ plan: "pro" })), deductCredits: vi.fn(async () => { order.push("deduct"); return "tx"; }) };
    const app = Fastify(); apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user }, viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never,
      workspaceModelCatalogService: catalog as never, jobService: jobService as never, creditService: creditService as never,
      tierGuard: { checkModelAccess: vi.fn(), checkResolution: vi.fn(), checkConcurrency: vi.fn(), calculateCreditCost: vi.fn(() => 7) } as never,
    });
    const response = await app.inject({ method: "POST", url: "/api/jobs/image-generation", payload: { prompt: "Remove background", operation: "remove_background", model: "gpt-image-2-all", input_images: ["data:image/png;base64,aGVsbG8="] } });
    expect(response.statusCode).toBe(201);
    expect(jobService.createJob).toHaveBeenCalledWith(user, expect.objectContaining({ payload: expect.objectContaining({ operation: "remove_background", model: nativeId }) }));
    expect(order).toEqual(["create", "deduct", "billing", "enqueue"]);
    expect(catalog.listPublished).toHaveBeenCalledWith(user, ids.workspace);
  });

  it("fails closed when only all/vip are enabled", async () => {
    const catalog = { listPublished: async () => ["gpt-image-2-all", "gpt-image-2-vip"].map(upstreamModelId => ({ upstreamModelId, model: { modality: "image", capabilities: ["image_generation"] } })) };
    await expect(resolveBackgroundRemovalModel(catalog as never, user, ids.workspace)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a 17th exact GPT Image 2 reference before creating or billing a job", async () => {
    const jobService = { createJob: vi.fn(), enqueueJob: vi.fn() };
    const creditService = { getSubscription: vi.fn(), deductCredits: vi.fn() };
    const app = Fastify(); apps.push(app);
    await registerJobRoutes(app, {
      auth: { authenticate: async () => user },
      viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never,
      jobService: jobService as never,
      creditService: creditService as never,
      tierGuard: { checkModelAccess: vi.fn(), checkConcurrency: vi.fn(), calculateCreditCost: vi.fn() } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      payload: {
        prompt: "Combine the supplied references",
        model: "gpt-image-2",
        input_images: Array.from({ length: 17 }, (_, index) => `data:image/png;base64,aW1hZ2U${index}`),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "image_reference_limit_exceeded" } });
    expect(jobService.createJob).not.toHaveBeenCalled();
    expect(creditService.getSubscription).not.toHaveBeenCalled();
    expect(creditService.deductCredits).not.toHaveBeenCalled();
  });

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
          checkResolution: vi.fn(),
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
        prompt: "cut out the framed subject",
        operation: "region_matting",
        selection_region: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
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
        prompt: "cut out the framed subject",
        operation: "region_matting",
        selection_region: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
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
        checkResolution: vi.fn(),
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
    ["region_matting", undefined],
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
        checkResolution: vi.fn(),
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
