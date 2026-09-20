"use client";

import { useCallback, useRef } from "react";

import type { DesignRoutingEvent } from "@loomic/shared";

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
 * Invariants this hook owns:
 *   - ONE notice per turn. The event buffer replays events after a reconnect, so
 *     a runId that has already been shown is remembered and ignored.
 *   - Non-intrusive. The toast auto-dismisses, never blocks input and never
 *     requires dismissal.
 *   - No wording logic here: `summary`/`detail` are authored by the server next
 *     to the decision, so the client cannot drift from the routing vocabulary.
 *   - No model call: it only renders a decision the runtime already made.
 *
 * The runtime emits nothing at all for a turn with no design decision, so a
 * plain "你好呀" shows no notice even though this hook is always mounted.
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

export function useDesignRoutingNotice() {
  const { toast } = useToast();
  // Latest-callback ref: the returned function must keep a stable identity so it
  // can sit inside a WebSocket subscription without re-subscribing every render.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const shownRunIds = useRef<Set<string>>(new Set());

  const present = useCallback((event: DesignRoutingEvent) => {
    if (shownRunIds.current.has(event.runId)) return false;
    // Bounded: a long session must not accumulate run IDs for the process
    // lifetime. Set iteration order is insertion order, so this evicts oldest.
    if (shownRunIds.current.size >= 64) {
      const oldest = shownRunIds.current.values().next().value;
      if (oldest) shownRunIds.current.delete(oldest);
    }
    shownRunIds.current.add(event.runId);
    const showDetail = routingDetailEnabled();
    console.info("[design-routing-notice] shown", {
      runId: event.runId, intent: event.intent, reasonCode: event.reasonCode, source: event.source,
      detail: showDetail,
    });
    toastRef.current(showDetail && event.detail ? `${event.summary}\n${event.detail}` : event.summary, "info");
    return true;
  }, []);

  return { present };
}
