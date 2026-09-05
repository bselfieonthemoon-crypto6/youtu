import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";

import { registerDesignImportRoutes } from "./design-imports.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("design import routes", () => {
  it("authenticates and accepts a multi-item JSON import", async () => {
    const app = Fastify();
    apps.push(app);
    const service = {
      create: vi.fn(async () => ({
        import_job_id: "11111111-1111-4111-8111-111111111111",
        status: "queued",
        replayed: false,
      })),
      list: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      attachItemMetadata: vi.fn(),
      enqueueManifest: vi.fn(),
    };
    await registerDesignImportRoutes(app, {
      auth: {
        authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
      } as never,
      service: service as never,
      uploadService: {} as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/imports",
      payload: {
        request_id: "22222222-2222-4222-8222-222222222222",
        scope: "workspace",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        source_kind: "url",
        source_urls: [
          "https://example.test/a.png",
          "https://example.test/b.png",
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(service.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source_urls: [
          "https://example.test/a.png",
          "https://example.test/b.png",
        ],
      }),
    );
  });

  it("accepts a strict inline metadata-only manifest", async () => {
    const app = Fastify();
    apps.push(app);
    const service = {
      enqueueManifest: vi.fn(async () => ({
        import_job_id: "11111111-1111-4111-8111-111111111111",
        status: "queued",
        replayed: false,
      })),
    };
    await registerDesignImportRoutes(app, {
      auth: {
        authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
      } as never,
      service: service as never,
      uploadService: {} as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/imports",
      payload: {
        request_id: "22222222-2222-4222-8222-222222222222",
        scope: "workspace",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        source_kind: "manifest_inline",
        manifest: {
          version: 1,
          items: [
            {
              source_key: "category/hero",
              entity_kind: "category",
              payload: { name: "Hero" },
            },
            {
              source_key: "tag/featured",
              entity_kind: "tag",
              payload: { name: "Featured" },
            },
            {
              source_key: "font/family",
              entity_kind: "font_family",
              payload: { name: "Loomic Sans" },
            },
          ],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(service.enqueueManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ entity_kind: "category" }),
        ]),
      }),
    );
  });

  it("accepts an arbitrarily named JSON manifest and a ZIP manifest", async () => {
    const manifest = JSON.stringify({
      version: 1,
      items: [
        {
          source_key: "category/hero",
          entity_kind: "category",
          payload: { name: "Hero" },
        },
      ],
    });
    for (const fixture of [
      {
        name: "catalog-export.json",
        mime: "application/json",
        data: Buffer.from(manifest),
      },
      {
        name: "catalog.zip",
        mime: "application/zip",
        data: await zipManifest(manifest),
      },
    ]) {
      const app = Fastify();
      apps.push(app);
      await app.register(multipart);
      const service = {
        enqueueManifest: vi.fn(async () => ({
          import_job_id: "11111111-1111-4111-8111-111111111111",
          status: "queued",
          replayed: false,
        })),
      };
      await registerDesignImportRoutes(app, {
        auth: {
          authenticate: vi.fn(async () => ({
            id: "user",
            accessToken: "token",
          })),
        } as never,
        service: service as never,
        uploadService: { deleteAsset: vi.fn() } as never,
      });
      const body = multipartImportBody(fixture);
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/design-catalog/imports",
        headers: {
          "content-type": `multipart/form-data; boundary=${body.boundary}`,
        },
        payload: body.buffer,
      });
      expect(response.statusCode, `${fixture.name}: ${response.body}`).toBe(
        202,
      );
      expect(service.enqueueManifest).toHaveBeenCalledOnce();
    }
  });

  it("rejects invalid list limits before service access", async () => {
    const app = Fastify();
    apps.push(app);
    const service = { list: vi.fn() };
    await registerDesignImportRoutes(app, {
      auth: {
        authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
      } as never,
      service: service as never,
      uploadService: {} as never,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/design-catalog/imports?limit=101",
        })
      ).statusCode,
    ).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("imports a manifest directory only beneath the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomic-route-import-"));
    const folder = join(root, "batch");
    await mkdir(folder);
    await writeFile(join(folder, "asset.png"), "image");
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        version: 1,
        items: [
          {
            source_key: "legacy/asset.png",
            entity_kind: "resource",
            path: "asset.png",
          },
        ],
      }),
    );
    const app = Fastify();
    apps.push(app);
    const service = {
      create: vi.fn(async () => ({
        import_job_id: "11111111-1111-4111-8111-111111111111",
        status: "queued",
        replayed: false,
      })),
      attachItemMetadata: vi.fn(),
      enqueueManifest: vi.fn(async () => ({
        import_job_id: "11111111-1111-4111-8111-111111111111",
        status: "queued",
        replayed: false,
      })),
    };
    const uploadService = {
      uploadFile: vi.fn(async () => ({
        asset: { id: "44444444-4444-4444-8444-444444444444" },
      })),
      deleteAsset: vi.fn(),
    };
    await registerDesignImportRoutes(app, {
      auth: {
        authenticate: vi.fn(async () => ({ id: "user", accessToken: "token" })),
      } as never,
      service: service as never,
      uploadService: uploadService as never,
      importRoot: root,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/imports",
      payload: {
        scope: "workspace",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        source_kind: "server_directory",
        directory_path: "batch",
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(uploadService.uploadFile).toHaveBeenCalledOnce();
    expect(service.enqueueManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [
          expect.objectContaining({
            source_key: "legacy/asset.png",
            entity_kind: "resource",
          }),
        ],
      }),
    );
  });
});

function multipartImportBody(file: {
  name: string;
  mime: string;
  data: Buffer;
}) {
  const boundary = "----loomic-import-test";
  return {
    boundary,
    buffer: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="workspace_id"\r\n\r\n33333333-3333-4333-8333-333333333333\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function zipManifest(manifest: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.addBuffer(Buffer.from(manifest), "manifest.json");
    zip.end();
  });
}
