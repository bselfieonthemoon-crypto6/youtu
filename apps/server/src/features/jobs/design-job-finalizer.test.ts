import { describe, expect, it, vi } from "vitest";

import type {
  BackgroundJob,
  DesignCommand,
  DesignDocumentDto,
  JobTargetFinalizationDto,
} from "@loomic/shared";

import {
  type DesignFinalizationRepository,
  DesignJobFinalizer,
  DesignJobMutationConflict,
  type DesignJobMutationPort,
  reconcileSucceededDesignImageJobs,
} from "./design-job-finalizer.js";

const ids = {
  job: "10000000-0000-4000-8000-000000000001",
  workspace: "20000000-0000-4000-8000-000000000001",
  project: "30000000-0000-4000-8000-000000000001",
  design: "40000000-0000-4000-8000-000000000001",
  user: "50000000-0000-4000-8000-000000000001",
  command: "60000000-0000-4000-8000-000000000001",
  asset: "70000000-0000-4000-8000-000000000001",
  existingObject: "80000000-0000-4000-8000-000000000001",
};

function job(options?: {
  layerIndex?: number;
  expectedRevision?: number;
  replaceObjectId?: string;
}): BackgroundJob {
  return {
    id: ids.job,
    workspace_id: ids.workspace,
    project_id: ids.project,
    canvas_id: null,
    target_kind: "design",
    design_id: ids.design,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "succeeded",
    payload: {
      prompt: "hero",
      target: {
        kind: "design",
        design_id: ids.design,
        expected_revision: options?.expectedRevision ?? 1,
        idempotency_key: ids.command,
        placement: {
          ...(options?.layerIndex !== undefined ? { layer_index: options.layerIndex } : {}),
          x: 20,
          y: 30,
          width: 400,
          height: 300,
          ...(options?.replaceObjectId
            ? { replace_object_id: options.replaceObjectId }
            : {}),
        },
      },
    },
    result: {
      asset_id: ids.asset,
      width: 1024,
      height: 768,
      mime_type: "image/png",
    },
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: ids.user,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: "2026-09-04T00:00:00.000Z",
    completed_at: "2026-09-04T00:00:01.000Z",
    failed_at: null,
    canceled_at: null,
  };
}

function document(revision: number, withImage = false): DesignDocumentDto {
  return {
    id: ids.design,
    workspace_id: ids.workspace,
    project_id: ids.project,
    name: "Design",
    width: 1200,
    height: 800,
    revision,
    scene: {
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 1200, height: 800, background: "#fff" },
      objects: withImage
        ? [
            {
              objectId: ids.existingObject,
              objectVersion: 2,
              type: "image",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              rotation: 0,
              opacity: 1,
              zIndex: 0,
              locked: false,
              visible: true,
              assetObjectId: "90000000-0000-4000-8000-000000000001",
              fit: "contain",
            },
          ]
        : [],
    },
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing",
    deleted_at: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
  };
}

function finalization(
  status: JobTargetFinalizationDto["status"],
  result: Record<string, unknown> | null = null,
): JobTargetFinalizationDto {
  return {
    id: ids.command,
    job_id: ids.job,
    workspace_id: ids.workspace,
    target_kind: "design",
    target_id: ids.design,
    status,
    command_id: ids.command,
    result,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    completed_at: status === "completed" ? "2026-09-04T00:00:01.000Z" : null,
  };
}

function repository(): DesignFinalizationRepository {
  return {
    claim: vi.fn(async () => ({
      acquired: true,
      finalization: finalization("running"),
    })),
    finish: vi.fn(async (input) => ({
      ...finalization(input.status, input.result ?? null),
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
    })),
  };
}

