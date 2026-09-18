# Natural chat and opt-in background execution

User-facing design:

- No internal task card, manual correction mode, workflow budget panel or round
  counters in the composer.
- An accessible compact automatic-execution switch sits after image model
  preferences. New sessions default off on the server, even when the obsolete
  local test-default flag is present.
- Explicitly saved session preferences are retained. The switch persists via
  the authenticated session API. It is not a UI-only switch.
- Background capability and consent are separate: local signing bootstrap stays
  available without enabling automatic work by default.
- Normal chat supplies follow-up requests. Task/version/target checks remain
  necessary; hiding the panel does not remove authority boundaries.
- Stop controls remain available. Enabling background work has a tooltip about
  possible fees and continued work after closing the page.

Verification scripts: `apps/web/scripts/check-native-board-browser.mjs --submit`
and optional `--followups` exercise real paid text-model calls with isolated QA
canvases; they do not intentionally request image generation.

## Verification and remaining limits

- UI component tests 2/2; HTTP autonomy policy tests 6/6.
- Routing shared tests 11/11, web scope tests 20/20, server routing/HTTP/WS tests
  23/23. Web/server type checks passed. Shared package rebuilt before production
  build `.next-production-natural-chat`; production build passed.
- Browser real QA confirmed default-off switch, on/off persisted callbacks,
  hidden panels, one newly created 658 x 176 native board.
- First follow-up exposed a missing WebSocket candidate forwarding field; fixed
  and covered by a WS boundary test.
- Second live QA session `92ecf78d-5a99-4291-8bea-da57f1837610` correctly attached
  the correction to the prior task (revision 2 brief, width 800 / height 176).
  The provider then rejected a model call with HTTP 403 insufficient quota
  (11800 available / 13834 precharge required). The board remained 658 x 176.
  Therefore actual correction mutation and subsequent new-board creation are NOT
  marked passed. No automatic paid retry or provider switch was performed.
- Classifier is conservative routing, not a general semantic understanding
  model. Server intent checks still decide whether writes may execute.
- Blank-creation background completion remains unimplemented: do not infer whole
  task completion merely from the words “blank board.” The unsafe shortcut was
  removed. Opt-in background tasks can still need workflow-plan handling.
