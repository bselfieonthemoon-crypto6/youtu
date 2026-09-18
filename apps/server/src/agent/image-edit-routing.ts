/** Validated target scope, not an intent classifier or permission to execute. */
export type ImageEditRouting = {
  assetId: string;
  aspectRatio?: string;
  placement?: {
    placementX: number;
    placementY: number;
    placementWidth: number;
    placementHeight: number;
  };
};

export function resolveImageEditRouting(input: {
  /** Kept for call-site compatibility. Natural-language resize interpretation
   * belongs to the reviewed generate_image arguments, not a keyword regex. */
  prompt: string;
  attachments: Array<{ assetId: string; width?: number; height?: number }>;
  /** Required for an enforced binding. Words like 'change' do not grant scope. */
  explicitSourceAssetId?: string;
  canvas?: { elements?: Array<Record<string, any>>; files?: Record<string, any> } | null;
}): ImageEditRouting | undefined {
  // A question about changing a background is not an edit authorization. The
  // model interprets unbound attachments; only a validated task may hard-bind it.
  if (!input.explicitSourceAssetId) return;
  const source = input.attachments.find(item => item.assetId === input.explicitSourceAssetId);
  if (!source) return;
  if (input.explicitSourceAssetId && source.assetId !== input.explicitSourceAssetId) return;
  const element = input.canvas?.elements?.find((el) => !el.isDeleted && el.type === "image" && (
    el.id === source.assetId || el.customData?.assetId === source.assetId ||
    input.canvas?.files?.[el.fileId]?.assetId === source.assetId
  ));
  // A board preview is not a standalone image, even when attached as an image.
  if (element?.customData?.kind === "loomic-design") return;
  const result: ImageEditRouting = { assetId: source.assetId };
  // Always expose the authenticated source ratio. generate_image preserves it
  // only when the reviewed tool call omits an explicit aspectRatio. This makes
  // "比例不变", "keep original aspect ratio" and equivalent wording work
  // without treating every occurrence of "ratio/aspect" as resize authority.
  if (source.width && source.height) {
    let a = source.width;
    let b = source.height;
    while (b) [a, b] = [b, a % b];
    result.aspectRatio = `${source.width / a}:${source.height / a}`;
  }
  if (element && [element.x, element.y, element.width, element.height].every(Number.isFinite) && element.width > 0 && element.height > 0) {
    result.placement = {
      placementX: element.x + element.width + 40,
      placementY: element.y,
      placementWidth: element.width,
      placementHeight: element.height,
    };
  }
  return result;
}
