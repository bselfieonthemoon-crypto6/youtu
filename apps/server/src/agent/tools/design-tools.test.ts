import { describe, expect, it, vi } from "vitest";

import {
  type DesignCommand,
  type LoomicSceneV1,
  inspectDesignToolOutputSchema,
  manipulateDesignToolOutputSchema,
} from "@loomic/shared";

import { createDestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import { createDesignTools, createDurableDesignMutationExecutor } from "./design-tools.js";
import { applyDesignCommands } from "../../features/designs/design-command-applier.js";
import { toolExecutionContext } from "./tool-run-context.js";

const ids = {
  design: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  run: "30000000-0000-4000-8000-000000000001",
  execution: "40000000-0000-4000-8000-000000000001",
  canvas: "50000000-0000-4000-8000-000000000001",
  request: "60000000-0000-4000-8000-000000000001",
  object: "70000000-0000-4000-8000-000000000001",
  task: "a0000000-0000-4000-8000-000000000001",
  session: "b0000000-0000-4000-8000-000000000001",
} as const;

const design = {
  id: ids.design,
  workspace_id: "80000000-0000-4000-8000-000000000001",
  project_id: "90000000-0000-4000-8000-000000000001",
  name: "Agent design",
  width: 1080,
  height: 1080,
  revision: 4,
  scene: {
    schemaVersion: 1 as const,
    engine: "fabric" as const,
    canvas: { width: 1080, height: 1080, background: "#ffffff" },
    objects: [
      {
        objectId: ids.object,
        objectVersion: 1,
        type: "rect" as const,
        x: 10,
        y: 20,
        width: 100,
        height: 80,
        rotation: 0,
        opacity: 1,
        zIndex: 0,
        locked: false,
        visible: true,
        fill: "#ff0000",
        stroke: null,
        strokeWidth: 0,
      },
    ],
  },
  preview_asset_object_id: null,
  preview_revision: 4,
  preview_status: "ready" as const,
  deleted_at: null,
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
};

function config() {
  return {
    runId: ids.execution,
    configurable: {
      user_id: ids.user,
      access_token: "token",
      run_id: ids.run,
      tool_execution_id: ids.execution,
      workspace_id: design.workspace_id,
      canvas_id: ids.canvas,
    },
  };
}

function makeTools(overrides: Record<string, unknown> = {}) {
  const mutate = vi.fn().mockResolvedValue({
    design_id: ids.design,
    revision: 5,
    changed_object_ids: [ids.object],
    replayed: false,
  });
  const dependencies = {
    designService: { get: vi.fn().mockResolvedValue(design), mutate },
    designResourceService: { list: vi.fn() },
    designTemplateService: { get: vi.fn() },
    ...overrides,
  };
  return { tools: createDesignTools(dependencies as never), mutate };
}

function toolAt(tools: ReturnType<typeof createDesignTools>, index: number) {
  const candidate = tools[index];
  if (!candidate) throw new Error(`Missing design tool at index ${index}.`);
  return candidate;
}

describe("agent design tools", () => {
  it.each([
    { patch: { font_size: 36 }, expected: "commands[0].patch.object_type" },
    { patch: { object_type: "text", fontSize: 36, fontWeight: 700 }, expected: "commands[0].patch.fontSize: use font_size" },
  ])("returns actionable strict patch validation without losing intended changes ($expected)", async ({ patch, expected }) => {
    const { tools, mutate } = makeTools();
    const input = { design_id: ids.design, expected_revision: 4, idempotency_key: ids.request,
      commands: [{ action: "object.update", object_id: ids.object, expected_object_version: 1,
        patch: { ...patch, text: "private customer content sk-private-value" } }] };
    const original = JSON.stringify(input);
    const output = JSON.parse(String(await toolAt(tools, 2).execute(input, toolExecutionContext(config()))));
    expect(output).toMatchObject({ status: "error", code: "validation_error" });
    expect(output.message).toContain(expected);
    expect(output.message).toContain('object_type:"text",font_size:36,font_weight:700');
    expect(output.message).toContain("Nothing applied");
    expect(output.message).not.toContain("private customer content");
    expect(output.message).not.toContain("sk-private-value");
    expect(JSON.stringify(input)).toBe(original);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("points to the invalid command and rejects the whole batch before applying valid siblings", async () => {
    const { tools, mutate } = makeTools();
    const output = JSON.parse(String(await toolAt(tools, 2).execute({
      design_id: ids.design, expected_revision: 4, idempotency_key: ids.request,
      commands: [
        { action: "object.update", object_id: ids.object, expected_object_version: 1, patch: { object_type: "rect", opacity: 0.5 } },
        { action: "object.update", object_id: ids.object, expected_object_version: 1, patch: { font_size: 36 } },
      ],
    }, toolExecutionContext(config()))));
    expect(output.message).toContain("commands[1].patch.object_type");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("applies real typography and layout fields through the canonical command applier", async () => {
    let savedScene = { ...design.scene, objects: [{ ...design.scene.objects[0]!, type: "text", text: "Keep wording",
      fontFaceId: null, fontFamily: "Arial", fontSize: 30, fontWeight: 400, fontStyle: "normal", textAlign: "left",
      lineHeight: 1.2, charSpacing: 0, fill: { kind: "solid", color: "#112233" },
    }] } as LoomicSceneV1;
    const mutate = vi.fn(async (_user: unknown, input: { commands: DesignCommand[] }) => {
      savedScene = applyDesignCommands(savedScene, input.commands);
      return { design_id: ids.design, revision: 5, changed_object_ids: [ids.object], replayed: false };
    });
    const { tools } = makeTools({ designService: { get: vi.fn(async () => ({ ...design, scene: savedScene })), mutate } });
    const output = JSON.parse(String(await toolAt(tools, 2).execute({
      design_id: ids.design, expected_revision: 4, idempotency_key: ids.request,
      commands: [{ action: "object.update", object_id: ids.object, expected_object_version: 1,
        patch: { object_type: "text", font_size: 36, font_weight: 700, x: 40, y: 50 } }],
    }, toolExecutionContext(config()))));
    expect(output.status).toBe("applied");
    expect(savedScene.objects[0]).toMatchObject({ text: "Keep wording", fontSize: 36, fontWeight: 700, x: 40, y: 50, objectVersion: 2 });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("reports no_change for identical saved text without creating a revision or preview", async () => {
    const current = { ...design, scene: { ...design.scene, objects: [{ ...design.scene.objects[0]!, type: "text", text: "Already correct" }] } };
    const mutate = vi.fn();
    const previews = { enqueue: vi.fn() };
    const { tools } = makeTools({ designService: { get: vi.fn().mockResolvedValue(current), mutate }, designPreviewService: previews });
    const output = JSON.parse(String(await toolAt(tools, 2).execute({
      design_id: ids.design, expected_revision: 4, idempotency_key: ids.request,
      commands: [{ action: "object.update", object_id: ids.object, expected_object_version: 1,
        patch: { object_type: "text", text: "Already correct" } }],
    }, toolExecutionContext(config()))));
    expect(manipulateDesignToolOutputSchema.parse(output)).toMatchObject({ status: "error", code: "validation_error", current_revision: 4 });
    expect(output.message).toMatch(/^no_change:/);
    expect(mutate).not.toHaveBeenCalled();
    expect(previews.enqueue).not.toHaveBeenCalled();
  });

  it("preserves canonical idempotent replay when the design advanced after the original request", async () => {
    const current = { ...design, revision: 5,
      scene: { ...design.scene, objects: [{ ...design.scene.objects[0]!, opacity: 0.5 }] } };
    const mutate = vi.fn().mockResolvedValue({ design_id: ids.design, revision: 5, changed_object_ids: [ids.object], replayed: true });
    const { tools } = makeTools({ designService: { get: vi.fn().mockResolvedValue(current), mutate } });
    const output = JSON.parse(String(await toolAt(tools, 2).execute({
      design_id: ids.design, expected_revision: 4, idempotency_key: ids.request,
      commands: [{ action: "object.update", object_id: ids.object, expected_object_version: 1,
        patch: { object_type: "rect", opacity: 0.5 } }],
    }, toolExecutionContext(config()))));
    expect(output).toMatchObject({ status: "applied", replayed: true });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("blocks artboard mutation during an explicitly bound independent image edit", async () => {
    const { tools, mutate } = makeTools();
    const cfg = config();
    const output = JSON.parse(String(await toolAt(tools, 2).execute({
      design_id: ids.design, expected_revision: 4, idempotency_key: ids.request,
      commands: [{ action: "object.update", object_id: ids.object, expected_object_version: 1, patch: { object_type: "rect", opacity: 0.5 } }],
    }, toolExecutionContext({ ...cfg, configurable: { ...cfg.configurable, image_edit_routing: { assetId: "logo" } } }))));
    expect(output.status).toBe("error");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("paginates beyond 100 layers with a revision guard and explicit layer metadata", async () => {
    const objects = Array.from({ length: 125 }, (_, index) => ({
      ...design.scene.objects[0]!,
      objectId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      zIndex: index,
    }));
    const { tools } = makeTools({ designService: {
      get: vi.fn().mockResolvedValue({ ...design, scene: { ...design.scene, objects } }),
    } });
    const read = async (extra: Record<string, unknown>) => JSON.parse(String(
      await toolAt(tools, 0).execute({ design_id: ids.design, object_limit: 100, ...extra }, toolExecutionContext(config())),
    ));
    const first = await read({});
    expect(first.next_offset).toBe(100);
    expect(first.objects[0]).toMatchObject({ z_index: 0, visible: true, locked: false, child_object_ids: [] });
    const last = await read({ offset: 100, expected_revision: 4 });
    expect(last.objects).toHaveLength(25);
    expect(last.objects[0].z_index).toBe(100);
    expect(last.next_offset).toBeNull();
    expect(last.truncated).toBe(false);
    expect((await read({ offset: 100 })).code).toBe("validation_error");
    expect((await read({ offset: 100, expected_revision: 3 })).code).toBe("design_revision_conflict");
  });
  it("returns an inspect result that satisfies the shared strict contract", async () => {
    const { tools } = makeTools();
    const output = JSON.parse(
      String(
        await toolAt(tools, 0).execute({
            design_id: ids.design,
            selection_object_ids: [ids.object],
            object_limit: 50,
            text_limit: 160,
          }, toolExecutionContext(config())),
      ),
    );

    expect(inspectDesignToolOutputSchema.parse(output)).toMatchObject({
      design_id: ids.design,
      revision: 4,
      object_count: 1,
      selection_object_ids: [ids.object],
    });
  });

  it("binds a non-destructive mutation to the agent run and tool ledger ids", async () => {
    const previews = { enqueue: vi.fn().mockResolvedValue({}) };
    const { tools, mutate } = makeTools({ designPreviewService: previews });
    const output = JSON.parse(
      String(
        await toolAt(tools, 2).execute({
            design_id: ids.design,
            expected_revision: 4,
            idempotency_key: ids.request,
            commands: [
              {
                action: "object.update",
                object_id: ids.object,
                expected_object_version: 1,
                patch: { object_type: "rect", opacity: 0.5 },
              },
            ],
          }, toolExecutionContext(config())),
      ),
    );

    expect(manipulateDesignToolOutputSchema.parse(output)).toMatchObject({
      status: "applied",
      revision: 5,
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotency_key: ids.request }),
      {
        actorKind: "agent",
        agentRunId: ids.run,
        toolExecutionId: ids.execution,
        operation: "manipulate_design",
      },
    );
    expect(previews.enqueue).toHaveBeenCalledWith({
      actorUserId: ids.user,
      designId: ids.design,
      expectedRevision: 5,
      idempotencyKey: ids.request,
    });
  });

  it("does not execute deletion before the confirmation service confirms", async () => {
    const confirmation = createDestructiveConfirmationService();
    const { tools, mutate } = makeTools({
      destructiveConfirmationService: confirmation,
    });
    const output = JSON.parse(
      String(
        await toolAt(tools, 2).execute({
            design_id: ids.design,
            expected_revision: 4,
            idempotency_key: ids.request,
            commands: [
              {
                action: "object.remove",
                object_id: ids.object,
                expected_object_version: 1,
              },
            ],
          }, toolExecutionContext(config())),
      ),
    );

    expect(manipulateDesignToolOutputSchema.parse(output)).toMatchObject({
      status: "confirmation_required",
      design_id: ids.design,
      affected_object_ids: [ids.object],
    });
    expect(mutate).not.toHaveBeenCalled();
    await confirmation.confirm({
      confirmationId: output.confirmation_id,
      userId: ids.user,
      canvasId: ids.canvas,
      kind: "design_mutation",
      runId: "30000000-0000-4000-8000-000000000002",
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        confirmationId: output.confirmation_id,
        destructiveConfirmed: true,
      }),
    );
  });

  it("replays a durable confirmation with the frozen original tool ledger and task scope", async () => {
    const mutate = vi.fn().mockResolvedValue({
      design_id: ids.design,
      revision: 5,
      changed_object_ids: [ids.object],
      replayed: false,
    });
    const enqueue = vi.fn().mockResolvedValue({});
    const assertCurrentRun = vi.fn().mockResolvedValue({
      id: ids.task,
      revision: 2,
      runId: ids.run,
      sessionId: ids.session,
      canvasId: ids.canvas,
      goal: "delete",
      corrections: [],
      target: { kind: "design", designId: ids.design },
      brief: {},
    });
    const execute = createDurableDesignMutationExecutor({
      designService: { mutate } as never,
      designPreviewService: { enqueue } as never,
      agentTaskService: { assertCurrentRun } as never,
    });
    const action = {
      confirmationId: "c0000000-0000-4000-8000-000000000001",
      kind: "design_mutation" as const,
      userId: ids.user,
      workspaceId: design.workspace_id,
      sessionId: ids.session,
      canvasId: ids.canvas,
      taskId: ids.task,
      taskRevision: 2,
      originRunId: ids.run,
      toolExecutionId: ids.execution,
      workflowStepId: "delete-old",
      details: { design_id: ids.design, expected_revision: 4 },
      payload: {
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: ids.request,
        commands: [{ action: "object.remove", object_id: ids.object, expected_object_version: 1 }],
      },
      status: "executing" as const,
      claimToken: "d0000000-0000-4000-8000-000000000001",
      result: null,
      completionDone: false,
      confirmedAt: "2026-09-10T11:00:00.000Z",
      expiresAt: "2026-09-10T12:00:00.000Z",
    };
    const user = { id: ids.user, accessToken: "token", email: "qa@local.test", userMetadata: {} };
    await expect(execute(action, { user })).resolves.toMatchObject({ revision: 5 });
    expect(mutate).toHaveBeenCalledWith(user, action.payload, expect.objectContaining({
      agentRunId: ids.run,
      toolExecutionId: ids.execution,
      confirmationId: action.confirmationId,
      destructiveConfirmed: true,
    }));
    expect(enqueue).toHaveBeenCalledOnce();

    assertCurrentRun.mockResolvedValueOnce({ ...(await assertCurrentRun.mock.results[0]!.value), revision: 3 });
    await expect(execute(action, { user })).rejects.toThrow("agent_task_superseded");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("returns a strict revision error before a stale mutation", async () => {
    const { tools, mutate } = makeTools();
    const output = JSON.parse(
      String(
        await toolAt(tools, 1).execute({
            design_id: ids.design,
            expected_revision: 3,
            object_ids: [ids.object],
          }, toolExecutionContext(config())),
      ),
    );

    expect(output).toEqual({
      status: "error",
      code: "design_revision_conflict",
      message: "The design changed; inspect it again before retrying.",
      retryable: true,
      current_revision: 4,
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("passes the active workspace into query-layer resource pagination", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    const { tools } = makeTools({ designResourceService: { list } });
    await toolAt(tools, 3).execute({
        workspace_id: design.workspace_id,
        query: "logo",
        limit: 20,
        summary_max_chars: 240,
      }, toolExecutionContext(config()));
    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: "logo", status: "published" }),
      { activeWorkspaceId: design.workspace_id },
    );
  });

  it("hides a published template owned by another workspace before proposing", async () => {
    const confirmation = createDestructiveConfirmationService();
    const proposeAction = vi.spyOn(confirmation, "proposeAction");
    const { tools } = makeTools({
      destructiveConfirmationService: confirmation,
      designTemplateService: {
        get: vi.fn().mockResolvedValue({
          template: {
            id: "10000000-0000-4000-8000-000000000099",
            scope: "workspace",
            workspace_id: "80000000-0000-4000-8000-000000000099",
            revision: 1,
            status: "published",
            name: "Foreign",
          },
          scene: design.scene,
        }),
      },
    });
    const output = JSON.parse(
      String(
        await toolAt(tools, 4).execute({
            design_id: ids.design,
            expected_revision: 4,
            idempotency_key: ids.request,
            template_id: "10000000-0000-4000-8000-000000000099",
            expected_template_revision: 1,
            mode: "replace",
          }, toolExecutionContext(config())),
      ),
    );
    expect(output).toMatchObject({
      status: "error",
      code: "template_not_found",
    });
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it("reports the durable export replay flag", async () => {
    const enqueueWithReplay = vi.fn().mockResolvedValue({
      job: {
        id: "10000000-0000-4000-8000-000000000088",
        status: "queued",
      },
      replayed: true,
    });
    const { tools } = makeTools({
      designExportService: { enqueueWithReplay },
    });
    const output = JSON.parse(
      String(
        await toolAt(tools, 5).execute({
            design_id: ids.design,
            expected_revision: 4,
            idempotency_key: ids.request,
            format: "png",
            multiplier: 1,
            transparent: true,
          }, toolExecutionContext(config())),
      ),
    );
    expect(output).toMatchObject({ replayed: true });
  });

  it("rejects oversized detailed-object batches before serializing them", async () => {
    const { tools } = makeTools();
    await expect(
      toolAt(tools, 1).execute({
          design_id: ids.design,
          expected_revision: 4,
          object_ids: Array.from(
            { length: 11 },
            (_, index) =>
              `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          ),
        }, toolExecutionContext(config())),
    ).rejects.toThrow();
  });
});
