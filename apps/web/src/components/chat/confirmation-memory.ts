/**
 * What this browser already knows about a confirmation proposal.
 *
 * A confirmation card is re-rendered from the persisted transcript, which still holds
 * the original proposal long after the click: on a reload the card would offer 「确认删除」
 * again for an action that already ran (or already failed). The server refuses such a
 * click as consumed, so the button is a dead end — and for an applied deletion it also
 * claims the canvas still holds the element. This record keeps the card honest across
 * reloads and keeps a dead button off the screen.
 *
 * Two facts are stored, because they arrive at different times:
 *   - SUBMITTED: the server accepted the click (`accepted`). Written immediately, so a
 *     reload while the action is still running cannot re-offer the button.
 *   - OUTCOME: the server's terminal answer (`applied` / `failed` / `canceled`), so a
 *     reloaded card can say what actually happened instead of guessing.
 *
 * Storage is best effort: a browser that denies localStorage still has the in-memory
 * guards, and a missing record only costs the reload behavior.
 */

const SUBMITTED_STORAGE_PREFIX = "loomic:handled-confirmation:";
const OUTCOME_STORAGE_PREFIX = "loomic:confirmation-outcome:";

export type ConfirmationOutcomeStatus = "applied" | "failed" | "canceled";

export type StoredConfirmationOutcome = {
  status: ConfirmationOutcomeStatus;
  message?: string;
};

/** `true` once this browser has sent a decision for this confirmation. */
export function wasConfirmationSubmitted(confirmationId: string): boolean {
  try {
    return (
      window.localStorage.getItem(
        `${SUBMITTED_STORAGE_PREFIX}${confirmationId}`,
      ) === "1"
    );
  } catch {
    return false;
  }
}

export function markConfirmationSubmitted(confirmationId: string): void {
  try {
    window.localStorage.setItem(
      `${SUBMITTED_STORAGE_PREFIX}${confirmationId}`,
      "1",
    );
  } catch {
    // The in-memory message guard still prevents the dialog from reopening
    // when storage is unavailable (for example, in a restricted browser).
  }
}

/** The server's terminal answer for this confirmation, when one was recorded. */
export function readConfirmationOutcome(
  confirmationId: string,
): StoredConfirmationOutcome | null {
  try {
    const raw = window.localStorage.getItem(
      `${OUTCOME_STORAGE_PREFIX}${confirmationId}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConfirmationOutcome> | null;
    const status = parsed?.status;
    if (status !== "applied" && status !== "failed" && status !== "canceled") {
      return null;
    }
    return {
      status,
      ...(typeof parsed?.message === "string" ? { message: parsed.message } : {}),
    };
  } catch {
    return null;
  }
}

export function markConfirmationOutcome(
  confirmationId: string,
  outcome: StoredConfirmationOutcome,
): void {
  try {
    window.localStorage.setItem(
      `${OUTCOME_STORAGE_PREFIX}${confirmationId}`,
      JSON.stringify(outcome),
    );
  } catch {
    // Best effort, as above.
  }
}
