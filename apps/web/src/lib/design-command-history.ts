import {
  type DesignCommand,
  type DesignMutationRequest,
  type DesignMutationResponse,
  designCommandSchema,
  designMutationRequestSchema,
  designMutationResponseSchema,
  designUuidSchema,
} from "@loomic/shared";

import { DesignApiError } from "./design-api";

export const DESIGN_AUTOSAVE_DEBOUNCE_MS = 1_000;
const MAX_COMMANDS_PER_BATCH = 500;

export type DesignHistoryEdit = {
  command: DesignCommand;
  inverse: DesignCommand;
  /** Repeated changes from one pointer gesture/property edit share this key. */
  mergeKey?: string;
};

export type DesignHistoryApplySource = "undo" | "redo";
export type DesignHistoryBatchKind = "failed" | "in_flight" | "queued";
export type DesignCommandHistoryStatus =
  | "clean"
  | "dirty"
  | "debouncing"
  | "saving"
  | "error"
  | "conflict"
  | "destroyed";

export type DesignHistoryDirtyBatch = {
  kind: DesignHistoryBatchKind;
  commands: readonly DesignCommand[];
  expectedRevision: number | null;
  idempotencyKey: string | null;
};

export type DesignCommandHistoryState = {
  status: DesignCommandHistoryStatus;
  authoritativeRevision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  queuedCommandCount: number;
  inFlightCommandCount: number;
  nextSaveAt: number | null;
  conflictRevision: number | null;
  error: string | null;
  dirtyBatches: readonly DesignHistoryDirtyBatch[];
};

export type PersistedCommandContext = {
  direction: "forward" | "inverse";
  authoritativeRevision: number;
  entryId: number;
};

export type DesignCommandHistoryOptions = {
  designId: string;
  initialRevision: number;
  mutate: (request: DesignMutationRequest) => Promise<DesignMutationResponse>;
  applyLocal: (
    commands: readonly DesignCommand[],
    source: DesignHistoryApplySource,
  ) => void;
  createId?: () => string;
  debounceMs?: number;
  now?: () => number;
  /** Lets an adapter refresh object-version CAS fields at a persisted boundary. */
  preparePersistedCommand?: (
    command: DesignCommand,
    context: PersistedCommandContext,
  ) => DesignCommand;
};

type HistoryDirection = "forward" | "inverse";

type HistoryEntry = {
  id: number;
  forward: DesignCommand[];
  inverse: DesignCommand[];
  mergeKey: string | null;
  persistedApplied: boolean;
  hasPersistedTransition: boolean;
};

type PendingOperation = {
  entry: HistoryEntry;
  direction: HistoryDirection;
  commands: DesignCommand[];
};

type FrozenBatch = {
  request: DesignMutationRequest;
  operations: PendingOperation[];
};

type FailureKind = "error" | "conflict";
type StateListener = (state: DesignCommandHistoryState) => void;

/**
 * Pure command/history coordinator. The rendering adapter owns the scene and
 * records already-applied edits; this class owns undo/redo intent and the
 * serialized persistence pipeline.
 */
export class DesignCommandHistory {
  private readonly designId: string;
  private readonly mutate: DesignCommandHistoryOptions["mutate"];
  private readonly applyLocal: DesignCommandHistoryOptions["applyLocal"];
  private readonly createId: () => string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly preparePersistedCommand?: DesignCommandHistoryOptions["preparePersistedCommand"];
  private readonly listeners = new Set<StateListener>();
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private pending: PendingOperation[] = [];
  private inFlight: FrozenBatch | null = null;
  private failed: FrozenBatch | null = null;
  private failureKind: FailureKind | null = null;
  private activeSave: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextSaveAt: number | null = null;
  private nextBatchReady = false;
  private revision: number;
  private nextEntryId = 1;
  private error: string | null = null;
  private conflictRevision: number | null = null;
  private destroyed = false;

