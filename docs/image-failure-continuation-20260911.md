# Image failure is request-scoped

Implemented explicit new-turn retry for definite pre-dispatch gateway rejection.
The old job stays terminal; a session-scoped database transaction clones the
unchanged approved proposal into a new attempt. A unique source/request index
and session lock prevent duplicate attempts for the same user request.
The request must be newer than the failed job; an internal tool loop is not
fresh user authorization. Current proposal/source/target and pricing guards
still apply. Discussion and corrections follow the ordinary conversation path.

Unknown outcomes remain blocked from resubmission. Compatibility for the known
legacy error requires the full 503/default-group/distributor/no-channel
fingerprint, not just a generic 503. New provider errors use provider_rejected.
Processing and successful jobs retain replay semantics.

The direct confirmation path now emits a text receipt before completion, in
addition to the job tool card. Persisted content and streamed content match,
avoiding a silent replayed card and duplicate-message content mismatch.

Verification:
- Primary agent reran 125 targeted runtime/confirmation/provider tests and
  server TypeScript checking, all passed.
- Additional failure receipt/stream/runtime checks: 29 passed.
- Real database migration plus rollback test: known legacy rejection creates
  one new attempt; repeated call returns same UUID; plan and lineage retained;
  generic unknown rejection, same-turn retry and cross-session access denied.
- Migration deployed; API and ordinary image worker restarted while idle.
- Original failed job remains dead_letter; zero retry proposals created by QA.
- No paid provider generation was issued. Upstream channel availability is not
  fixed or verified by this change.

Delegation: Sol/high implemented transactional retry and provider classification;
primary agent implemented receipt visibility, reviewed safety, strengthened the
new-turn guard, ran rollback/integration verification and deployed.
