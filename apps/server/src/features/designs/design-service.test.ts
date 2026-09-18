import { describe, expect, it, vi } from "vitest";

import type { DesignDocumentDto } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { createDesignService } from "./design-service.js";

const ids = {
  design: "10000000-0000-0000-0000-000000000001",
  object: "10000000-0000-0000-0000-000000000002",
  request: "20000000-0000-0000-0000-000000000001",
  canvas: "30000000-0000-0000-0000-000000000001",
  workspace: "40000000-0000-0000-0000-000000000001",
  project: "50000000-0000-0000-0000-000000000001",
  user: "60000000-0000-0000-0000-000000000001",
} as const;

const user: AuthenticatedUser = {
  id: ids.user,
  email: "owner@local.test",
  accessToken: "token",
  userMetadata: {},
};

const documentRow: DesignDocumentDto = {
  id: ids.design,
  workspace_id: ids.workspace,
  project_id: ids.project,
  name: "Design",
  width: 1080,
  height: 1080,
  revision: 0,
  scene: {
    schemaVersion: 1,
    engine: "fabric",
    canvas: { width: 1080, height: 1080, background: "#ffffff" },
    objects: [],
  },
  preview_asset_object_id: null,
  preview_revision: 0,
  preview_status: "missing",
  deleted_at: null,
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
};