  constructor(options: DesignCommandHistoryOptions) {
    this.designId = designUuidSchema.parse(options.designId);
    this.revision = parseRevision(options.initialRevision);
    this.mutate = options.mutate;
    this.applyLocal = options.applyLocal;
    this.createId = options.createId ?? createUuid;
    this.debounceMs = options.debounceMs ?? DESIGN_AUTOSAVE_DEBOUNCE_MS;
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RangeError("debounceMs must be a non-negative finite number.");
    }
    this.now = options.now ?? Date.now;
    this.preparePersistedCommand = options.preparePersistedCommand;
  }

  getState(): DesignCommandHistoryState {
    const dirtyBatches: DesignHistoryDirtyBatch[] = [];
    if (this.failed) dirtyBatches.push(batchSnapshot("failed", this.failed));
    if (this.inFlight)
      dirtyBatches.push(batchSnapshot("in_flight", this.inFlight));
    dirtyBatches.push(...queuedBatchSnapshots(this.pending));
    return {
      status: this.status(),
      authoritativeRevision: this.revision,
      dirty: dirtyBatches.length > 0,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      queuedCommandCount: commandCount(this.pending),
      inFlightCommandCount: commandCount(this.inFlight?.operations ?? []),
      nextSaveAt: this.nextSaveAt,
      conflictRevision: this.conflictRevision,
      error: this.error,
      dirtyBatches,
    };
  }

  subscribe(listener: StateListener): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(edit: DesignHistoryEdit): void {
    this.recordBatch([edit]);
  }

  /** Records one atomic user gesture while preserving its command list. */
  recordBatch(edits: readonly DesignHistoryEdit[]): void {
    this.assertActive();
    if (edits.length === 0) return;
    if (edits.length > MAX_COMMANDS_PER_BATCH) {
      throw new RangeError(
        `A history entry cannot exceed ${MAX_COMMANDS_PER_BATCH} commands.`,
      );
    }
    const parsed = edits.map(parseEdit);
    const next = parsed[0];
    if (!next) return;
    const previous = this.undoStack.at(-1);
    if (
      parsed.length === 1 &&
      previous &&
      canCoalesce(previous, next, this.pending, this.inFlight, this.failed)
    ) {
      const merged = mergeEdits(previous, next);
      previous.forward = [merged.command];
      previous.inverse = [merged.inverse];
      const queued = this.pending.find(
        (operation) =>
          operation.entry === previous && operation.direction === "forward",
      );
      if (queued) queued.commands = [merged.command];
    } else {
      const entry: HistoryEntry = {
        id: this.nextEntryId++,
        forward: parsed.map((item) => item.command),
        inverse: parsed.map((item) => item.inverse).reverse(),
        mergeKey: parsed.length === 1 && next.mergeKey ? next.mergeKey : null,
        persistedApplied: false,
        hasPersistedTransition: false,
      };
      this.undoStack.push(entry);
      this.pending.push({
        entry,
        direction: "forward",
        commands: entry.forward,
      });
    }
    this.redoStack.length = 0;
    if (!this.failed) {
      this.error = null;
      this.conflictRevision = null;
    }
    this.scheduleAutosave();
    this.emit();
  }

  undo(): boolean {
    this.assertActive();
    const entry = this.undoStack.at(-1);
    if (!entry) return false;
    const commands = this.commandsForHistory(entry, "inverse");
    this.applyLocal(commands, "undo");
    this.undoStack.pop();
    this.redoStack.push(entry);
    if (!this.cancelQueued(entry, "forward")) {
      this.pending.push({ entry, direction: "inverse", commands });
    }
    this.scheduleIfDirty();
    this.emit();
    return true;
  }

  redo(): boolean {
    this.assertActive();
    const entry = this.redoStack.at(-1);
    if (!entry) return false;
    const commands = this.commandsForHistory(entry, "forward");
    this.applyLocal(commands, "redo");
    this.redoStack.pop();
    this.undoStack.push(entry);
    if (!this.cancelQueued(entry, "inverse")) {
      this.pending.push({ entry, direction: "forward", commands });
    }
    this.scheduleIfDirty();
    this.emit();
    return true;
  }

  async flushNow(): Promise<void> {
    this.assertActive();
    this.clearTimer();
    this.nextBatchReady = true;
    const running = this.activeSave ?? this.pump();
    this.emit();
    await running;
  }

  /** Retries the exact frozen request, including its idempotency key. */
  async retry(): Promise<void> {
    this.assertActive();
    if (!this.failed) {
      await this.flushNow();
      return;
    }
    if (this.activeSave) {
      await this.activeSave;
      return;
    }
    const batch = this.failed;
    this.failed = null;
    this.failureKind = null;
    this.error = null;
    this.conflictRevision = null;
    await this.runBatch(batch);
  }

  /**
   * Called after an authoritative reload when the user chooses to keep local
   * edits. A supplied rebaser must refresh stale object-version CAS fields.
   */
  resumeAfterReload(
    revision: number,
    rebase?: (command: DesignCommand) => DesignCommand,
  ): void {
    this.assertActive();
    if (this.inFlight)
      throw new Error("Cannot resume while a save is in flight.");
    this.revision = Math.max(this.revision, parseRevision(revision));
    const recovered = [...(this.failed?.operations ?? []), ...this.pending];
    this.pending = recovered.map((operation) => {
      const commands = operation.commands.map((command) =>
        designCommandSchema.parse(rebase ? rebase(command) : command),
      );
      setEntryCommands(operation.entry, operation.direction, commands);
      return { ...operation, commands };
    });
    this.failed = null;
    this.failureKind = null;
    this.error = null;
    this.conflictRevision = null;
    this.scheduleIfDirty();
    this.emit();
  }

  /** Called after reloading the server document and choosing to drop locals. */
  reloadDiscard(revision: number): void {
    this.assertActive();
    if (this.inFlight)
      throw new Error("Cannot discard while a save is in flight.");
    this.clearTimer();
    this.revision = Math.max(this.revision, parseRevision(revision));
    this.pending = [];
    this.failed = null;
    this.failureKind = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.error = null;
    this.conflictRevision = null;
    this.nextBatchReady = false;
    this.emit();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimer();
    this.listeners.clear();
  }

  private commandsForHistory(
    entry: HistoryEntry,
    direction: HistoryDirection,
  ): DesignCommand[] {
    const base = direction === "forward" ? entry.forward : entry.inverse;
    const crossesPersistedBoundary =
      entry.hasPersistedTransition &&
      ((direction === "inverse" && entry.persistedApplied) ||
        (direction === "forward" && !entry.persistedApplied));
    if (!crossesPersistedBoundary || !this.preparePersistedCommand) return base;
    return base.map((command) =>
      designCommandSchema.parse(
        this.preparePersistedCommand?.(command, {
          direction,
          authoritativeRevision: this.revision,
          entryId: entry.id,
        }),
      ),
    );
  }

  private cancelQueued(
    entry: HistoryEntry,
    direction: HistoryDirection,
  ): boolean {
    const index = this.pending.findIndex(
      (operation) =>
        operation.entry === entry && operation.direction === direction,
    );
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  private scheduleIfDirty(): void {
    if (this.pending.length > 0) this.scheduleAutosave();
    else {
      this.clearTimer();
      this.nextBatchReady = false;
    }
  }

  private scheduleAutosave(): void {
    if (this.failed) return;
    this.clearTimer();
    this.nextBatchReady = false;
    this.nextSaveAt = this.now() + this.debounceMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextSaveAt = null;
      this.nextBatchReady = true;
      this.emit();
      void this.pump();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextSaveAt = null;
  }

  private pump(): Promise<void> {
    if (
      this.destroyed ||
      this.activeSave ||
      this.failed ||
      !this.nextBatchReady ||
      this.pending.length === 0
    ) {
      return this.activeSave ?? Promise.resolve();
    }
    const operations = takePendingBatch(this.pending);
    this.nextBatchReady = this.pending.length > 0;
    const request = designMutationRequestSchema.parse({
      design_id: this.designId,
      expected_revision: this.revision,
      idempotency_key: designUuidSchema.parse(this.createId()),
      commands: operations.flatMap((operation) => operation.commands),
    });
    return this.runBatch({ request, operations });
  }

  private runBatch(batch: FrozenBatch): Promise<void> {
    this.inFlight = batch;
    this.emit();
    const active = this.mutate(batch.request).then(
      (rawResponse) => this.completeBatch(batch, rawResponse),
      (error: unknown) => this.failBatch(batch, error),
    );
    const tracked = active.finally(() => {
      if (this.activeSave === tracked) this.activeSave = null;
      if (
        !this.destroyed &&
        !this.failed &&
        !this.inFlight &&
        this.nextBatchReady
      ) {
        void this.pump();
      }
    });
    this.activeSave = tracked;
    return tracked;
  }

  private completeBatch(
    batch: FrozenBatch,
    rawResponse: DesignMutationResponse,
  ): void {
    if (this.destroyed || this.inFlight !== batch) return;
    try {
      const response = designMutationResponseSchema.parse(rawResponse);
      if (response.design_id !== this.designId) {
        throw new Error("Mutation response belongs to another design.");
      }
      this.revision = Math.max(this.revision, response.revision);
      for (const operation of batch.operations) {
        operation.entry.persistedApplied = operation.direction === "forward";
        operation.entry.hasPersistedTransition = true;
      }
      this.inFlight = null;
      this.error = null;
      this.conflictRevision = null;
      if (this.pending.length > 0 && !this.nextBatchReady && !this.timer) {
        this.scheduleAutosave();
      }
      this.emit();
    } catch (error) {
      this.failBatch(batch, error);
    }
  }

  private failBatch(batch: FrozenBatch, error: unknown): void {
    if (this.destroyed || this.inFlight !== batch) return;
    this.inFlight = null;
    this.failed = batch;
    this.clearTimer();
    if (isDesignConflict(error, this.designId)) {
      this.failureKind = "conflict";
      this.conflictRevision = error.conflict?.latestRevision ?? this.revision;
      this.revision = Math.max(this.revision, this.conflictRevision);
    } else {
      this.failureKind = "error";
      this.conflictRevision = null;
    }
    this.error = errorMessage(error);
    this.emit();
  }

  private status(): DesignCommandHistoryStatus {
    if (this.destroyed) return "destroyed";
    if (this.inFlight) return "saving";
    if (this.failureKind) return this.failureKind;
    if (this.pending.length === 0) return "clean";
    return this.timer ? "debouncing" : "dirty";
  }

  private emit(): void {
    if (this.destroyed) return;
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error("Design command history is destroyed.");
  }
}

