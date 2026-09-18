# Worker recovery boundary test (2026-09-11)

## Scope

Added `apps/server/src/worker-recovery-boundary.test.ts`. It calls the real exported `processMessage` path and registers an executor that performs observable mock-provider side effects. It does not start a server/worker, access the running API on 22328 or worker 19404, publish to a queue, call an external provider, or touch user data.

## New evidence

1. A duplicate delivery while the first worker's durable lease is fresh is deferred (`setVt`) and does not enter the executor.
2. At 31 minutes (strictly older than the current `started_at < now() - interval '30 minutes'` predicate), a second worker can claim the same still-running job while the first executor call is unresolved—*if a message is available to be read*. In production, the normal video executor renews VT to 300 seconds every 120 seconds; therefore this is not an assertion that a healthy worker inevitably duplicates after 30 minutes. The controlled executor was entered twice (`t=0`, `t=1,860,000ms`), and both messages completed. This demonstrates generic worker re-entry only; it is not evidence of a real provider duplicate or billing outcome.
3. A controlled executor that throws `image_generation_result_unknown` is dead-lettered and archived after one execution. This verifies the worker error-handling branch only, not provider-side acceptance or idempotency.

## Verification

Command:

```text
pnpm --filter @loomic/server test -- worker-recovery-boundary.test.ts
```

Result: 2 tests passed. The first test intentionally makes the current lease behavior observable; it is not evidence that an external provider request is idempotent.

## Not verified

- No live Postgres/PGMQ lease or visibility timeout was exercised.
- No crash/kill of a real worker was performed.
- Provider-side idempotency, billing, and eventual result lookup remain unverified.
- The video executor delegates to `generateVideo` and renews VT periodically; the re-entry precondition is VT-renew failure/expiry or a separate duplicate queue message. No provider call was made, and no provider-side idempotency or billing claim is made.
- The image executor has durable checkpoint paths, so this generic double-entry test must not be interpreted as proof of duplicate GPT-image charging.
- The 30-minute durable lease has no heartbeat/owner token in the tested path, so this test reports potential generic executor re-entry rather than asserting a paid duplicate.
