import { describe, expect, it, vi } from "vitest";

import {
  assertSafeUploadedSvg,
  createUploadService,
} from "./upload-service.js";

const user = {
  id: "11111111-1111-1111-1111-111111111111",
  accessToken: "user-token",
  email: "owner@local.test",
  userMetadata: {},
};

function queryReturning(result: { data: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  return query;
}

describe("upload service metadata writes", () => {
  it("checks owner/admin membership before any service-role upload", async () => {
    const membership = queryReturning({
      data: { role: "member" },
      error: null,
    });
    const upload = vi.fn();
    const admin = {
      from: vi.fn(() => membership),
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const createUserClient = vi.fn();
    const service = createUploadService({
      createUserClient: createUserClient as never,
      getAdminClient: () => admin as never,
    });

    await expect(
      service.uploadFile(user, {
        bucket: "workspace-assets",
        workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        fileName: "image.png",
        fileBuffer: Buffer.from("png"),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "upload_failed" });
    expect(upload).not.toHaveBeenCalled();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it("uses the service-role client only after explicit scope authorization", async () => {
    const membership = queryReturning({ data: { role: "admin" }, error: null });
    const assetRow = {
      id: "80000000-0000-0000-0000-000000000001",
      bucket: "workspace-assets",
      object_path: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/1-image.png",
      mime_type: "image/png",
      byte_size: 3,
      workspace_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      project_id: null,
      created_at: "2026-09-04T00:00:00.000Z",
    };
    const single = vi.fn(async () => ({ data: assetRow, error: null }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const upload = vi.fn(async () => ({ error: null }));
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: "https://signed.local/image.png" },
      error: null,
    }));
    const storageFrom = vi.fn(() => ({ upload, createSignedUrl }));
    const admin = {
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membership : { insert },
      ),
      storage: { from: storageFrom },
    };
    const createUserClient = vi.fn();
    const service = createUploadService({
      createUserClient: createUserClient as never,
      getAdminClient: () => admin as never,
    });

    const result = await service.uploadFile(user, {
      bucket: "workspace-assets",
      workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      fileName: "image.png",
      fileBuffer: Buffer.from("png"),
      mimeType: "image/png",
    });

    expect(result.asset.id).toBe(assetRow.id);
    expect(result.url).toBe("https://signed.local/image.png");
    expect(upload).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        created_by: user.id,
      }),
    );
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it("rejects a project outside the authorized workspace before upload", async () => {
    const membership = queryReturning({ data: { role: "owner" }, error: null });
    const project = queryReturning({ data: null, error: null });
    const upload = vi.fn();
    const admin = {
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membership : project,
      ),
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const service = createUploadService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => admin as never,
    });

    await expect(
      service.uploadFile(user, {
        bucket: "workspace-assets",
        workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        projectId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        fileName: "image.png",
        fileBuffer: Buffer.from("png"),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(upload).not.toHaveBeenCalled();
  });

  it("removes the service-role storage object when metadata insertion fails", async () => {
    const membership = queryReturning({ data: { role: "owner" }, error: null });
    const single = vi.fn(async () => ({
      data: null,
      error: { message: "insert rejected" },
    }));
    const insert = vi.fn(() => ({ select: vi.fn(() => ({ single })) }));
    const upload = vi.fn(async () => ({ error: null }));
    const remove = vi.fn(async () => ({ error: null }));
    const admin = {
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membership : { insert },
      ),
      storage: { from: vi.fn(() => ({ upload, remove })) },
    };
    const service = createUploadService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => admin as never,
    });

    await expect(
      service.uploadFile(user, {
        bucket: "workspace-assets",
        workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        fileName: "image.png",
        fileBuffer: Buffer.from("png"),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ statusCode: 500, code: "upload_failed" });
    expect(remove).toHaveBeenCalledWith([
      expect.stringMatching(
        /^aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/\d+-image\.png$/,
      ),
    ]);
  });
});

describe("SVG upload boundary", () => {
  it("accepts self-contained declarative SVG artwork", () => {
    expect(() =>
      assertSafeUploadedSvg(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M0 0h10v10z"/></svg>',
        ),
      ),
    ).not.toThrow();
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.test/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path onload="alert(1)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>',
  ])("rejects active SVG content before storage upload", (source) => {
    expect(() => assertSafeUploadedSvg(Buffer.from(source))).toThrowError(
      expect.objectContaining({ code: "upload_failed", statusCode: 400 }),
    );
  });
});