function parseEdit(edit: DesignHistoryEdit): DesignHistoryEdit {
  return {
    command: designCommandSchema.parse(edit.command),
    inverse: designCommandSchema.parse(edit.inverse),
    ...(edit.mergeKey === undefined ? {} : { mergeKey: edit.mergeKey }),
  };
}

function canCoalesce(
  previous: HistoryEntry,
  next: DesignHistoryEdit,
  pending: readonly PendingOperation[],
  inFlight: FrozenBatch | null,
  failed: FrozenBatch | null,
): boolean {
  if (!next.mergeKey || previous.mergeKey !== next.mergeKey) return false;
  if (inFlight?.operations.some((operation) => operation.entry === previous))
    return false;
  if (failed?.operations.some((operation) => operation.entry === previous))
    return false;
  if (
    !pending.some(
      (operation) =>
        operation.entry === previous && operation.direction === "forward",
    )
  ) {
    return false;
  }
  const previousForward = previous.forward[0];
  const previousInverse = previous.inverse[0];
  if (!previousForward || !previousInverse) return false;
  const forwardSubject = mergeSubject(previousForward);
  const inverseSubject = mergeSubject(previousInverse);
  return (
    forwardSubject !== null &&
    inverseSubject !== null &&
    forwardSubject === mergeSubject(next.command) &&
    inverseSubject === mergeSubject(next.inverse)
  );
}