describe("design service", () => {
  it("creates through the authenticated atomic RPC with a stable request id", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        design_id: ids.design,
        canvas_element_id: "node-1",
        design_revision: 0,
        canvas_revision: 1,
        replayed: false,
      },
      error: null,
    });
    const service = createDesignService({
      createUserClient: () => ({ rpc }) as never,
      getAdminClient: () => ({}) as never,
    });

    const result = await service.create(user, {
      request_id: ids.request,
      canvas_id: ids.canvas,
      expected_canvas_revision: 4,
      canvas_element_id: "node-1",
      name: "Design",
      width: 1080,
      height: 1080,
      background: "#ffffff",
      node: { x: 10, y: 20, width: 320, height: 320 },
    });

    expect(result.design_id).toBe(ids.design);
    expect(rpc).toHaveBeenCalledWith(
      "loomic_design_create",
      expect.objectContaining({
        p_request_id: ids.request,
        p_expected_canvas_revision: 4,
        p_canvas_element_id: "node-1",
      }),
    );
  });

  it("preserves the Canvas identity in atomic creation CAS conflicts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "40001",
        message: "canvas_revision_conflict",
        details: JSON.stringify({ latest_revision: 5 }),
      },
    });
    const service = createDesignService({
      createUserClient: () => ({ rpc }) as never,
      getAdminClient: () => ({}) as never,
    });

    await expect(
      service.create(user, {
        request_id: ids.request,
        canvas_id: ids.canvas,
        expected_canvas_revision: 4,
        canvas_element_id: "node-1",
        width: 1080,
        height: 1080,
        background: "#ffffff",
        node: { x: 10, y: 20, width: 320, height: 320 },
      }),
    ).rejects.toMatchObject({
      code: "design_conflict",
      statusCode: 409,
      conflict: {
        canvasId: ids.canvas,
        latestRevision: 5,
        retryable: false,
      },
    });
  });

  it("hides soft-deleted rows in the read query", async () => {
    const query = queryResult(documentRow);
    const service = createDesignService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: () => ({}) as never,
    });

    await expect(service.get(user, ids.design)).resolves.toMatchObject({
      id: ids.design,
      deleted_at: null,
    });
    expect(query.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("parses commands, derives next_scene, and calls only the service mutation RPC", async () => {
    const query = queryResult(documentRow);
    const rpc = vi.fn().mockResolvedValue({
      data: {
        design_id: ids.design,
        revision: 1,
        changed_object_ids: [ids.object],
        replayed: false,
      },
      error: null,
    });
    const service = createDesignService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: () =>
        ({
          rpc,
          from: vi.fn(() => {
            const replayQuery = {
              select: vi.fn(() => replayQuery),
              eq: vi.fn(() => replayQuery),
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            };
            return replayQuery;
          }),
        }) as never,
    });
    const object = {
      objectId: ids.object,
      objectVersion: 1,
      type: "rect" as const,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
      fill: { kind: "solid" as const, color: "#ffffff" },
      stroke: null,
      strokeWidth: 0,
    };

    await service.mutate(user, {
      design_id: ids.design,
      expected_revision: 0,
      idempotency_key: ids.request,
      commands: [{ action: "object.add", object }],
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "loomic_design_mutate",
      expect.objectContaining({
        p_actor_kind: "user",
        p_actor_user_id: ids.user,
        p_next_scene: expect.objectContaining({ objects: [object] }),
      }),
    );
  });

  it("routes agent mutations through the audited agent RPC", async () => {
    const query = queryResult(documentRow);
    const rpcResponses = [
      {
        data: null,
        error: { code: "42501", message: "agent_design_execution_invalid" },
      },
      {
        data: {
          status: "applied",
          design_id: ids.design,
          revision: 1,
          changed_object_ids: [],
          replayed: false,
        },
        error: null,
      },
    ];
    const replayQuery = {
      select: vi.fn(() => replayQuery),
      eq: vi.fn(() => replayQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const adminClient = {
      rpc: vi.fn(function (this: unknown) {
        expect(this).toBe(adminClient);
        return Promise.resolve(rpcResponses.shift());
      }),
      from: vi.fn(() => replayQuery),
    };
    const service = createDesignService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: () => adminClient as never,
    });

    await service.mutate(
      user,
      {
        design_id: ids.design,
        expected_revision: 0,
        idempotency_key: ids.request,
        commands: [{ action: "canvas.update", background: "#000000" }],
      },
      {
        actorKind: "agent",
        agentRunId: "70000000-0000-4000-8000-000000000001",
        toolExecutionId: "80000000-0000-4000-8000-000000000001",
        operation: "manipulate_design",
      },
    );

    expect(adminClient.rpc).toHaveBeenCalledWith(
      "loomic_agent_design_mutate_v2",
      expect.objectContaining({
        p_operation: "manipulate_design",
        p_actor_user_id: ids.user,
        p_agent_run_id: "70000000-0000-4000-8000-000000000001",
        p_tool_execution_id: "80000000-0000-4000-8000-000000000001",
      }),
    );
    expect(adminClient.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "handles stale user mutation receipt (exact=%s) before applying commands",
    async (exact) => {
      const commands = [
        { action: "canvas.update" as const, background: "#000000" },
      ];
      const query = queryResult({ ...documentRow, revision: 1 });
      const receipt = {
        select: vi.fn(() => receipt),
        eq: vi.fn(() => receipt),
        maybeSingle: vi.fn(async () => ({
          data: {
            parent_revision: 0,
            command_batch: exact ? commands : [],
            actor_kind: "user",
            actor_user_id: ids.user,
          },
          error: null,
        })),
      };
      const rpc = vi.fn(async () => ({
        data: {
          design_id: ids.design,
          revision: 1,
          changed_object_ids: [],
          replayed: true,
        },
        error: null,
      }));
      const service = createDesignService({
        createUserClient: () => ({ from: vi.fn(() => query) }) as never,
        getAdminClient: () => ({ from: vi.fn(() => receipt), rpc }) as never,
      });
      const result = service.mutate(user, {
        design_id: ids.design,
        expected_revision: 0,
        idempotency_key: ids.request,
        commands,
      });
      if (exact) {
        await expect(result).resolves.toMatchObject({
          replayed: true,
          revision: 1,
        });
        expect(rpc).toHaveBeenCalledWith(
          "loomic_design_mutate",
          expect.objectContaining({ p_next_scene: documentRow.scene }),
        );
      } else {
        await expect(result).rejects.toMatchObject({ code: "design_conflict" });
        expect(rpc).not.toHaveBeenCalled();
      }
    },
  );

  it("replays an exact agent mutation before reapplying object versions", async () => {
    const query = queryResult({ ...documentRow, revision: 1 });
    const commands = [
      { action: "canvas.update" as const, background: "#000000" },
    ];
    const versionQuery = {
      select: vi.fn(() => versionQuery),
      eq: vi.fn(() => versionQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          revision: 1,
          parent_revision: 0,
          command_batch: commands,
          changed_object_ids: [],
          tool_execution_id: "80000000-0000-4000-8000-000000000001",
        },
        error: null,
      })),
    };
    const requestQuery = {
      select: vi.fn(() => requestQuery),
      eq: vi.fn(() => requestQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          operation: "manipulate_design",
          template_id: null,
          expected_template_revision: null,
        },
        error: null,
      })),
    };
    const rpc = vi.fn();
    const service = createDesignService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: () =>
        ({
          rpc,
          from: vi.fn((table: string) =>
            table === "design_document_versions" ? versionQuery : requestQuery,
          ),
        }) as never,
    });

    await expect(
      service.mutate(
        user,
        {
          design_id: ids.design,
          expected_revision: 0,
          idempotency_key: ids.request,
          commands,
        },
        {
          actorKind: "agent",
          agentRunId: "70000000-0000-4000-8000-000000000001",
          toolExecutionId: "80000000-0000-4000-8000-000000000002",
          operation: "manipulate_design",
        },
      ),
    ).resolves.toMatchObject({ revision: 1, replayed: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects changed agent commands that reuse an idempotency key", async () => {
    const query = queryResult({ ...documentRow, revision: 1 });
    const versionQuery = {
      select: vi.fn(() => versionQuery),
      eq: vi.fn(() => versionQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          revision: 1,
          parent_revision: 0,
          command_batch: [{ action: "canvas.update", background: "#000000" }],
          changed_object_ids: [],
          tool_execution_id: "80000000-0000-4000-8000-000000000001",
        },
        error: null,
      })),
    };
    const requestQuery = {
      select: vi.fn(() => requestQuery),
      eq: vi.fn(() => requestQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          operation: "manipulate_design",
          template_id: null,
          expected_template_revision: null,
        },
        error: null,
      })),
    };
    const service = createDesignService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: () =>
        ({
          rpc: vi.fn(),
          from: vi.fn((table: string) =>
            table === "design_document_versions" ? versionQuery : requestQuery,
          ),
        }) as never,
    });
    await expect(
      service.mutate(
        user,
        {
          design_id: ids.design,
          expected_revision: 0,
          idempotency_key: ids.request,
          commands: [{ action: "canvas.update", background: "#ffffff" }],
        },
        {
          actorKind: "agent",
          agentRunId: "70000000-0000-4000-8000-000000000001",
          toolExecutionId: "80000000-0000-4000-8000-000000000002",
          operation: "manipulate_design",
        },
      ),
    ).rejects.toMatchObject({ code: "design_conflict", statusCode: 409 });
  });

  it("maps database serialization failures to a structured conflict", async () => {
    const query = queryResult(documentRow);
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "40001",
        message: "design_revision_conflict",
        details: JSON.stringify({ latest_revision: 8 }),
      },
    });
    const service = createDesignService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      service.mutate(user, {
        design_id: ids.design,
        expected_revision: 0,
        idempotency_key: ids.request,
        commands: [{ action: "scene.replace", scene: documentRow.scene }],
      }),
    ).rejects.toMatchObject({
      code: "design_conflict",
      statusCode: 409,
      conflict: {
        designId: ids.design,
        latestRevision: 8,
        conflictObjectIds: [],
        retryable: false,
      },
    });
  });

  it("loads canonical asset and font references after authorizing the design", async () => {
    const documentQuery = queryResult(documentRow);
    const assetQuery = listQuery([]);
    const fontQuery = listQuery([]);
    const from = vi.fn((table: string) => {
      if (table === "design_documents") return documentQuery;
      if (table === "design_document_asset_refs") return assetQuery;
      return fontQuery;
    });
    const service = createDesignService({
      createUserClient: () => ({ from }) as never,
      getAdminClient: () => ({}) as never,
    });

    await expect(service.references(user, ids.design)).resolves.toEqual({
      assets: [],
      fonts: [],
    });
    expect(from).toHaveBeenCalledWith("design_document_asset_refs");
    expect(from).toHaveBeenCalledWith("design_document_font_refs");
  });

  it("uses the atomic lifecycle RPCs and preserves replay responses", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { design_id: ids.design, revision: 2, replayed: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { design_id: ids.design, revision: 3, replayed: false },
        error: null,
      });
    const service = createDesignService({
      createUserClient: () => ({}) as never,
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      service.rename(user, {
        design_id: ids.design,
        expected_revision: 1,
        idempotency_key: ids.request,
        name: "Renamed",
      }),
    ).resolves.toEqual({
      design_id: ids.design,
      revision: 2,
      replayed: true,
    });
    await service.softDelete(user, {
      design_id: ids.design,
      expected_revision: 2,
      idempotency_key: ids.request,
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "loomic_design_rename", {
      p_design_id: ids.design,
      p_expected_revision: 1,
      p_idempotency_key: ids.request,
      p_name: "Renamed",
      p_actor_user_id: ids.user,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "loomic_design_soft_delete", {
      p_design_id: ids.design,
      p_expected_revision: 2,
      p_idempotency_key: ids.request,
      p_actor_user_id: ids.user,
    });
  });

  it("maps lifecycle idempotency collisions to a structured conflict", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "design_idempotency_conflict" },
    });
    const service = createDesignService({
      createUserClient: () => ({}) as never,
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      service.restore(user, {
        design_id: ids.design,
        expected_revision: 3,
        idempotency_key: ids.request,
      }),
    ).rejects.toMatchObject({
      code: "design_conflict",
      statusCode: 409,
      conflict: { designId: ids.design, retryable: false },
    });
  });

  it("prioritizes the destination Canvas CAS for copy revision conflicts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "40001",
        message: "canvas_revision_conflict",
        details: JSON.stringify({ latest_revision: 12 }),
      },
    });
    const service = createDesignService({
      createUserClient: () => ({}) as never,
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      service.copy(user, {
        request_id: ids.request,
        source_design_id: ids.design,
        canvas_id: ids.canvas,
        expected_canvas_revision: 11,
        canvas_element_id: "copy-node",
        node: { x: 10, y: 20, width: 320, height: 320 },
      }),
    ).rejects.toMatchObject({
      code: "design_conflict",
      statusCode: 409,
      conflict: {
        canvasId: ids.canvas,
        latestRevision: 12,
        retryable: false,
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_design_copy",
      expect.objectContaining({
        p_source_design_id: ids.design,
        p_canvas_id: ids.canvas,
      }),
    );
  });
});

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  return query;
}

function listQuery(data: unknown[]) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}
