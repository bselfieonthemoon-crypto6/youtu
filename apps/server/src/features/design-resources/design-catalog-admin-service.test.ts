import { describe, expect, it, vi } from "vitest";

import { createDesignCatalogAdminService } from "./design-catalog-admin-service.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
};
const input = {
  request_id: "22222222-2222-4222-8222-222222222222",
  entity_kind: "resource" as const,
  entity_id: "33333333-3333-4333-8333-333333333333",
  expected_revision: 2,
  status: "published" as const,
};

describe("design catalog admin service", () => {
  it("reads template references without querying a nonexistent source-template column", async () => {
    const visible = {
      select: vi.fn(() => visible),
      eq: vi.fn(() => visible),
      maybeSingle: vi.fn(async () => ({
        data: { id: input.entity_id },
        error: null,
      })),
    };
    const adminFrom = vi.fn();
    const service = createDesignCatalogAdminService({
      getAdminClient: () => ({ from: adminFrom }) as never,
      createUserClient: () => ({ from: vi.fn(() => visible) }) as never,
    });
    await expect(
      service.references(user as never, "template", input.entity_id),
    ).resolves.toEqual({
      entity_kind: "template",
      entity_id: input.entity_id,
      references: [],
    });
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("passes actor, request id, and CAS revision to the status RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        entity_kind: "resource",
        entity_id: input.entity_id,
        revision: 3,
        status: "published",
        replayed: false,
      },
      error: null,
    }));
    const service = createDesignCatalogAdminService({
      getAdminClient: () => ({ rpc }) as never,
      createUserClient: vi.fn() as never,
    });
    await expect(
      service.setStatus(user as never, input),
    ).resolves.toMatchObject({ revision: 3 });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_catalog_set_status",
      expect.objectContaining({
        p_request_id: input.request_id,
        p_expected_revision: 2,
        p_actor_user_id: user.id,
      }),
    );
  });

  it.each([
    ["40001", "catalog_revision_conflict", 409],
    ["23505", "catalog_idempotency_conflict", 409],
    ["23514", "catalog_publish_dependency_missing", 409],
    ["42501", "catalog_write_forbidden", 403],
  ])("maps database mutation error %s", async (code, message, statusCode) => {
    const service = createDesignCatalogAdminService({
      getAdminClient: () =>
        ({
          rpc: vi.fn(async () => ({ data: null, error: { code, message } })),
        }) as never,
      createUserClient: vi.fn() as never,
    });
    await expect(service.setStatus(user as never, input)).rejects.toMatchObject(
      { statusCode },
    );
  });
});
