import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPaymentStatusRoute } from "./payments-status.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "user@example.com", accessToken: "token", userMetadata: {} };

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(provider: string | null, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerPaymentStatusRoute(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    provider,
  });
  return app;
}

describe("payment status route", () => {
  it("requires authentication", async () => {
    const response = await (await makeApp(null, false)).inject({
      method: "GET",
      url: "/api/payments/status",
    });
    expect(response.statusCode).toBe(401);
  });

  it("reports that this installation takes no payments", async () => {
    // This route is registered even without a provider, which is exactly what lets the
    // billing page say "switched off" instead of showing a 404 as a failure.
    const response = await (await makeApp(null)).inject({ method: "GET", url: "/api/payments/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false, provider: null });
  });

  it("names the configured provider", async () => {
    const response = await (await makeApp("lemon_squeezy")).inject({
      method: "GET",
      url: "/api/payments/status",
    });
    expect(response.json()).toEqual({ enabled: true, provider: "lemon_squeezy" });
  });
});
