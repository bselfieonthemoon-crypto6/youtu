import type { DesignTaskTarget } from "@loomic/shared";
import type { ReadyAttachment } from "../hooks/use-image-attachments";

type Selection = { id: string; type: string; designId?: string | undefined; assetId?: string | undefined };

export type FreshAuthorizedDesignScope = {
  target: Extract<DesignTaskTarget, { kind: "design" }>;
  authorizedTargets: Array<Extract<DesignTaskTarget, { kind: "design" }>>;
};

/**
 * A multi-board scope comes only from the canvas selection captured at send
 * time. It intentionally does not inspect the active board, prior task, or
 * message content: selection is evidence, not permission to broaden scope.
 */
export function resolveFreshAuthorizedDesignScope(input: {
  attachments: readonly ReadyAttachment[];
  selection: readonly Selection[];
}): FreshAuthorizedDesignScope | undefined {
  if (input.attachments.length > 0 || input.selection.length < 2) return undefined;
  if (input.selection.some(item => !item.designId)) return undefined;
  const seen = new Set<string>();
  const authorizedTargets: FreshAuthorizedDesignScope["authorizedTargets"] = [];
  for (const item of input.selection) {
    const designId = item.designId!;
    if (seen.has(designId)) continue;
    seen.add(designId);
    authorizedTargets.push({ kind: "design", designId, elementId: item.id });
    if (authorizedTargets.length === 20) break;
  }
  const target = authorizedTargets[0];
  return target ? { target, authorizedTargets } : undefined;
}

/** A fresh turn needs current, explicit target evidence. Opening an editor is
 * ambient UI state, not a request to write to that design. */
export function resolveFreshTaskTarget(input: {
  attachments: readonly ReadyAttachment[];
  canvasImages: readonly { id: string; assetId: string }[];
  selection: readonly Selection[];
}): DesignTaskTarget | undefined {
  if (input.attachments.length > 0) {
    const attachment = input.attachments.length === 1 ? input.attachments[0] : undefined;
    if (attachment?.source !== "canvas-ref") return undefined;
    const image = input.canvasImages.find(item => item.assetId === attachment.assetId)
      ?? input.selection.find(item => item.type === "image" && item.assetId === attachment.assetId);
    return image ? { kind: "canvas_image", elementId: image.id, assetId: attachment.assetId } : undefined;
  }
  const selected = input.selection.length === 1 ? input.selection[0] : undefined;
  if (selected?.designId) return { kind: "design", designId: selected.designId, elementId: selected.id };
  if (selected?.type === "image" && selected.assetId) return { kind: "canvas_image", elementId: selected.id, assetId: selected.assetId };
  return undefined;
}

export function mergeContinuationAttachments(input: {
  previous: readonly ReadyAttachment[];
  current: readonly ReadyAttachment[];
  previousTarget: DesignTaskTarget;
  nextTarget?: DesignTaskTarget | undefined;
  retargetAttachment?: ReadyAttachment | undefined;
}): ReadyAttachment[] {
  const oldTargetAsset = input.previousTarget.kind === "canvas_image" ? input.previousTarget.assetId : undefined;
  const replacesTarget = input.nextTarget && (input.nextTarget.kind !== "canvas_image" || input.nextTarget.assetId !== oldTargetAsset);
  const retained = input.previous.filter(attachment => !replacesTarget || attachment.assetId !== oldTargetAsset);
  return [...new Map([...retained, ...input.current, ...(input.retargetAttachment ? [input.retargetAttachment] : [])]
    .map(attachment => [attachment.assetId, attachment])).values()];
}
