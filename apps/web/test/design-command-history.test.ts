import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesignCommand,
  DesignMutationRequest,
  DesignMutationResponse,
} from "@loomic/shared";

import { DesignApiError } from "../src/lib/design-api";
import {
  DESIGN_AUTOSAVE_DEBOUNCE_MS,
  DesignCommandHistory,
} from "../src/lib/design-command-history";

const ids = {
  design: "10000000-0000-4000-8000-000000000001",
  object1: "20000000-0000-4000-8000-000000000001",
  object2: "20000000-0000-4000-8000-000000000002",
  request1: "30000000-0000-4000-8000-000000000001",
  request2: "30000000-0000-4000-8000-000000000002",
  request3: "30000000-0000-4000-8000-000000000003",
} as const;

describe("DesignCommandHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("undoes and redoes an unpersisted command without saving the canceled edit", () => {
    const applyLocal = vi.fn();
    const history = createHistory({ applyLocal });
    const edit = positionEdit(ids.object1, { x: 40 }, { x: 0 });

    history.record(edit);
    expect(history.getState()).toMatchObject({
      status: "debouncing",
      dirty: true,
      canUndo: true,
      queuedCommandCount: 1,
    });

    expect(history.undo()).toBe(true);
    expect(applyLocal).toHaveBeenLastCalledWith([edit.inverse], "undo");
    expect(history.getState()).toMatchObject({
      status: "clean",
      dirty: false,
      canRedo: true,
      queuedCommandCount: 0,
    });

    expect(history.redo()).toBe(true);
    expect(applyLocal).toHaveBeenLastCalledWith([edit.command], "redo");
    expect(history.getState()).toMatchObject({
      status: "debouncing",
      queuedCommandCount: 1,
    });
  });

  it("coalesces one transform gesture while retaining the complete original inverse", () => {
    const applyLocal = vi.fn();
    const history = createHistory({ applyLocal });

    history.record({
      ...positionEdit(ids.object1, { x: 40 }, { x: 0 }),
      mergeKey: "drag:object-1",
    });
    history.record({
      ...positionEdit(ids.object1, { y: 70 }, { y: 0 }),
      mergeKey: "drag:object-1",
    });

    const [batch] = history.getState().dirtyBatches;
    expect(batch?.commands).toEqual([
      updateCommand(ids.object1, 1, { x: 40, y: 70 }),
    ]);
    history.undo();
    expect(applyLocal).toHaveBeenLastCalledWith(
      [updateCommand(ids.object1, 2, { x: 0, y: 0 })],
      "undo",
    );
  });

  it("records a multi-object gesture as one history entry and persists its command list", async () => {
    const mutate = vi.fn(async (_request: DesignMutationRequest) =>
      mutationResponse(5),
    );
    const applyLocal = vi.fn();
    const history = createHistory({ mutate, applyLocal });
    const first = positionEdit(ids.object1, { x: 40 }, { x: 0 });
    const second = positionEdit(ids.object2, { y: 70 }, { y: 0 });

    history.recordBatch([first, second]);
    expect(history.getState()).toMatchObject({
      canUndo: true,
      queuedCommandCount: 2,
    });
    await history.flushNow();
    expect(mutate.mock.calls[0]?.[0].commands).toEqual([
      first.command,
      second.command,
    ]);

    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(false);
    expect(applyLocal).toHaveBeenLastCalledWith(
      [second.inverse, first.inverse],
      "undo",
    );
  });

  it("persists a new object before rapid edits to that object", async () => {
    const mutate = vi
      .fn<(request: DesignMutationRequest) => Promise<DesignMutationResponse>>()
      .mockResolvedValueOnce(mutationResponse(5))
      .mockResolvedValueOnce(mutationResponse(6));
    const history = createHistory({ mutate });
    const addition = addRectEdit(ids.object1);
    const update = positionEdit(ids.object1, { x: 40 }, { x: 0 });

    history.record(addition);
    history.record(update);
    await history.flushNow();
    await settlePromises();

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      expected_revision: 4,
      commands: [addition.command],
    });
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      expected_revision: 5,
      commands: [update.command],
    });
  });

  it("persists successive property gestures in separate revisions", async () => {
    const mutate = vi
      .fn<(request: DesignMutationRequest) => Promise<DesignMutationResponse>>()
      .mockResolvedValueOnce(mutationResponse(5))
      .mockResolvedValueOnce(mutationResponse(6));
    const history = createHistory({ mutate });
    const position = positionEdit(ids.object1, { x: 40 }, { x: 0 });
    const vertical = {
      command: updateCommand(ids.object1, 2, { y: 70 }),
      inverse: updateCommand(ids.object1, 3, { y: 0 }),
    };

    history.record(position);
    history.record(vertical);
    await history.flushNow();
    await settlePromises();

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      expected_revision: 4,
      commands: [position.command],
    });
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      expected_revision: 5,
      commands: [vertical.command],
    });
  });

  it("waits for the 1000ms trailing debounce before saving", async () => {
    const mutate = vi.fn(async () => mutationResponse(5));
    const history = createHistory({ mutate });
    history.record(positionEdit(ids.object1, { x: 40 }, { x: 0 }));

    expect(history.getState().nextSaveAt).toBe(
      1_000 + DESIGN_AUTOSAVE_DEBOUNCE_MS,
    );
    await vi.advanceTimersByTimeAsync(DESIGN_AUTOSAVE_DEBOUNCE_MS - 1);
    expect(mutate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settlePromises();

    expect(mutate).toHaveBeenCalledOnce();
    expect(history.getState()).toMatchObject({
      status: "clean",
      dirty: false,
      authoritativeRevision: 5,
    });
  });

  it("allows only one save and moves edits made in flight into the next batch", async () => {
    const first = deferred<DesignMutationResponse>();
    const second = deferred<DesignMutationResponse>();
    const mutate = vi
      .fn<(request: DesignMutationRequest) => Promise<DesignMutationResponse>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const history = createHistory({ mutate });

    history.record(positionEdit(ids.object1, { x: 10 }, { x: 0 }));
    const firstFlush = history.flushNow();
    await settlePromises();
    expect(mutate).toHaveBeenCalledOnce();
    expect(history.getState().status).toBe("saving");

    history.record(positionEdit(ids.object2, { x: 20 }, { x: 0 }));
    await vi.advanceTimersByTimeAsync(DESIGN_AUTOSAVE_DEBOUNCE_MS);
    expect(mutate).toHaveBeenCalledOnce();

    first.resolve(mutationResponse(6));
    await firstFlush;
    await settlePromises();
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      expected_revision: 6,
      commands: [updateCommand(ids.object2, 1, { x: 20 })],
    });

    second.resolve(mutationResponse(7));
    await settlePromises();
    expect(history.getState()).toMatchObject({
      status: "clean",
      authoritativeRevision: 7,
      inFlightCommandCount: 0,
    });
  });

  it("freezes a failed batch for exact idempotent retry and retains later edits", async () => {
    const mutate = vi
      .fn<(request: DesignMutationRequest) => Promise<DesignMutationResponse>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(mutationResponse(5))
      .mockResolvedValueOnce(mutationResponse(6));
    const history = createHistory({ mutate });
    history.record(positionEdit(ids.object1, { x: 10 }, { x: 0 }));

    await history.flushNow();
    const frozenRequest = mutate.mock.calls[0]?.[0];
    expect(history.getState()).toMatchObject({
      status: "error",
      dirty: true,
      error: "offline",
    });

    history.record(positionEdit(ids.object2, { y: 20 }, { y: 0 }));
    expect(history.getState().dirtyBatches.map((batch) => batch.kind)).toEqual([
      "failed",
      "queued",
    ]);
    await history.retry();
    expect(mutate.mock.calls[1]?.[0]).toEqual(frozenRequest);
    expect(history.getState()).toMatchObject({
      status: "debouncing",
      authoritativeRevision: 5,
      queuedCommandCount: 1,
    });

    await history.flushNow();
    expect(mutate.mock.calls[2]?.[0]).toMatchObject({ expected_revision: 5 });
    expect(history.getState().authoritativeRevision).toBe(6);
  });

  it("pauses on 409, preserves commands, and supports authoritative discard", async () => {
    const conflict = new DesignApiError("DESIGN_CONFLICT", "changed", 409, {
      designId: ids.design,
      latestRevision: 9,
      conflictObjectIds: [ids.object1],
      retryable: false,
    });
    const mutate = vi.fn().mockRejectedValue(conflict);
    const history = createHistory({ mutate });
    history.record(positionEdit(ids.object1, { x: 10 }, { x: 0 }));

    await history.flushNow();
    expect(history.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      authoritativeRevision: 9,
      conflictRevision: 9,
      canUndo: true,
    });
    const firstRequest = mutate.mock.calls[0]?.[0];
    await history.retry();
    expect(mutate.mock.calls[1]?.[0]).toEqual(firstRequest);

    history.reloadDiscard(9);
    expect(history.getState()).toMatchObject({
      status: "clean",
      dirty: false,
      canUndo: false,
      canRedo: false,
      authoritativeRevision: 9,
    });
  });

  it("can preserve and rebase a conflicted batch after reload", async () => {
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(
        new DesignApiError("DESIGN_CONFLICT", "changed", 409, {
          designId: ids.design,
          latestRevision: 8,
          conflictObjectIds: [ids.object1],
          retryable: false,
        }),
      )
      .mockResolvedValueOnce(mutationResponse(9));
    const history = createHistory({ mutate });
    history.record(positionEdit(ids.object1, { x: 10 }, { x: 0 }));
    await history.flushNow();

    history.resumeAfterReload(8, (command) =>
      command.action === "object.update"
        ? { ...command, expected_object_version: 4 }
        : command,
    );
    expect(history.getState()).toMatchObject({
      status: "debouncing",
      dirty: true,
      authoritativeRevision: 8,
    });
    await history.flushNow();
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      expected_revision: 8,
      idempotency_key: ids.request2,
      commands: [{ expected_object_version: 4 }],
    });
  });

  it("persists undo as an inverse command after the forward command was saved", async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(mutationResponse(5))
      .mockResolvedValueOnce(mutationResponse(6));
    const applyLocal = vi.fn();
    const history = createHistory({ mutate, applyLocal });
    const edit = positionEdit(ids.object1, { x: 40 }, { x: 0 });
    history.record(edit);
    await history.flushNow();

    expect(history.undo()).toBe(true);
    expect(applyLocal).toHaveBeenLastCalledWith([edit.inverse], "undo");
    expect(history.getState()).toMatchObject({ dirty: true, canRedo: true });
    await history.flushNow();

    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      expected_revision: 5,
      commands: [edit.inverse],
    });
    expect(history.getState()).toMatchObject({
      status: "clean",
      authoritativeRevision: 6,
      canRedo: true,
    });
  });

  it("starts a new history branch after undo and drops the abandoned redo", () => {
    const history = createHistory();
    history.record(positionEdit(ids.object1, { x: 40 }, { x: 0 }));
    expect(history.undo()).toBe(true);
    expect(history.getState().canRedo).toBe(true);

    history.record(positionEdit(ids.object2, { y: 25 }, { y: 0 }));

    expect(history.getState()).toMatchObject({
      canUndo: true,
      canRedo: false,
      queuedCommandCount: 1,
    });
    expect(history.redo()).toBe(false);
  });

  it("clears pending timers on destroy and rejects later operations", async () => {
    const mutate = vi.fn(async () => mutationResponse(5));
    const history = createHistory({ mutate });
    history.record(positionEdit(ids.object1, { x: 40 }, { x: 0 }));
    history.destroy();

    await vi.runAllTimersAsync();
    expect(mutate).not.toHaveBeenCalled();
    expect(history.getState().status).toBe("destroyed");
    expect(() =>
      history.record(positionEdit(ids.object2, { x: 20 }, { x: 0 })),
    ).toThrow("destroyed");
  });

  it("rejects commands outside the shared strict command schema", () => {
    const history = createHistory();
    expect(() =>
      history.record({
        command: {
          ...updateCommand(ids.object1, 1, { x: 10 }),
          unexpected: true,
        } as unknown as DesignCommand,
        inverse: updateCommand(ids.object1, 2, { x: 0 }),
      }),
    ).toThrow();
  });
});

