import { createHash, randomUUID } from "node:crypto";

import type { CanvasContent } from "@loomic/shared";
import type {
  DurableActionConfirmation,
  DurableActionConfirmationStore,
} from "./durable-action-confirmation-store.js";

type CanvasElement = Record<string, unknown> & { id: string };
export type FrozenCanvasOperation = Record<string, unknown> & {
  action: string;
  element_id?: string;
};

export type DestructiveTarget = {
  elementId: string;
  type: string;
  label: string;
  version: number;
  versionNonce: number | null;
  /**
   * The version-independent content shape this element had when the proposal was
   * created. It travels with the target — through the proposal, the frozen `execute`
   * closure and the CAS writer — so every gate compares against the same snapshot
   * without a side table that a caller could fail to populate.
   */
  contentShape: Record<string, unknown>;
  cascade: Array<{
    elementId: string;
    type: string;
    version: number;
    versionNonce: number | null;
    /** Content shape of the cascaded element at proposal time. */
    contentShape: Record<string, unknown>;
  }>;
};

export type DestructiveProposal = {
  confirmationId: string;
  canvasId: string;
  operationsDigest: string;
  targets: DestructiveTarget[];
  expiresAt: string;
};

export type ConfirmableActionKind =
  | "image_generation"
  | "design_mutation"
  | "design_template_apply";

export type ActionConfirmationProposal = {
  confirmationId: string;
  canvasId: string;
  kind: ConfirmableActionKind;
  details: Record<string, unknown>;
  expiresAt: string;
};

export type ConfirmedActionAppliedEvent = {
  confirmationId: string;
  taskId: string;
  taskRevision: number;
  originRunId: string;
  toolExecutionId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  workflowStepId: string | null;
  kind: "design_mutation";
  details: Record<string, unknown>;
  outcome: Record<string, unknown>;
};

type StoredActionProposal = ActionConfirmationProposal & {
  userId: string;
  originRunId?: string;
  execute: () => Promise<unknown>;
  validate?: () => Promise<void>;
  onApplied?: (result: unknown) => Promise<void>;
  execution?: Promise<unknown>;
  completion?: Promise<void>;
  completionDone?: boolean;
  status: "pending" | "executing" | "applied" | "canceled";
  result?: unknown;
};

type StoredProposal = DestructiveProposal & {
  userId: string;
  operations: FrozenCanvasOperation[];
  loadCanvas: () => Promise<CanvasContent>;
  execute: (
    operations: FrozenCanvasOperation[],
    targets: DestructiveTarget[],
  ) => Promise<unknown>;
  status: "pending" | "executing" | "applied" | "canceled";
  result?: unknown;
};

