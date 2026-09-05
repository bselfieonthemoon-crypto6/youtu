import { describe, expect, it, vi } from "vitest";

import { createDesignResourceService } from "./design-resource-service.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
  email: "u@example.test",
  userMetadata: {},
};
const resourceId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";

function resourceRow(id = resourceId) {
  return {
    id,
    scope: "workspace",
    workspace_id: workspaceId,
    kind: "image",
    name: "Hero",
    description: null,
    asset_object_id: "44444444-4444-4444-8444-444444444444",
    preview_asset_object_id: null,
    width: 100,
    height: 100,
    checksum_sha256: null,
    revision: 0,
    status: "published",
    category_id: null,
    source_url: null,
    author: null,
    license_name: null,
    license_url: null,
    attribution: null,
    usage_restrictions: null,
    deleted_at: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
  };
}

describe("design resource service", () => {
  it("rejects opaque cursor tampering before issuing a catalog query", async () => {
    const createUserClient = vi.fn(() => ({ from: vi.fn() }));
    const service = createDesignResourceService({
      createUserClient: createUserClient as never,
      getAdminClient: vi.fn() as never,
    });
    await expect(
      service.list(user, { cursor: "not-a-cursor", limit: 30 }),
    ).rejects.toMatchObject({ code: "resource_invalid", statusCode: 400 });
  });

  it("uses a stable updated_at/id keyset and limit plus one", async () => {
    const rows = [
      resourceRow(),
      resourceRow("55555555-5555-4555-8555-555555555555"),
    ];
    const rpc = vi.fn(async (..._args: unknown[]) => ({
      data: rows.map((item) => ({ item })),
      error: null,
    }));
    const client = {
      rpc,
      from: vi.fn(),
    };
    const service = createDesignResourceService({
      createUserClient: () => client as never,
      getAdminClient: vi.fn() as never,
    });
    const first = await service.list(user, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "loomic_design_resources_list",
      expect.objectContaining({
        p_cursor_updated_at: null,
        p_cursor_id: null,
        p_limit: 1,
      }),
    );

    if (!first.next_cursor) throw new Error("expected a next cursor");
    await service.list(user, { cursor: first.next_cursor, limit: 1 });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "loomic_design_resources_list",
      expect.objectContaining({
        p_cursor_updated_at: "2026-09-04T00:00:00.000Z",
        p_cursor_id: resourceId,
      }),
    );
  });

  it("maps the actor-authorized create RPC denial without attempting direct writes", async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => ({
      data: null,
      error: { code: "42501", message: "catalog_write_forbidden" },
    }));
    const admin = { rpc, from: vi.fn() };
    const service = createDesignResourceService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => admin as never,
    });
    await expect(
      service.create(user, {
        request_id: "66666666-6666-4666-8666-666666666666",
        scope: "platform",
        workspace_id: null,
        kind: "image",
        name: "Platform asset",
        description: null,
        asset_object_id: "77777777-7777-4777-8777-777777777777",
        preview_asset_object_id: null,
        category_id: null,
        tag_ids: [],
        source_url: null,
        author: null,
        license_name: null,
        license_url: null,
        attribution: null,
        usage_restrictions: null,
      }),
    ).rejects.toMatchObject({ code: "resource_forbidden", statusCode: 403 });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_catalog_create",
      expect.objectContaining({
        p_request_id: "66666666-6666-4666-8666-666666666666",
        p_entity_kind: "resource",
        p_actor_user_id: user.id,
      }),
    );
    const rpcPayload = (
      rpc.mock.calls[0]?.[1] as
        | { p_payload?: Record<string, unknown> }
        | undefined
    )?.p_payload;
    expect(rpcPayload).not.toHaveProperty("request_id");
    expect(rpcPayload).not.toHaveProperty("scope");
    expect(rpcPayload).not.toHaveProperty("workspace_id");
    expect(rpcPayload).toMatchObject({
      kind: "image",
      name: "Platform asset",
      width: null,
      height: null,
      checksum_sha256: null,
    });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("records recent use through the atomic increment RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        resource_id: resourceId,
        workspace_id: workspaceId,
        used_at: "2026-09-04T01:00:00.000Z",
        use_count: 7,
      },
      error: null,
    }));
    const client = { rpc, from: vi.fn() };
    const service = createDesignResourceService({
      createUserClient: () => client as never,
      getAdminClient: vi.fn() as never,
    });
    await expect(
      service.recordRecentUse(user, {
        resource_id: resourceId,
        workspace_id: workspaceId,
      }),
    ).resolves.toEqual({
      used_at: "2026-09-04T01:00:00.000Z",
      use_count: 7,
    });
    expect(rpc).toHaveBeenCalledWith("loomic_record_resource_recent_use", {
      p_resource_id: resourceId,
      p_workspace_id: workspaceId,
    });
    expect(client.from).not.toHaveBeenCalled();
  });
});