function createHistory(
  overrides: Partial<{
    mutate: (request: DesignMutationRequest) => Promise<DesignMutationResponse>;
    applyLocal: (
      commands: readonly DesignCommand[],
      source: "undo" | "redo",
    ) => void;
  }> = {},
) {
  const generatedIds = [ids.request1, ids.request2, ids.request3];
  return new DesignCommandHistory({
    designId: ids.design,
    initialRevision: 4,
    mutate: overrides.mutate ?? (async () => mutationResponse(5)),
    applyLocal: overrides.applyLocal ?? vi.fn(),
    createId: () => generatedIds.shift() ?? ids.request3,
  });
}

function positionEdit(
  objectId: string,
  patch: { x?: number; y?: number },
  inversePatch: { x?: number; y?: number },
) {
  return {
    command: updateCommand(objectId, 1, patch),
    inverse: updateCommand(objectId, 2, inversePatch),
  };
}

function addRectEdit(objectId: string) {
  const command: DesignCommand = {
    action: "object.add",
    object: {
      objectId,
      objectVersion: 1,
      type: "rect",
      name: "new rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
      fill: { kind: "solid", color: "#ffffff" },
      stroke: { kind: "solid", color: "#000000" },
      strokeWidth: 1,
      radiusX: 0,
      radiusY: 0,
    },
  };
  const inverse: DesignCommand = {
    action: "object.remove",
    object_id: objectId,
    expected_object_version: 1,
  };
  return { command, inverse };
}

function updateCommand(
  objectId: string,
  expectedObjectVersion: number,
  patch: { x?: number; y?: number },
): DesignCommand {
  return {
    action: "object.update",
    object_id: objectId,
    expected_object_version: expectedObjectVersion,
    patch: { object_type: "rect", ...patch },
  };
}

function mutationResponse(revision: number): DesignMutationResponse {
  return {
    design_id: ids.design,
    revision,
    changed_object_ids: [],
    replayed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
