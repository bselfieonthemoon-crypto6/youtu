# Image provider fallback

Deployed migration 20260911000010, API and ordinary worker. Scope: conversational
and HTTP image jobs using workspace models; exact upstream model only. The
catalog cannot establish cross-model reference/aspect/transparent-output
compatibility, so unrelated image models are not blindly substituted. Node-only
atomic submission remains unchanged. UI keeps normal processing state; provider
switch progress is currently server-side logging, not a separate UI label.

Before charge/enqueue, freeze at most eight enabled, connection-tested providers
in deterministic order (requested connection first when available). Preserve
approved proposal/public model and all generation inputs; concrete provider
identity is recorded separately. Quote must stay within approved cost, and
fallback runs inside one job rather than charging one new job per provider.

Each attempt has an immutable identity and durable checkpoint. Only explicit
provider_rejected followed by successful rejected-state persistence advances the
chain. Unknown outcomes, timeouts, storage uncertainty, invalid inputs and safety
rejections do not advance. Returned images are reused after restart. Attempt zero
keeps the old fingerprint so historical checkpoints remain recoverable.

Verification performed by the primary agent:
- Real migration + rollback transaction: disabled requested provider skipped;
  active same-upstream provider frozen; over-cap quote rejected with no residue;
  replay preserves snapshot IDs; credentials and ordinals remain complete.
- Actual catalog service read against local PostgREST confirmed the user's
  disabled gpt-image-2 alias has an eligible fallback. This caught and fixed a
  JSONB contains serialization defect missed by mock tests.
- Executor matrix (mock providers, nine references): reject then success;
  reject then unknown stops; all rejected stops. Re-executing the same job does
  not call providers again. Legacy image recovery, worker and job suites passed.
- Server TypeScript check passed. Additional snapshot/catalog/checkpoint tests
  supplied by Luna passed. No paid provider generation issued in this task.

Sol/high implemented plan/snapshot/executor changes. Luna/medium added independent
transport, checkpoint and catalog tests. Primary agent reviewed compatibility,
added executor matrix tests, fixed JSONB transport, validated SQL and deployed.
