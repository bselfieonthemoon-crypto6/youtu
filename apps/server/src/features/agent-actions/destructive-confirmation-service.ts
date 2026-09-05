import { createHash, randomUUID } from "node:crypto";

import type { CanvasContent } from "@loomic/shared";

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
  cascade: Array<{
    elementId: string;
    type: string;
    version: number;
    versionNonce: number | null;
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

type StoredActionProposal = ActionConfirmationProposal & {
  userId: string;
  originRunId?: string;
  execute: () => Promise<unknown>;
  execution?: Promise<unknown>;
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
      }));
    return {
      elementId,
      type: String(element.type ?? "unknown"),
      label: labelOf(element),
      version: versionOf(element),
      versionNonce: nonceOf(element),
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
}) {
  const ttlMs = options?.ttlMs ?? 10 * 60_000;
  const now = options?.now ?? Date.now;
  const proposals = new Map<string, StoredProposal>();
  const actionProposals = new Map<string, StoredActionProposal>();

  return {
    proposeAction(input: {
      userId: string;
      canvasId: string;
      kind: ConfirmableActionKind;
      details: Record<string, unknown>;
      originRunId?: string;
      execute: () => Promise<unknown>;
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

    propose(input: {
      userId: string;
      canvasId: string;
      content: CanvasContent;
      operations: FrozenCanvasOperation[];
      loadCanvas: () => Promise<CanvasContent>;
      execute: (
        operations: FrozenCanvasOperation[],
        targets: DestructiveTarget[],
      ) => Promise<unknown>;
    }): DestructiveProposal {
      const frozenOperations = structuredClone(input.operations);
      const confirmationId = randomUUID();
      const proposal: StoredProposal = {
        confirmationId,
        userId: input.userId,
        canvasId: input.canvasId,
        operations: frozenOperations,
        loadCanvas: input.loadCanvas,
        execute: input.execute,
        operationsDigest: digestOperations(frozenOperations),
        targets: snapshotTargets(input.content, frozenOperations),
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
      if (!proposal) return false;
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
        const execution = Promise.resolve().then(() =>
          actionProposal.execute(),
        );
        actionProposal.execution = execution;
        try {
          const result = await execution;
          actionProposal.status = "applied";
          actionProposal.result = result;
          return result;
        } catch (error) {
          actionProposal.status = "canceled";
          delete actionProposal.execution;
          throw error;
        }
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
        assertDestructiveTargetsUnchanged(content, proposal.targets);
        const result = await proposal.execute(
          structuredClone(proposal.operations),
          structuredClone(proposal.targets),
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