function mergeEdits(
  previous: HistoryEntry,
  next: DesignHistoryEdit,
): { command: DesignCommand; inverse: DesignCommand } {
  const previousForward = previous.forward[0];
  const previousInverse = previous.inverse[0];
  if (!previousForward || !previousInverse) {
    return { command: next.command, inverse: next.inverse };
  }
  if (
    previousForward.action === "object.update" &&
    next.command.action === "object.update" &&
    previousInverse.action === "object.update" &&
    next.inverse.action === "object.update"
  ) {
    return {
      command: designCommandSchema.parse({
        ...previousForward,
        patch: { ...previousForward.patch, ...next.command.patch },
      }),
      inverse: designCommandSchema.parse({
        ...previousInverse,
        patch: { ...next.inverse.patch, ...previousInverse.patch },
      }),
    };
  }
  if (
    previousForward.action === "canvas.update" &&
    next.command.action === "canvas.update" &&
    previousInverse.action === "canvas.update" &&
    next.inverse.action === "canvas.update"
  ) {
    return {
      command: designCommandSchema.parse({
        ...previousForward,
        ...next.command,
      }),
      inverse: designCommandSchema.parse({
        ...next.inverse,
        ...previousInverse,
      }),
    };
  }
  return { command: next.command, inverse: previousInverse };
}

