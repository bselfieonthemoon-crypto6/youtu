import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerCreditRoutes } from "./credits.js";

describe("credit route isolation", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("does not expose the old authenticated plan override", async () => {
    const app = Fastify();
    apps.push(app);
    await registerCreditRoutes(app, {
      auth: { authenticate: async () => null },
      creditService: {} as never,
      viewerService: {} as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/credits/admin/set-plan",
      payload: { plan: "business" },
    });

    expect(response.statusCode).toBe(404);
  });
});
