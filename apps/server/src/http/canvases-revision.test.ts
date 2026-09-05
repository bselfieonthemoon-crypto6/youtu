import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { registerCanvasRoutes } from "./canvases.js";

describe("Canvas revision HTTP contract", () => {
  it("returns the authoritative revision produced by PUT", async () => {
    const canvasService = {
      getCanvas: vi.fn(),
      saveCanvasContent: vi.fn(async () => 18),
    } satisfies CanvasService;
    const auth = {
      authenticate: vi.fn(async () => ({
        id: "10000000-0000-4000-8000-000000000001",
        email: "owner@local.test",
        accessToken: "token",
        userMetadata: {},
      })),
    } satisfies RequestAuthenticator;
    const app = Fastify({ logger: false });
    await registerCanvasRoutes(app, { auth, canvasService });
    await app.ready();

    const response = await app.inject({
      method: "PUT",
      url: "/api/canvases/20000000-0000-4000-8000-000000000001",
      payload: { content: { elements: [], appState: {}, files: {} } },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true, revision: 18 });
    await app.close();
  });
});