function mergeSubject(command: DesignCommand): string | null {
  if (command.action === "object.update") {
    return `${command.action}:${command.object_id}:${command.expected_object_version}:${command.patch.object_type}`;
  }
  return command.action === "canvas.update" ? command.action : null;
}

function setEntryCommands(
  entry: HistoryEntry,
  direction: HistoryDirection,
  commands: DesignCommand[],
): void {
  if (direction === "forward") entry.forward = commands;
  else entry.inverse = commands;
}

function batchSnapshot(
  kind: "failed" | "in_flight",
  batch: FrozenBatch,
): DesignHistoryDirtyBatch {
  return {
    kind,
    commands: batch.request.commands,
    expectedRevision: batch.request.expected_revision,
    idempotencyKey: batch.request.idempotency_key,
  };
}

function commandCount(operations: readonly PendingOperation[]): number {
  return operations.reduce(
    (total, operation) => total + operation.commands.length,
    0,
  );
}

function takePendingBatch(pending: PendingOperation[]): PendingOperation[] {
  // One pending operation is one atomic user gesture. The mutation RPC checks
  // every command against both the authoritative input scene and the final
  // next scene, so combining successive gestures that touch the same object
  // (add → edit, or font size → color) makes the earlier command differ from
  // that final object. Keep recordBatch() gestures atomic, while serializing
  // separate gestures across revision boundaries.
  const next = pending.shift();
  return next ? [next] : [];
}

function queuedBatchSnapshots(
  pending: readonly PendingOperation[],
): DesignHistoryDirtyBatch[] {
  const batches: DesignHistoryDirtyBatch[] = [];
  let commands: DesignCommand[] = [];
  for (const operation of pending) {
    if (
      commands.length > 0 &&
      commands.length + operation.commands.length > MAX_COMMANDS_PER_BATCH
    ) {
      batches.push({
        kind: "queued",
        commands,
        expectedRevision: null,
        idempotencyKey: null,
      });
      commands = [];
    }
    commands.push(...operation.commands);
  }
  if (commands.length > 0) {
    batches.push({
      kind: "queued",
      commands,
      expectedRevision: null,
      idempotencyKey: null,
    });
  }
  return batches;
}

function isDesignConflict(
  error: unknown,
  designId: string,
): error is DesignApiError {
  return (
    error instanceof DesignApiError &&
    error.code === "DESIGN_CONFLICT" &&
    error.conflict?.designId === designId
  );
}

function parseRevision(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("revision must be a non-negative integer.");
  }
  return value;
}

function createUuid(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure UUID generation is unavailable.");
  }
  return globalThis.crypto.randomUUID();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Design save failed.";
}