export class DestructiveConfirmationError extends Error {
  constructor(
    readonly code:
      | "confirmation_not_found"
      | "confirmation_forbidden"
      | "confirmation_expired"
      | "confirmation_consumed"
      | "confirmation_requires_new_turn"
      | "confirmation_stale",
    message: string,
  ) {
    super(message);
    this.name = "DestructiveConfirmationError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function digestOperations(operations: FrozenCanvasOperation[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(operations)))
    .digest("hex");
}

function versionOf(element: Record<string, unknown>): number {
  return typeof element.version === "number" ? element.version : 0;
}

function nonceOf(element: Record<string, unknown>): number | null {
  return typeof element.versionNonce === "number" ? element.versionNonce : null;
}

function labelOf(element: Record<string, unknown>): string {
  const customData = element.customData as Record<string, unknown> | undefined;
  const candidate =
    customData?.title ?? element.text ?? element.type ?? element.id;
  return typeof candidate === "string"
    ? candidate.slice(0, 120)
    : "canvas element";
}

function activeElements(content: CanvasContent): CanvasElement[] {
  return ((content.elements ?? []) as Record<string, unknown>[]).filter(
    (element): element is CanvasElement =>
      typeof element.id === "string" && !element.isDeleted,
  );
}

/**
 * Fields that decide which object a delete confirmation is about and what it would
 * remove: identity, geometry, appearance, text, bindings and grouping.
 *
 * Deliberately excludes `version`, `versionNonce`, `updated`, `index` and `seed`: those
 * move whenever any writer (the browser's canvas session, an autosave, Excalidraw's
 * restore) re-serializes an element, without the object becoming a different object.
 * Measured on a real browser click (artifacts/delete-confirmation-browser, 2026-09-20):
 * the canvas write that lands while a card is pending moved `version` 1 -> 2,
 * `versionNonce` 1 -> 2106926071, `updated`, added `index: "a0"` and normalized
 * `boundElements: null` -> `[]` — every one of the fields below stayed byte-identical.
 * None of the excluded fields can change which element is deleted or what it contains,
 * so accepting a difference in them cannot delete an object the user did not see.
 */
const TARGET_FINGERPRINT_FIELDS = [
  "type",
  "fileId",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "scale",
  "crop",
  "isDeleted",
  "locked",
  "opacity",
  "groupIds",
  "boundElements",
  "customData",
  "text",
  "containerId",
  "frameId",
  "link",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "roundness",
] as const;

/**
 * Re-serialization also flips empty collections between `null`/absent and `[]`, which is
 * the same object state (observed: a seeded image's `boundElements` read back as `[]`
 * while the proposal snapshot held `null`). Normalize before comparing so shape churn
 * cannot masquerade as a content change.
 */
function normalizeFingerprintValue(field: string, value: unknown): unknown {
  if (field === "boundElements" || field === "groupIds") {
    return Array.isArray(value) ? value : [];
  }
  return value ?? null;
}

/** Stable fingerprint of a canonical, version-independent element shape. */
function fingerprintOfShape(shape: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(shape)))
    .digest("hex");
}

/** The canonical, version-independent shape of one element. */
function fingerprintShape(element: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const field of TARGET_FINGERPRINT_FIELDS) {
    shape[field] = normalizeFingerprintValue(field, element[field]);
  }
  return shape;
}

/**
 * What counts as "the target changed", and why the accepted differences are safe.
 *
 * A confirmation authorizes deleting exactly the objects the user saw. Each target
 * therefore carries the version-independent content shape of every element the delete
 * would remove: the named element, plus every bound-text element the delete cascades
 * into. A click is STALE — fail closed — when any of those elements is no longer an
 * active element of the canvas, or when any field of `TARGET_FINGERPRINT_FIELDS`
 * differs from the snapshot (identity, geometry, appearance, text, bindings, grouping),
 * or when the fingerprint on record cannot be compared at all.
 *
 * The only accepted differences are `version`, `versionNonce`, `updated`, `index`,
 * `seed`, and empty-collection shape churn (`null`/absent vs `[]` in `groupIds` /
 * `boundElements`). They are counters, timestamps, paint order and canvas-session
 * serialization artifacts: none of them names, locates, styles, labels or binds an
 * object, so a difference in them cannot make the delete hit a different object or
 * remove content the user did not see. A moved, resized, restyled, relabelled,
 * regrouped, unbound, replaced or deleted target differs in at least one hashed field
 * and is still refused; a proposal replayed against another scene is refused by the
 * service's canvasId check before this guard is reached.
 */
export function assertDestructiveTargetsContentUnchanged(
  content: CanvasContent,
  targets: DestructiveTarget[],
): void {
  const byId = new Map(
    activeElements(content).map((element) => [element.id, element]),
  );
  for (const target of targets) {
    assertElementShapeUnchanged(byId, target.elementId, target.contentShape);
    for (const child of target.cascade) {
      assertElementShapeUnchanged(byId, child.elementId, child.contentShape);
    }
  }
}

