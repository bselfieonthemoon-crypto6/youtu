# Luna failure-boundary audit — 2026-09-11

Scope: server-side confirmation/retry/cancel/fallback/credit-refund boundaries for the multi-user SaaS agent. This audit only changes tests and this report; it does not change production code, restart services, alter the database, or make paid/real provider calls.

## Evidence run

Command (from `apps/server`):

```text
pnpm --filter @loomic/server exec vitest run src/features/jobs/executors/image-generation-durable-recovery.test.ts src/agent/tools/image-generation-confirmation.test.ts src/agent/tools/image-confirmation-turn-idempotency.test.ts src/worker.test.ts src/http/jobs-billing-order.test.ts --reporter=verbose
```

Result: 5 files, 124 tests passed. A focused rerun after the added boundary test ran 3 files, 37 tests passed. The first attempt from the repository root was intentionally recorded as a tooling miss: root Vitest only includes `tests/**/*.test.mjs`, so it found 0 files; no application test was run by that command.

All provider/storage calls in these tests are mocks. No Supabase database, queue, external model, billing account, or real paid invocation was used.

## Confirmed boundaries

- Same authenticated turn: concurrent confirmation calls share one in-flight receipt, replay returns the same receipt, and the submit mock is called once (`apps/server/src/agent/tools/image-confirmation-turn-idempotency.test.ts:21-35`). A failed provider result is not retried in that turn; a later run can explicitly resume (`:37-48`). Confirm and cancel are not conflated (`:50-59`).
- Cancellation/fallback: an executor observes cancellation after the first provider resolves or rejects and does not begin paid foreground processing or the frozen fallback (`apps/server/src/features/jobs/executors/image-generation-durable-recovery.test.ts:88-118`). Definite rejection permits exactly one fallback; unknown outcomes, storage retries, invalid alpha, and post-processing retries do not repay the provider (`:120` onward and the remainder of the file).
- Worker claim gate: an unclaimable canceled job does not execute or refund; a job held by another worker is made recoverable rather than being archived (`apps/server/src/worker.test.ts:236-323`).
- Existing refund replay check: if a refund ledger row is already visible, the worker does not call `refundCredits` (`apps/server/src/worker.test.ts:325-362`).

## Finding: worker refund preflight is not concurrency-safe

Severity: follow-up reliability improvement (not a balance-integrity finding). The database guard prevents duplicate ledger credit, but one worker reports an avoidable duplicate-RPC error.

The added controlled test `exposes the check-then-refund race for a non-zero terminal job` (`apps/server/src/worker.test.ts:364-399`) releases two concurrent calls after both have observed `credit_transactions` with no existing refund. Both then invoke the refund service: the test passes with `refundCredits` called twice, and the test output logs two refund attempts of 5 credits.

The production path does a non-atomic read at `apps/server/src/worker.ts:722-730`, then calls the refund RPC at `:732-740`. Two workers can pass the read before either inserts. The current database migration adds a partial unique index (`supabase/migrations/20260831000002_unique_generation_refund_per_job.sql:1-8`), and the RPC checks the same condition before inserting (`supabase/migrations/20260901000005_harden_credit_business_rules.sql:174-205`). The parent live-DB probe verified four concurrent refunds produce exactly one success, three `23505` duplicate-refund errors, and one refund ledger row; thus no double balance credit was observed. The worker catches and logs the duplicate error (`worker.ts:741` onward), so the remaining issue is clean service-level idempotency/error handling, not proven accounting loss.

This is a finding only; no production fix was made.

## Live WebSocket authorization probe

Command (from `apps/server`, using the retained fixture and local API/Supabase only):

```text
node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/test-ws-isolation-live.ts
```

Result: 7/7 checks passed, classified as 6 isolation checks plus 1 invalid/nonexistent-run-ID check; report written to `artifacts/saas-boundary/ws-isolation-00639b8f-3ee2-4e46-9c91-df007b8647a6.json`. The script obtained fresh JWTs through admin `getUserById` → `generateLink` → `verifyOtp`, but never printed tokens. It performed no provider request and no application-data write. Auth link/session issuance is an auth-side effect and is not represented as `databaseWrites: 0`.

- A can resume its own canvas; B can resume its own canvas.
- A cannot resume B's canvas (and therefore cannot subscribe to B session/canvas events); B cannot resume A's canvas. Both returned `Canvas not found or access denied`.
- The cancellation probe used B's retained `jobId` as the WebSocket `agent.cancel` `runId`; the server returned `Run not found`. This is explicitly an invalid/nonexistent ID check, not evidence of cross-tenant cancellation isolation. The separate root live HTTP probe used a real valid foreign job ID and verified cross-tenant job cancel returns 404.
- Supplying B's fresh token on A's already-authenticated socket returned `authentication_required`; the same socket remained bound to A and could resume A afterward.

## Not established / not tested

- The mock suite's refund test does not establish the real PostgreSQL lock/unique-index behavior. The parent live-DB probe verified one refund ledger row, one balance restoration, and three duplicate `23505` errors under four concurrent refund RPCs.
- No real provider, payment processor, Supabase queue, multi-process worker, network timeout, or provider-side idempotency behavior was exercised.
- The live WebSocket probe used real local auth/API/Supabase services but only terminal retained fixture IDs; it did not create a run, subscribe to a live model stream, or prove cross-process event delivery.
- WebSocket commands carry unique `requestId` values; the probe ignores unrelated stream events and matches request IDs whenever the server response includes one. `canvas.resume` acknowledgements/errors currently omit `requestId`, so those are matched by exact response type/action or exact authorization error text, never by the first arbitrary message.
- The fallback tests are sequential executor retries with mocked provider responses. They prove cancellation checks and retry classification in-process, but do not establish behavior when two independent workers execute the same job simultaneously; worker claim behavior is covered separately by mocks.
- Confirmation tests cover authenticated-turn identity and concurrent calls in one process. They do not substitute for a live multi-user/auth/database race test.

## Files changed

- `apps/server/src/worker.test.ts`: one controlled non-zero refund concurrency test.
- `docs/luna-failure-boundaries-20260911.md`: this evidence report.
