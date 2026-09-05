import {
  type LoomicDesignNodeMetadata,
  loomicDesignNodeMetadataSchema,
} from "@loomic/shared";

export type DesignNodeElementLike = {
  id?: unknown;
  isDeleted?: unknown;
  customData?: unknown;
};

export type DesignNodeOccurrence = {
  elementId: string;
  metadata: LoomicDesignNodeMetadata;
};

export type DesignNodeDuplicate = {
  designId: string;
  authoritativeElementId: string;
  duplicateElementIds: string[];
};

export type DesignNodePasteInspection = {
  pasted: DesignNodeOccurrence[];
  duplicateElementIds: string[];
  malformedElementIds: string[];
  requiresClone: boolean;
};

export function readDesignNodeMetadata(
  element: DesignNodeElementLike,
): LoomicDesignNodeMetadata | null {
  if (element.isDeleted === true || !isDesignNodeCandidate(element))
    return null;
  const parsed = loomicDesignNodeMetadataSchema.safeParse(element.customData);
  return parsed.success ? parsed.data : null;
}

export function collectDesignNodes(
  elements: readonly DesignNodeElementLike[],
): DesignNodeOccurrence[] {
  const nodes: DesignNodeOccurrence[] = [];
  for (const element of elements) {
    if (typeof element.id !== "string") continue;
    const metadata = readDesignNodeMetadata(element);
    if (metadata) nodes.push({ elementId: element.id, metadata });
  }
  return nodes;
}

export function findDuplicateDesignNodes(
  elements: readonly DesignNodeElementLike[],
): DesignNodeDuplicate[] {
  const byDesignId = new Map<string, DesignNodeOccurrence[]>();
  for (const node of collectDesignNodes(elements)) {
    const occurrences = byDesignId.get(node.metadata.designId) ?? [];
    occurrences.push(node);
    byDesignId.set(node.metadata.designId, occurrences);
  }
  return [...byDesignId.entries()].flatMap(([designId, occurrences]) => {
    const [authoritative, ...duplicates] = occurrences;
    if (!authoritative || duplicates.length === 0) return [];
    return [
      {
        designId,
        authoritativeElementId: authoritative.elementId,
        duplicateElementIds: duplicates.map((node) => node.elementId),
      },
    ];
  });
}

/**
 * Intended for Excalidraw onPaste/onDuplicate hooks. Every newly introduced
 * design node must be intercepted and cloned through POST /copy; retaining its
 * source designId would create a second authoritative binding.
 */
export function inspectPastedDesignNodes(
  previousElements: readonly DesignNodeElementLike[],
  nextElements: readonly DesignNodeElementLike[],
): DesignNodePasteInspection {
  const previousIds = new Set(
    previousElements.flatMap((element) =>
      typeof element.id === "string" ? [element.id] : [],
    ),
  );
  const inserted = nextElements.filter(
    (element) => typeof element.id === "string" && !previousIds.has(element.id),
  );
  const pasted = collectDesignNodes(inserted);
  const malformedElementIds = inserted.flatMap((element) => {
    if (
      typeof element.id !== "string" ||
      element.isDeleted === true ||
      !isDesignNodeCandidate(element) ||
      readDesignNodeMetadata(element)
    ) {
      return [];
    }
    return [element.id];
  });
  const existingDesignIds = new Set(
    collectDesignNodes(previousElements).map((node) => node.metadata.designId),
  );
  const pastedDesignIds = new Set<string>();
  const duplicateElementIds = pasted.flatMap((node) => {
    const isDuplicate =
      existingDesignIds.has(node.metadata.designId) ||
      pastedDesignIds.has(node.metadata.designId);
    pastedDesignIds.add(node.metadata.designId);
    return isDuplicate ? [node.elementId] : [];
  });

  return {
    pasted,
    duplicateElementIds,
    malformedElementIds,
    requiresClone: pasted.length > 0,
  };
}

function isDesignNodeCandidate(element: DesignNodeElementLike): boolean {
  if (
    !element.customData ||
    typeof element.customData !== "object" ||
    Array.isArray(element.customData)
  ) {
    return false;
  }
  return (
    (element.customData as Record<string, unknown>).kind === "loomic-design"
  );
}
