import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerViewerRoutes } from "./viewer.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "user@example.com", accessToken: "token", userMetadata: {} };

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

/** Captures what the PATCH actually wrote, and returns the row the route reads back. */
function makeApp(authenticated = true) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from: () => {
      const builder: any = {
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          return builder;
        },
        eq: () => builder,
        select: () => builder,
        single: async () => ({
          data: {
            id: user.id,
            email: user.email,
            display_name: "新名字",
            avatar_url: updates.at(-1)?.avatar_url ?? null,
          },
          error: null,
        }),
        maybeSingle: async () => ({
          data: {
            id: user.id,
            email: user.email,
            display_name: "保存的名字",
            avatar_url: "https://cdn.example/avatar.png",
          },
          error: null,
        }),
      };
      return builder;
    },
  };
  const app = Fastify();
  apps.push(app);
  return registerViewerRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    createUserClient: () => client as never,
    viewerService: {} as never,
  }).then(() => ({ app, updates }));
}

describe("viewer profile read", () => {
  it("returns just the profile, without bootstrapping or claiming credits", async () => {
    const viewerService = { ensureViewer: vi.fn() };
    const app = Fastify();
    apps.push(app);
    await registerViewerRoutes(app, {
      auth: { authenticate: vi.fn().mockResolvedValue(user) } as never,
      createUserClient: () => ({
        from: () => {
          const builder: any = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: async () => ({
              data: { id: user.id, email: user.email, display_name: "保存的名字",
                avatar_url: "https://cdn.example/avatar.png" },
              error: null,
            }),
          };
          return builder;
        },
      }) as never,
      viewerService: viewerService as never,
    });

    const response = await app.inject({ method: "GET", url: "/api/viewer/profile" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      profile: {
        id: user.id,
        email: user.email,
        displayName: "保存的名字",
        avatarUrl: "https://cdn.example/avatar.png",
      },
    });
    // The whole point of this route: the header must not trigger the heavy path.
    expect(viewerService.ensureViewer).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const { app } = await makeApp(false);
    expect((await app.inject({ method: "GET", url: "/api/viewer/profile" })).statusCode).toBe(401);
  });
});

describe("viewer profile update", () => {
  it("updates the display name and the avatar together", async () => {
    const { app, updates } = await makeApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/viewer/profile",
      payload: { displayName: "新名字", avatarUrl: "https://cdn.example/avatar.png" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(updates[0]).toEqual({
      display_name: "新名字",
      avatar_url: "https://cdn.example/avatar.png",
    });
    expect(response.json()).toMatchObject({
      profile: { displayName: "新名字", avatarUrl: "https://cdn.example/avatar.png" },
    });
  });

  it("leaves the avatar alone when the request does not mention it", async () => {
    const { app, updates } = await makeApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/viewer/profile",
      payload: { displayName: "只改名字" },
    });
    expect(response.statusCode).toBe(200);
    expect(updates[0]).toEqual({ display_name: "只改名字" });
    expect(Object.keys(updates[0]!)).not.toContain("avatar_url");
  });

  it("clears the avatar when the request sends null", async () => {
    const { app, updates } = await makeApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/viewer/profile",
      payload: { displayName: "去掉头像", avatarUrl: null },
    });
    expect(response.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({ avatar_url: null });
  });

  it("refuses an avatar that is not a usable link", async () => {
    const { app, updates } = await makeApp();
    for (const avatarUrl of ["not-a-url", "/relative/path.png", ""]) {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/viewer/profile",
        payload: { displayName: "名字", avatarUrl },
      });
      expect(response.statusCode, avatarUrl).toBe(400);
    }
    expect(updates).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const { app } = await makeApp(false);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/viewer/profile",
      payload: { displayName: "名字" },
    });
    expect(response.statusCode).toBe(401);
  });
});