describe("DesignJobFinalizer", () => {
  it.each([[0, 0], [99, 1], [undefined, 1]])("inserts requested layer %s at bounded index %s", async (layerIndex, expected) => {
    const mutations: DesignJobMutationPort = {
      get: vi.fn(async () => document(4, true)),
      mutate: vi.fn(async () => ({ design_id: ids.design, revision: 5, changed_object_ids: [ids.command], replayed: false })),
    };
    await new DesignJobFinalizer(repository(), mutations, { enqueue: vi.fn() })
      .finalize(job(layerIndex === undefined ? {} : { layerIndex }));
    expect(mutations.mutate).toHaveBeenCalledWith(expect.objectContaining({
      commands: [expect.objectContaining({ action: "object.add", object: expect.objectContaining({ zIndex: expected }) })],
    }));
  });
  it("rebases an additive result onto the latest revision", async () => {
    const repo = repository();
    const previews = { enqueue: vi.fn().mockResolvedValue({}) };
    const mutations: DesignJobMutationPort = {
      get: vi.fn(async () => document(4)),
      mutate: vi.fn(async () => ({
        design_id: ids.design,
        revision: 5,
        changed_object_ids: [ids.command],
        replayed: false,
      })),
    };

    const outcome = await new DesignJobFinalizer(
      repo,
      mutations,
      previews,
    ).finalize(job({ expectedRevision: 1 }));

    expect(mutations.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        idempotencyKey: ids.command,
      }),
    );
    expect(outcome).toMatchObject({
      inserted: true,
      finalization: {
        status: "completed",
        result: { preview_status: "queued", revision: 5 },
      },
    });
    expect(previews.enqueue).toHaveBeenCalledWith({
      designId: ids.design,
      expectedRevision: 5,
      idempotencyKey: ids.command,
      actorUserId: ids.user,
    });
  });

  it("completes finalization when derived preview enqueue fails", async () => {
    const repo = repository();
    const mutations: DesignJobMutationPort = {
      get: vi.fn(async () => document(1)),
      mutate: vi.fn(async () => ({
        design_id: ids.design,
        revision: 2,
        changed_object_ids: [ids.command],
        replayed: false,
      })),
    };
    const previews = {
      enqueue: vi.fn().mockRejectedValue(new Error("preview queue down")),
    };

    const outcome = await new DesignJobFinalizer(
      repo,
      mutations,
      previews,
    ).finalize(job());

    expect(outcome).toMatchObject({
      inserted: true,
      finalization: {
        status: "completed",
        result: { preview_status: "failed", revision: 2 },
      },
    });
    expect(mutations.mutate).toHaveBeenCalledTimes(1);
    expect(repo.finish).toHaveBeenCalledTimes(1);
  });

  it("retries a racing additive mutation without inserting twice", async () => {
    const repo = repository();
    const mutations: DesignJobMutationPort = {
      get: vi
        .fn()
        .mockResolvedValueOnce(document(2))
        .mockResolvedValueOnce(document(3)),
      mutate: vi
        .fn()
        .mockRejectedValueOnce(new DesignJobMutationConflict())
        .mockResolvedValueOnce({
          design_id: ids.design,
          revision: 4,
          changed_object_ids: [ids.command],
          replayed: false,
        }),
    };

    await new DesignJobFinalizer(repo, mutations).finalize(job());

    expect(mutations.mutate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repo.finish)).toHaveBeenCalledTimes(1);
  });

  it("returns an existing completed ledger row on finalizer retry", async () => {
    const completed = finalization("completed", { object_id: ids.command });
    const repo = repository();
    vi.mocked(repo.claim).mockResolvedValue({
      acquired: false,
      finalization: completed,
    });
    const mutations: DesignJobMutationPort = {
      get: vi.fn(),
      mutate: vi.fn(),
    };

    const outcome = await new DesignJobFinalizer(repo, mutations).finalize(
      job(),
    );

    expect(outcome).toEqual({ finalization: completed, inserted: false });
    expect(mutations.get).not.toHaveBeenCalled();
    expect(mutations.mutate).not.toHaveBeenCalled();
    expect(repo.finish).not.toHaveBeenCalled();
  });

  it("marks a replacement needs_attention when the design revision advanced", async () => {
    const repo = repository();
    const mutations: DesignJobMutationPort = {
      get: vi.fn(async () => document(3, true)),
      mutate: vi.fn(),
    };

    const outcome = await new DesignJobFinalizer(repo, mutations).finalize(
      job({ expectedRevision: 2, replaceObjectId: ids.existingObject }),
    );

    expect(outcome).toMatchObject({
      inserted: false,
      finalization: {
        status: "needs_attention",
        error_code: "design_revision_conflict",
      },
    });
    expect(mutations.mutate).not.toHaveBeenCalled();
  });

  it("applies split background and elements in one atomic mutation", async () => {
    const repo = repository();
    const splitJob = job({ replaceObjectId: ids.existingObject });
    splitJob.payload = {
      ...splitJob.payload,
      operation: "split_layers",
      target: {
        ...(splitJob.payload.target as Record<string, unknown>),
        source_object_id: ids.existingObject,
        expected_object_version: 2,
        source_asset_object_id: "90000000-0000-4000-8000-000000000001",
      },
    };
    splitJob.result = {
      asset_id: "70000000-0000-4000-8000-000000000002",
      width: 100,
      height: 100,
      mime_type: "image/png",
      source_width: 100,
      source_height: 100,
      layers: [
        {
          asset_id: "70000000-0000-4000-8000-000000000002",
          width: 100,
          height: 100,
          mime_type: "image/png",
          kind: "background",
          x: 0,
          y: 0,
        },
        {
          asset_id: "70000000-0000-4000-8000-000000000003",
          width: 40,
          height: 50,
          mime_type: "image/png",
          kind: "element",
          x: 10,
          y: 20,
          index: 0,
        },
      ],
    };
    const mutations: DesignJobMutationPort = {
      get: vi.fn(async () => document(1, true)),
      mutate: vi.fn(async (input) => ({
        design_id: ids.design,
        revision: 2,
        changed_object_ids: input.commands.flatMap((command: DesignCommand) =>
          command.action === "object.add" ? [command.object.objectId] : [],
        ),
        replayed: false,
      })),
    };
    const outcome = await new DesignJobFinalizer(repo, mutations).finalize(
      splitJob,
    );
    expect(mutations.mutate).toHaveBeenCalledTimes(1);
    expect(mutations.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        commands: [
          expect.objectContaining({
            action: "object.update",
            patch: expect.objectContaining({ resource_id: null }),
          }),
          expect.objectContaining({ action: "object.add" }),
        ],
      }),
    );
    expect(outcome).toMatchObject({
      inserted: true,
      finalization: {
        status: "completed",
        result: {
          revision: 2,
          asset_object_ids: [
            "70000000-0000-4000-8000-000000000002",
            "70000000-0000-4000-8000-000000000003",
          ],
        },
      },
    });
  });

  it("uses the fair service-side recovery candidate scan", async () => {
    const rpc = vi.fn(async () => ({ data: [job()], error: null }));
    const finalize = vi.fn(async () => ({
      inserted: true,
      finalization: finalization("completed"),
    }));

    await expect(
      reconcileSucceededDesignImageJobs(
        { rpc } as never,
        { finalize } as never,
        125,
      ),
    ).resolves.toEqual({ checked: 1, finalized: 1, failed: 0 });

    expect(rpc).toHaveBeenCalledWith("loomic_design_finalization_candidates", {
      p_limit: 125,
    });
    expect(finalize).toHaveBeenCalledWith(job());
  });
});
