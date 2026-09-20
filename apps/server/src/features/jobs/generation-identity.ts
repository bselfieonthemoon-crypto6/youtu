/**
 * The four identifiers that must agree across every artifact of ONE generation.
 *
 * Why this module exists: the placeholder element (`canvas-element-writer.ts`),
 * the finalized canvas image (same writer) and the chat card
 * (`job-canvas-finalizer.ts`, `mastra-image-jobs.ts`) are written by different
 * code paths, and each of them used to carry a different subset — the
 * placeholder had `jobId`/`sourceJobId`, the image had `sourceJobId`/`assetId`,
 * the card had `jobId` only. Every later step (status update, delete, replace,
 * retry) then had to re-derive "which element belongs to this job" from layout,
 * prompt or ordering, which is exactly how a retry after a cancellation can
 * update or delete the wrong picture. Naming all four in one place is what makes
 * those steps safe; joining on the ids is the only supported way to do it.
 *
 * `messageId` is DERIVED, never stored as an independent value. Every chat card
 * for a generation job is upserted with `chat_messages.id = background_jobs.id`:
 * the submission card (`mastra-image-jobs.ts`), the successful canvas card and
 * the superseded card (`finalizeCurrentImageJobToCanvas`,
 * `finalizeImageJobToCanvas`), the design card (`finalizeDesignImageJobChat`) and
 * every terminal card (`finalizeTerminalImageJobPlaceholder`,
 * `finalizeTerminalVideoJobPlaceholder`) all key the row by the job id. A stored
 * copy could therefore only ever drift, so the invariant is documented here and
 * the value is filled from the job id.
 *
 * A directly submitted canvas-node job has no session and therefore no card;
 * its element still records the reserved card id, which is the id that card
 * would have used. Nothing dangles and the four ids never disagree.
 *
 * `assetId` is the one id that cannot exist before the provider stored the
 * pixels: a placeholder records it as ABSENT (never as a guessed value) and the
 * finalized image/card carry it as soon as the job result has it.
 */
export type GenerationIdentity = {
  /** `background_jobs.id` — the one job every artifact belongs to. */
  jobId: string;
  /** `chat_messages.id` of this job's card; equals `jobId` by construction. */
  messageId: string;
  /** `asset_objects.id`, once the provider result was stored. */
  assetId?: string;
  /** The canvas element that carries the pixels/progress for this job. */
  canvasElementId?: string;
};

/** The chat card row id for a generation job. See the module comment. */
export function generationMessageId(jobId: string): string {
  return jobId;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build the shared identity from whatever is already known. Unknown optional ids
 * are omitted rather than filled with a placeholder, so a consumer can always
 * tell "not known yet" from "known and equal".
 */
export function generationIdentity(input: {
  jobId: string;
  assetId?: unknown;
  canvasElementId?: unknown;
}): GenerationIdentity {
  const assetId = nonEmpty(input.assetId);
  const canvasElementId = nonEmpty(input.canvasElementId);
  return {
    jobId: input.jobId,
    messageId: generationMessageId(input.jobId),
    ...(assetId ? { assetId } : {}),
    ...(canvasElementId ? { canvasElementId } : {}),
  };
}