function assertElementShapeUnchanged(
  byId: Map<string, CanvasElement>,
  elementId: string,
  expectedShape: Record<string, unknown>,
): void {
  const current = byId.get(elementId);
  if (!current || !expectedShape) {
    throw new DestructiveConfirmationError(
      "confirmation_stale",
      `Delete target ${elementId} changed after confirmation was requested.`,
    );
  }
  const currentShape = fingerprintShape(current);
  if (fingerprintOfShape(currentShape) === fingerprintOfShape(expectedShape)) return;
  // Name the exact fields behind a rejected confirmation: "the target changed" is
  // not actionable on its own, and this branch only runs on a version drift.
  const differingFields = TARGET_FINGERPRINT_FIELDS.filter(
    (field) =>
      JSON.stringify(currentShape[field]) !== JSON.stringify(expectedShape[field]),
  );
  console.info("[confirmation] rejected a drifted delete target", {
    elementId,
    differingFields,
    expected: JSON.stringify(canonicalize(expectedShape)),
    current: JSON.stringify(canonicalize(currentShape)),
  });
  throw new DestructiveConfirmationError(
    "confirmation_stale",
    `Delete target ${elementId} changed after confirmation was requested.`,
  );
}

/**
 * The one gate a destructive confirmation must pass, for both the confirmation service
 * and the CAS writer that performs the delete. Version identity is checked first; if
 * only the version counter moved, the content shape carried by the target decides.
 */
export function assertDestructiveTargetsStillCurrent(
  content: CanvasContent,
  targets: DestructiveTarget[],
): void {
  try {
    assertDestructiveTargetsUnchanged(content, targets);
    return;
  } catch (error) {
    if (!(error instanceof DestructiveConfirmationError) || error.code !== "confirmation_stale") {
      throw error;
    }
  }
  assertDestructiveTargetsContentUnchanged(content, targets);
}

