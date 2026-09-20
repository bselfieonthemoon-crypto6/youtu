import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDesignCatalogAdminRoutes } from "./design-catalog-admin.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
const payload = {
  request_id: "11111111-1111-4111-8111-111111111111",
  entity_kind: "template",
  entity_id: "22222222-2222-4222-8222-222222222222",
  expected_revision: 0,
};
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("design catalog admin routes", () => {
  it("validates font magic before storing an authorized private font asset", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(multipart);
    const uploadService = {
      uploadFile: vi.fn(async () => ({
        asset: { id: "44444444-4444-4444-8444-444444444444" },
        url: "signed",
      })),
    };
    await registerDesignCatalogAdminRoutes(app, {
      auth: {
        authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
      } as never,
      service: {} as never,
      uploadService: uploadService as never,
    });
    const body = multipartBody(makeMinimalTtf("Loomic Sans"));
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/font-files",
      headers: {
        "content-type": `multipart/form-data; boundary=${body.boundary}`,
      },
      payload: body.buffer,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      asset_object_id: "44444444-4444-4444-8444-444444444444",
      family_name: "Loomic Sans",
      format: "ttf",
    });
    const spoofed = multipartBody(Buffer.from("not a font"));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/design-catalog/font-files",
          headers: {
            "content-type": `multipart/form-data; boundary=${spoofed.boundary}`,
          },
          payload: spoofed.buffer,
        })
      ).statusCode,
    ).toBe(400);
    expect(uploadService.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("requires auth before mutations and binds delete/restore semantics", async () => {
    const app = Fastify();
    apps.push(app);
    const auth = { authenticate: vi.fn(async () => null) };
    const service = {
      create: vi.fn(),
      update: vi.fn(),
      references: vi.fn(),
      setStatus: vi.fn(),
      setDeleted: vi.fn(),
    };
    await registerDesignCatalogAdminRoutes(app, {
      auth: auth as never,
      service: service as never,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/design-catalog/delete",
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(service.setDeleted).not.toHaveBeenCalled();
  });

  it("uses false for restore and rejects incomplete CAS bodies", async () => {
    const app = Fastify();
    apps.push(app);
    const auth = {
      authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
    };
    const result = {
      ...payload,
      revision: 1,
      status: "draft",
      replayed: false,
    };
    const service = {
      create: vi.fn(),
      update: vi.fn(),
      references: vi.fn(),
      setStatus: vi.fn(),
      setDeleted: vi.fn(async () => result),
    };
    await registerDesignCatalogAdminRoutes(app, {
      auth: auth as never,
      service: service as never,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/design-catalog/restore",
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.setDeleted).toHaveBeenCalledWith(
      expect.anything(),
      payload,
      false,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/design-catalog/delete",
          payload: { entity_id: payload.entity_id },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("routes typed create, update, and reference requests", async () => {
    const app = Fastify();
    apps.push(app);
    const auth = {
      authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
    };
    const service = {
      create: vi.fn(async () => ({
        entity_kind: "tag",
        entity_id: payload.entity_id,
        revision: 0,
        status: "draft",
        replayed: false,
      })),
      update: vi.fn(async () => ({
        entity_kind: "tag",
        entity_id: payload.entity_id,
        revision: 1,
        status: "draft",
        replayed: false,
      })),
      references: vi.fn(async () => ({
        entity_kind: "tag",
        entity_id: payload.entity_id,
        references: [],
      })),
      setStatus: vi.fn(),
      setDeleted: vi.fn(),
    };
    await registerDesignCatalogAdminRoutes(app, {
      auth: auth as never,
      service: service as never,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/tags",
      payload: {
        request_id: payload.request_id,
        scope: "workspace",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        name: "Hero",
        slug: "hero",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity_kind: "tag",
        payload: { name: "Hero", slug: "hero" },
      }),
    );
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/design-catalog/tags/${payload.entity_id}`,
      payload: {
        request_id: payload.request_id,
        expected_revision: 0,
        name: "Hero 2",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity_kind: "tag",
        entity_id: payload.entity_id,
        patch: { name: "Hero 2" },
      }),
    );
    const resourceId = "44444444-4444-4444-8444-444444444444";
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/admin/design-catalog/resources/${resourceId}`,
          payload: {
            request_id: payload.request_id,
            expected_revision: 0,
            name: "Updated resource",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.update).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity_kind: "resource",
        entity_id: resourceId,
        patch: { name: "Updated resource" },
      }),
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/design-catalog/tags/${payload.entity_id}/references`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("serves a signed thumbnail url per collection and keeps its refusals", async () => {
    const app = Fastify();
    apps.push(app);
    const auth = {
      authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
    };
    const resourceId = "44444444-4444-4444-8444-444444444444";
    const service = {
      previewUrl: vi.fn(async (_user: unknown, kind: string, id: string) => ({
        entity_kind: kind,
        entity_id: id,
        uses_preview: true,
        asset_object_id: "55555555-5555-4555-8555-555555555555",
        mime_type: "image/png",
        url: "https://signed.example/thumb",
      })),
    };
    await registerDesignCatalogAdminRoutes(app, {
      auth: auth as never,
      service: service as never,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/admin/design-catalog/resources/${resourceId}/preview-url`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      entity_kind: "resource",
      uses_preview: true,
      url: "https://signed.example/thumb",
    });
    expect(service.previewUrl).toHaveBeenCalledWith(
      expect.anything(),
      "resource",
      resourceId,
    );

    // Templates map to their own entity kind, so the collection segment is not
    // decoration: it decides which table is read.
    await app.inject({
      method: "GET",
      url: `/api/admin/design-catalog/templates/${resourceId}/preview-url`,
    });
    expect(service.previewUrl).toHaveBeenLastCalledWith(
      expect.anything(),
      "template",
      resourceId,
    );

    // An unknown collection never reaches the service (the collection map answers
    // 400, the same as it does for every other catalog route).
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/design-catalog/nonsense/${resourceId}/preview-url`,
        })
      ).statusCode,
    ).toBe(400);
    expect(service.previewUrl).toHaveBeenCalledTimes(2);
  });
});

function multipartBody(file: Buffer) {
  const boundary = "----loomic-font-test";
  const workspace = "33333333-3333-4333-8333-333333333333";
  return {
    boundary,
    buffer: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="workspace_id"\r\n\r\n${workspace}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="font.ttf"\r\nContent-Type: font/ttf\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function makeMinimalTtf(familyName: string): Buffer {
  const encoded = Buffer.alloc(familyName.length * 2);
  for (let index = 0; index < familyName.length; index += 1)
    encoded.writeUInt16BE(familyName.charCodeAt(index), index * 2);
  const name = Buffer.alloc(18 + encoded.length);
  name.writeUInt16BE(1, 2);
  name.writeUInt16BE(18, 4);
  name.writeUInt16BE(3, 6);
  name.writeUInt16BE(1, 8);
  name.writeUInt16BE(0x0409, 10);
  name.writeUInt16BE(1, 12);
  name.writeUInt16BE(encoded.length, 14);
  encoded.copy(name, 18);
  const os2 = Buffer.alloc(64);
  os2.writeUInt16BE(4, 0);
  os2.writeUInt16BE(400, 4);
  os2.writeUInt16BE(5, 6);
  const offset = 44;
  const font = Buffer.alloc(offset + name.length + os2.length);
  font.writeUInt32BE(0x0001_0000, 0);
  font.writeUInt16BE(2, 4);
  font.write("name", 12, "ascii");
  font.writeUInt32BE(offset, 20);
  font.writeUInt32BE(name.length, 24);
  font.write("OS/2", 28, "ascii");
  font.writeUInt32BE(offset + name.length, 36);
  font.writeUInt32BE(os2.length, 40);
  name.copy(font, offset);
  os2.copy(font, offset + name.length);
  return font;
}
