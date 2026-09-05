import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  designErrorResponseSchema,
  queueDesignPreviewResponseSchema,
} from "@loomic/shared";

import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerDesignAsyncRoutes } from "./design-async.js";

const designId = "10000000-0000-4000-8000-000000000001";
const otherDesignId = "10000000-0000-4000-8000-000000000002";
const requestId = "20000000-0000-4000-8000-000000000001";
const jobId = "30000000-0000-4000-8000-000000000001";
const assetId = "40000000-0000-4000-8000-000000000001";

const user: AuthenticatedUser = {
  id: "50000000-0000-4000-8000-000000000001",
  email: "member@local.test",
  accessToken: "token",
  userMetadata: {},
};

async function createApp(input?: {
  authenticatedUser?: AuthenticatedUser | null;
  enqueuePreview?: ReturnType<typeof vi.fn>;
  enqueueExport?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify({ logger: false });
  const auth: RequestAuthenticator = {
    authenticate: vi
      .fn()
      .mockResolvedValue(
        input?.authenticatedUser === undefined ? user : input.authenticatedUser,
      ),
  };
  const enqueuePreview =
    input?.enqueuePreview ??
    vi.fn().mockResolvedValue({
      design_id: designId,
      revision: 3,
      status: "queued",
      job_id: jobId,
      replayed: false,
    });
  const enqueueExport = input?.enqueueExport ?? vi.fn();
  await registerDesignAsyncRoutes(app, {
    auth,
    previewService: { enqueue: enqueuePreview },
    exportService: { enqueue: enqueueExport },
  });
  await app.ready();
  return { app, enqueueExport, enqueuePreview };
}

describe("design async HTTP routes", () => {
  it("queues a member preview while freezing the requested revision", async () => {
    const { app, enqueuePreview } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/preview`,
      payload: {
        design_id: designId,
        expected_revision: 3,
        idempotency_key: requestId,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(queueDesignPreviewResponseSchema.parse(response.json()).job_id).toBe(
      jobId,
    );
    expect(enqueuePreview).toHaveBeenCalledWith({
      designId,
      expectedRevision: 3,
      idempotencyKey: requestId,
      actorUserId: user.id,
    });
    await app.close();
  });

  it("never exposes preview asset commit through the browser route", async () => {
    const { app, enqueuePreview } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/preview`,
      payload: {
        design_id: designId,
        expected_revision: 3,
        idempotency_key: requestId,
        preview_asset_object_id: assetId,
        preview_revision: 3,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(designErrorResponseSchema.parse(response.json()).error.code).toBe(
      "design_invalid",
    );
    expect(enqueuePreview).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects URL/body design ID mismatches before enqueue", async () => {
    const { app, enqueuePreview } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/preview`,
      payload: {
        design_id: otherDesignId,
        expected_revision: 3,
        idempotency_key: requestId,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(designErrorResponseSchema.parse(response.json()).error.code).toBe(
      "design_invalid",
    );
    expect(enqueuePreview).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unauthenticated preview requests before enqueue", async () => {
    const { app, enqueuePreview } = await createApp({
      authenticatedUser: null,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/preview`,
      payload: {
        design_id: designId,
        expected_revision: 3,
        idempotency_key: requestId,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(enqueuePreview).not.toHaveBeenCalled();
    await app.close();
  });
});