function snapshotTargets(
  content: CanvasContent,
  operations: FrozenCanvasOperation[],
): DestructiveTarget[] {
  const elements = activeElements(content);
  const byId = new Map(elements.map((element) => [element.id, element]));
  const targetIds = Array.from(
    new Set(
      operations
        .filter((operation) => operation.action === "delete")
        .map((operation) => operation.element_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  );
  const deleteCount = operations.filter(
    (operation) => operation.action === "delete",
  ).length;
  if (targetIds.length !== deleteCount) {
    throw new DestructiveConfirmationError(
      "confirmation_stale",
      "Every delete operation must name one unique element_id.",
    );
  }

  return targetIds.map((elementId) => {
    const element = byId.get(elementId);
    if (!element) {
      throw new DestructiveConfirmationError(
        "confirmation_stale",
        `Delete target ${elementId} does not exist.`,
      );
    }
    const bound = Array.isArray(element.boundElements)
      ? (element.boundElements as Array<{ id?: unknown; type?: unknown }>)
      : [];
    const cascade = bound
      .filter((item) => item.type === "text" && typeof item.id === "string")
      .map((item) => byId.get(item.id as string))
      .filter((item): item is CanvasElement => item !== undefined)
      .map((item) => ({
        elementId: item.id,
        type: String(item.type ?? "unknown"),
        version: versionOf(item),
        versionNonce: nonceOf(item),
        contentShape: fingerprintShape(item),
      }));
    return {
      elementId,
      type: String(element.type ?? "unknown"),
      label: labelOf(element),
      version: versionOf(element),
      versionNonce: nonceOf(element),
      contentShape: fingerprintShape(element),
      cascade,
    };
  });
}

export function assertDestructiveTargetsUnchanged(
  content: CanvasContent,
  targets: DestructiveTarget[],
) {
  const byId = new Map(
    activeElements(content).map((element) => [element.id, element]),
  );
  for (const target of targets) {
    const current = byId.get(target.elementId);
    if (
      !current ||
      versionOf(current) !== target.version ||
      nonceOf(current) !== target.versionNonce
    ) {
      throw new DestructiveConfirmationError(
        "confirmation_stale",
        `Delete target ${target.elementId} changed after confirmation was requested.`,
      );
    }
    const currentBoundTextIds = new Set(
      (Array.isArray(current.boundElements)
        ? (current.boundElements as Array<{ id?: unknown; type?: unknown }>)
        : []
      )
        .filter((item) => item.type === "text" && typeof item.id === "string")
        .map((item) => item.id as string),
    );
    if (
      currentBoundTextIds.size !== target.cascade.length ||
      target.cascade.some((child) => {
        const currentChild = byId.get(child.elementId);
        return (
          !currentBoundTextIds.has(child.elementId) ||
          !currentChild ||
          versionOf(currentChild) !== child.version ||
          nonceOf(currentChild) !== child.versionNonce
        );
      })
    ) {
      throw new DestructiveConfirmationError(
        "confirmation_stale",
        `Bindings for delete target ${target.elementId} changed.`,
      );
    }
  }
}

export type DestructiveConfirmationService = ReturnType<
  typeof createDestructiveConfirmationService
>;

export function createDestructiveConfirmationService(options?: {
  ttlMs?: number;
  now?: () => number;
  durableActionStore?: DurableActionConfirmationStore;
  executeDurableAction?: (
    action: DurableActionConfirmation,
    context: unknown,
  ) => Promise<Record<string, unknown>>;
  onConfirmedActionApplied?: (event: ConfirmedActionAppliedEvent) => Promise<void>;
}) {
  const ttlMs = options?.ttlMs ?? 10 * 60_000;
  const now = options?.now ?? Date.now;
  const proposals = new Map<string, StoredProposal>();
  const actionProposals = new Map<string, StoredActionProposal>();

  const completeDurableAction = async (action: DurableActionConfirmation) => {
    if (action.completionDone) return;
    if (!options?.onConfirmedActionApplied || !options.durableActionStore) return;
    if (!action.result) throw new Error("agent_confirmation_result_missing");
    await options.onConfirmedActionApplied({
      confirmationId: action.confirmationId,
      taskId: action.taskId,
      taskRevision: action.taskRevision,
      originRunId: action.originRunId,
      toolExecutionId: action.toolExecutionId,
      userId: action.userId,
      workspaceId: action.workspaceId,
      sessionId: action.sessionId,
      canvasId: action.canvasId,
      workflowStepId: action.workflowStepId,
      kind: action.kind,
      details: action.details,
      outcome: action.result,
    });
    if (!await options.durableActionStore.complete(action.confirmationId))
      throw new Error("agent_confirmation_completion_conflict");
  };

  const completeAppliedAction = async (proposal: StoredActionProposal) => {
    if (!proposal.onApplied || proposal.completionDone) return;
    if (proposal.completion) return proposal.completion;
    const completion = Promise.resolve().then(() => proposal.onApplied!(proposal.result));
    proposal.completion = completion;
    try {
      await completion;
      proposal.completionDone = true;
    } finally {
      delete proposal.completion;
    }
  };

  const confirmDurableAction = async (input: {
    confirmationId: string;
    userId: string;
    canvasId: string;
    context?: unknown;
  }) => {
    if (!options?.durableActionStore)
      throw new Error("durable_confirmation_unavailable");
    const claim = await options.durableActionStore.claim(
      input.confirmationId,
      input.userId,
      input.canvasId,
    );
    if (claim.state === "applied") {
      await completeDurableAction(claim.action);
      return claim.action.result;
    }
    if (claim.state === "claimed") {
      if (!options.executeDurableAction)
        throw new Error("durable_confirmation_executor_unavailable");
      const token = claim.action.claimToken;
      if (!token) throw new Error("durable_confirmation_claim_invalid");
      try {
        const result = await options.executeDurableAction(
          claim.action,
          input.context,
        );
        if (!await options.durableActionStore.finishApplied(
          claim.action.confirmationId,
          token,
          result,
        )) throw new Error("agent_confirmation_claim_lost");
        await completeDurableAction({
          ...claim.action,
          status: "applied",
          result,
        });
        return result;
      } catch (error) {
        // confirmed_at remains set when the lease is released. An unattended
        // recovery tick may therefore replay this exact idempotent mutation,
        // while a never-confirmed pending proposal remains ineligible.
        await options.durableActionStore.release(
          claim.action.confirmationId,
          token,
        ).catch(() => false);
        throw error;
      }
    }
    const code = claim.state === "expired" ? "confirmation_expired"
      : claim.state === "stale" ? "confirmation_stale"
        : claim.state === "executing" || claim.state === "canceled"
          ? "confirmation_consumed"
          : "confirmation_not_found";
    throw new DestructiveConfirmationError(code, `Confirmation is ${claim.state}.`);
  };

  return {
    async resumeAppliedForSession(input: {
      user: { id: string };
      sessionId: string;
    }): Promise<{ completed: number; replayed: number; errors: string[] }> {
      if (!options?.durableActionStore || !options.onConfirmedActionApplied)
        throw new Error("durable_confirmation_recovery_unavailable");
      const actions = await options.durableActionStore.listRecoveryPending(
        input.user.id,
        input.sessionId,
      );
      let completed = 0;
      let replayed = 0;
      const errors: string[] = [];
      for (const action of actions) {
        try {
          await confirmDurableAction({
            confirmationId: action.confirmationId,
            userId: input.user.id,
            canvasId: action.canvasId,
            context: { user: input.user },
          });
          if (action.status === "applied") completed += 1;
          else replayed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "recovery_failed";
          errors.push(`${action.confirmationId}:${message}`);
        }
      }
      return { completed, replayed, errors };
    },

    async proposeDurableAction(input: {
      userId: string;
      workspaceId: string;
      sessionId: string;
      canvasId: string;
      taskId: string;
      taskRevision: number;
      originRunId: string;
      toolExecutionId: string;
      workflowStepId: string | null;
      kind: "design_mutation";
      details: Record<string, unknown>;
      payload: Record<string, unknown>;
    }): Promise<ActionConfirmationProposal> {
      if (!options?.durableActionStore)
        throw new Error("durable_confirmation_unavailable");
      const confirmationId = randomUUID();
      const expiresAt = new Date(now() + ttlMs).toISOString();
      const action = await options.durableActionStore.create({
        confirmationId,
        kind: input.kind,
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        canvasId: input.canvasId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        originRunId: input.originRunId,
        toolExecutionId: input.toolExecutionId,
        workflowStepId: input.workflowStepId,
        details: structuredClone(input.details),
        payload: structuredClone(input.payload),
        expiresAt,
      });
      return {
        confirmationId: action.confirmationId,
        canvasId: action.canvasId,
        kind: action.kind,
        details: action.details,
        expiresAt: action.expiresAt,
      };
    },

    proposeAction(input: {
      userId: string;
      canvasId: string;
      kind: ConfirmableActionKind;
      details: Record<string, unknown>;
      originRunId?: string;
      execute: () => Promise<unknown>;
      validate?: () => Promise<void>;
      onApplied?: (result: unknown) => Promise<void>;
    }): ActionConfirmationProposal {
      const confirmationId = randomUUID();
      const proposal: StoredActionProposal = {
        confirmationId,
        userId: input.userId,
        canvasId: input.canvasId,
        kind: input.kind,
        details: structuredClone(input.details),
        ...(input.originRunId ? { originRunId: input.originRunId } : {}),
        execute: input.execute,
        ...(input.validate ? { validate: input.validate } : {}),
        ...(input.onApplied ? { onApplied: input.onApplied } : {}),
        expiresAt: new Date(now() + ttlMs).toISOString(),
        status: "pending",
      };
      actionProposals.set(confirmationId, proposal);
      return structuredClone({
        confirmationId: proposal.confirmationId,
        canvasId: proposal.canvasId,
        kind: proposal.kind,
        details: proposal.details,
        expiresAt: proposal.expiresAt,
      });
    },

    /**
     * Snapshot the delete targets of `operations` before any proposal exists, so the
     * caller can hold on to the exact target objects — including the content shapes that
     * travel with them into the proposal's `execute` closure and the CAS writer.
     */
    targetsSnapshot(
      content: CanvasContent,
      operations: FrozenCanvasOperation[],
    ): DestructiveTarget[] {
      return snapshotTargets(content, structuredClone(operations));
    },

    propose(input: {
      userId: string;
      canvasId: string;
      content: CanvasContent;
      operations: FrozenCanvasOperation[];
      loadCanvas: () => Promise<CanvasContent>;
      /** Targets from `targetsSnapshot`; recomputed from `content` when omitted. */
      targets?: DestructiveTarget[];
      execute: (
        operations: FrozenCanvasOperation[],
        targets: DestructiveTarget[],
      ) => Promise<unknown>;
    }): DestructiveProposal {
      const frozenOperations = structuredClone(input.operations);
      const confirmationId = randomUUID();
      // Each target carries the content shape it had at proposal time, so the gate does
      // not depend on any caller remembering to thread a side table along.
      const targets = input.targets ?? snapshotTargets(input.content, frozenOperations);
      const proposal: StoredProposal = {
        confirmationId,
        userId: input.userId,
        canvasId: input.canvasId,
        operations: frozenOperations,
        loadCanvas: input.loadCanvas,
        execute: input.execute,
        operationsDigest: digestOperations(frozenOperations),
        targets,
        expiresAt: new Date(now() + ttlMs).toISOString(),
        status: "pending",
      };
      proposals.set(confirmationId, proposal);
      return structuredClone({
        confirmationId: proposal.confirmationId,
        canvasId: proposal.canvasId,
        operationsDigest: proposal.operationsDigest,
        targets: proposal.targets,
        expiresAt: proposal.expiresAt,
      });
    },

    cancel(input: {
      confirmationId: string;
      userId: string;
      canvasId?: string;
      kind?: ConfirmableActionKind;
    }) {
      const actionProposal = actionProposals.get(input.confirmationId);
      const proposal = input.kind
        ? actionProposal?.kind === input.kind
          ? actionProposal
          : undefined
        : (proposals.get(input.confirmationId) ?? actionProposal);
      if (!proposal) {
        if (input.canvasId && options?.durableActionStore)
          return options.durableActionStore.cancel(
            input.confirmationId,
            input.userId,
            input.canvasId,
          );
        return false;
      }
      if (
        proposal.userId !== input.userId ||
        (input.canvasId !== undefined && proposal.canvasId !== input.canvasId)
      ) {
        throw new DestructiveConfirmationError(
          "confirmation_forbidden",
          "Confirmation does not belong to this user and canvas.",
        );
      }
      if (proposal.status !== "pending") return false;
      proposal.status = "canceled";
      return true;
    },

    async confirm(input: {
      confirmationId: string;
      userId: string;
      canvasId?: string;
      kind?: ConfirmableActionKind;
      runId?: string;
      context?: unknown;
    }): Promise<unknown> {
      const actionProposal = actionProposals.get(input.confirmationId);
      if (
        actionProposal &&
        (!input.kind || actionProposal.kind === input.kind)
      ) {
        if (
          actionProposal.userId !== input.userId ||
          (input.canvasId !== undefined &&
            actionProposal.canvasId !== input.canvasId)
        ) {
          throw new DestructiveConfirmationError(
            "confirmation_forbidden",
            "Confirmation does not belong to this user and canvas.",
          );
        }
        // Image generation confirmation is idempotent. A retry caused by a
        // slow/lost acknowledgement must reuse the in-flight execution or its
        // stored result, never enqueue a second generation job.
        if (actionProposal.status === "applied") {
          await completeAppliedAction(actionProposal);
          return actionProposal.result;
        }
        if (actionProposal.status === "executing" && actionProposal.execution) {
          return actionProposal.execution;
        }
        if (Date.parse(actionProposal.expiresAt) <= now()) {
          actionProposal.status = "canceled";
          throw new DestructiveConfirmationError(
            "confirmation_expired",
            "Confirmation expired.",
          );
        }
        if (
          actionProposal.originRunId &&
          input.runId &&
          actionProposal.originRunId === input.runId
        ) {
          throw new DestructiveConfirmationError(
            "confirmation_requires_new_turn",
            "Image generation must be confirmed in a later user turn.",
          );
        }
        if (actionProposal.status !== "pending") {
          throw new DestructiveConfirmationError(
            "confirmation_consumed",
            "Confirmation has already been used.",
          );
        }
        actionProposal.status = "executing";
        const execution = Promise.resolve()
          .then(() => actionProposal.validate?.())
          .then(() => actionProposal.execute())
          .then(async (result) => {
            // The destructive effect has committed. From this point onward a
            // failed workflow/outbox callback may be retried, but the effect
            // itself must never execute again.
            actionProposal.result = result;
            actionProposal.status = "applied";
            await completeAppliedAction(actionProposal);
            return result;
          });
        actionProposal.execution = execution;
        try {
          return await execution;
        } catch (error) {
          if ((actionProposal.status as StoredActionProposal["status"]) !== "applied")
            actionProposal.status = "canceled";
          delete actionProposal.execution;
          throw error;
        }
      }

      // The durable store is a fallback for confirmations this process no longer
      // holds in memory (a restart, another replica, a recovery tick). A live
      // in-memory proposal — the ordinary canvas deletion — must never be routed
      // there: the store has no row for it, so `claim` answers `not_found` and a
      // real user click was answered "Confirmation is not_found." while the
      // element stayed on the canvas. Delete proposals are stored in `proposals`
      // and carry no `kind`, which is exactly the shape this branch used to
      // swallow whenever the caller passed no `kind` (the WS click handler never
      // does).
      if (
        !proposals.has(input.confirmationId) &&
        (!input.kind || input.kind === "design_mutation") &&
        input.canvasId &&
        options?.durableActionStore
      ) {
        return confirmDurableAction({
          confirmationId: input.confirmationId,
          userId: input.userId,
          canvasId: input.canvasId,
          ...(input.context !== undefined ? { context: input.context } : {}),
        });
      }

      if (input.kind) {
        throw new DestructiveConfirmationError(
          "confirmation_not_found",
          "Confirmation was not found for this action.",
        );
      }

      const proposal = proposals.get(input.confirmationId);
      if (!proposal) {
        throw new DestructiveConfirmationError(
          "confirmation_not_found",
          "Confirmation was not found.",
        );
      }
      if (
        proposal.userId !== input.userId ||
        (input.canvasId !== undefined && proposal.canvasId !== input.canvasId)
      ) {
        throw new DestructiveConfirmationError(
          "confirmation_forbidden",
          "Confirmation does not belong to this user and canvas.",
        );
      }
      if (Date.parse(proposal.expiresAt) <= now()) {
        proposal.status = "canceled";
        throw new DestructiveConfirmationError(
          "confirmation_expired",
          "Confirmation expired.",
        );
      }
      if (proposal.status !== "pending") {
        throw new DestructiveConfirmationError(
          "confirmation_consumed",
          "Confirmation has already been used.",
        );
      }

      // Claim before any asynchronous validation. Concurrent clicks in this
      // process cannot both pass this transition.
      proposal.status = "executing";
      try {
        const content = await proposal.loadCanvas();
        // The version counter can legitimately move while the user decides (the
        // browser's canvas session re-serializes elements it merges), so the content
        // shape snapshotted on the target decides whether this click is still about
        // the object the user saw.
        assertDestructiveTargetsStillCurrent(content, proposal.targets);
        const result = await proposal.execute(
          structuredClone(proposal.operations),
          proposal.targets,
        );
        proposal.status = "applied";
        proposal.result = result;
        return result;
      } catch (error) {
        // Fail closed: a failed execution requires a fresh proposal rather than
        // making a destructive authorization reusable.
        proposal.status = "canceled";
        throw error;
      }
    },
  };
}
