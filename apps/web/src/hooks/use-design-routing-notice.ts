"use client";

import { useCallback, useRef } from "react";

import type { DesignRoutingEvent, DesignTurnEvent } from "@loomic/shared";

import { useToast } from "../components/toast";

/**
 * Part ① — surfaces the runtime's per-turn routing decision as a single
 * non-blocking toast.
 *
 * LAYERED FOR TWO AUDIENCES, because one toast cannot serve both:
 *   - the SHORT line (always) names the deliverable Skill the user's own words
 *     point at, plus the keywords that matched it;
 *   - the DETAIL block (advanced mode only) adds the judgement basis (rule /
 *     model / deterministic fallback + confidence), the helper guides and the
 *     non-standard-size enable.
 *
 * A normal user must never be handed routing telemetry they cannot act on, and
 * whoever is debugging a mis-route must still see exactly why the turn was
 * classified the way it was — so the detail line is a mode, not a deletion.
 *
 * What it shows: the deliverable Skill the runtime selected and the keywords
 * that selected it, the reason/confidence behind the turn label, the helper
 * guides that were preloaded and the non-standard-size enable. Those are the
 * decisions a user currently cannot see anywhere.
 *
 * SECOND EVENT, SAME CHANNEL: `design.turn` (the per-turn two-layer record — the
 * detected intent beside the action the run's own receipts prove it executed, plus
 * the turn summary) arrives after the run's message was persisted and is
 * presented through this same hook, because it must reach the UI exactly the way
 * the routing notice does. It is NOT downgraded to a short ordinary line: an
 * ordinary user has nothing to do with router-vs-execution telemetry, so it is
 * rendered only in advanced mode. That reuses the one existing
 * `loomic:routing-detail` switch instead of inventing a second one; the ordinary
 * notice above stays exactly as short as it was.
 *
 * Invariants this hook owns:
 *   - ONE notice per turn, per event kind. The event buffer replays events after
 *     a reconnect, so a runId that has already been shown for a kind is
 *     remembered and ignored — the two kinds are tracked separately so a replayed
 *     routing notice can never suppress the turn record.
 *   - Non-intrusive. The toast auto-dismisses, never blocks input and never
 *     requires dismissal.
 *   - No wording logic here: `summary`/`detail` are authored by the server next
 *     to the decision, so the client cannot drift from the routing vocabulary.
 *   - No model call: it only renders decisions the runtime already made.
 *
 * The runtime emits nothing at all for a turn with no design decision, so a
 * plain "你好呀" shows no routing notice even though this hook is always mounted.
 * A turn record is still emitted for such a turn, and simply reports that no
 * routing verdict exists rather than inventing one.
 */

/**
 * Advanced mode switch, read at presentation time so it takes effect without a
 * rebuild: `localStorage.setItem("loomic:routing-detail", "1")` in the browser
 * console. Any other value keeps the short notice; storage being unavailable
 * (private mode, blocked cookies) also keeps it, because the safe direction is
 * to say less rather than to dump telemetry the user did not ask for.
 */
export const ROUTING_DETAIL_STORAGE_KEY = "loomic:routing-detail";

function routingDetailEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ROUTING_DETAIL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Bounded per-kind dedupe memory, so a long session cannot grow it without end. */
const MAX_TRACKED_RUN_IDS = 64;

export function useDesignRoutingNotice() {
  const { toast } = useToast();
  // Latest-callback ref: the returned function must keep a stable identity so it
  // can sit inside a WebSocket subscription without re-subscribing every render.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const shownRoutingRunIds = useRef<Set<string>>(new Set());
  const shownTurnRunIds = useRef<Set<string>>(new Set());

  const remember = useCallback((seen: Set<string>, runId: string): boolean => {
    if (seen.has(runId)) return false;
    // Set iteration order is insertion order, so this evicts the oldest.
    if (seen.size >= MAX_TRACKED_RUN_IDS) {
      const oldest = seen.values().next().value;
      if (oldest) seen.delete(oldest);
    }
    seen.add(runId);
    return true;
  }, []);

  const presentRoutingNotice = useCallback((event: DesignRoutingEvent) => {
    if (!remember(shownRoutingRunIds.current, event.runId)) return false;
    const showDetail = routingDetailEnabled();
    console.info("[design-routing-notice] shown", {
      runId: event.runId, intent: event.intent, reasonCode: event.reasonCode, source: event.source,
      detail: showDetail,
    });
    toastRef.current(showDetail && event.detail ? `${event.summary}\n${event.detail}` : event.summary, "info");
    return true;
  }, [remember]);

  /**
   * The per-turn two-layer record. Advanced mode only: with the gate off this
   * returns `false` WITHOUT consuming the runId, so enabling the mode mid-session
   * still shows the next turn's record, and a user who never enables it is never
   * shown router telemetry.
   */
  const presentTurnRecord = useCallback((event: DesignTurnEvent) => {
    if (!routingDetailEnabled()) return false;
    if (!remember(shownTurnRunIds.current, event.runId)) return false;
    console.info("[design-turn-record] shown", { runId: event.runId });
    toastRef.current(event.detail ? `${event.summary}\n${event.detail}` : event.summary, "info");
    return true;
  }, [remember]);

  /**
   * One subscription entry point for both notices, so the two WebSocket call
   * sites cannot drift: the routing notice for the turn label, the turn record
   * for what the run actually executed.
   */
  const present = useCallback((event: DesignRoutingEvent | DesignTurnEvent) => {
    return event.type === "design.turn"
      ? presentTurnRecord(event)
      : presentRoutingNotice(event);
  }, [presentRoutingNotice, presentTurnRecord]);

  return { present, presentRoutingNotice, presentTurnRecord };
}
