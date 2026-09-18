# Local replica: Agent / Skills / image-job audit

Scope: localhost:3020, API 3002, Supabase 54421 only. No video generation or payment/subscription execution. Existing user canvas and provider configurations were not edited.

## Reproducible integration suite

Run from the repository root:

```powershell
node --env-file=artifacts/local-replica-20260907/app.env scripts/test-local-agent-jobs.mjs
```

The script refuses other Supabase endpoints, creates a fresh isolated user/workspace, uses 30-second request timeouts, and writes sanitized case results to `artifacts/local-replica-20260907/agent-jobs-audit.json`. It never logs credentials or signed URLs. Isolated fixture records are retained as evidence; successful temporary skill and provider CRUD fixtures are removed by their own test cases.

Final rerun after the API restart, including implicit-default compatibility: **12/12 cases passed**. Fixture user: `450dac4b-0b30-4c5b-ab71-9a17ac1338c1`.

### Real HTTP / database / local Storage assertions

- Skills: create with supporting file, retrieve details/files, repeat installation without duplication, disable and verify, enable, update, uninstall, delete, then verify not found.
- Providers: reject HTTP/private endpoint input; create a separate disabled APIYI configuration with a fake key, update/list/delete it; verify the response never contains the key. No provider network test is made using this fake configuration.
- Jobs: valid filtered list; invalid status/type/UUID returns 400 rather than 500.
- Controlled cancellation fixture: create a job record without publishing to the queue, deduct one local credit twice with the same job key, verify a single debit, cancel through HTTP, verify exactly one refund; repeated terminal cancellation cannot refund again, unfinished result cannot be restored.
- Controlled completed-image fixture: upload a tiny PNG to local Storage and create a successful job record. GET refreshes its expired URL and the replacement URL downloads successfully. Restore inserts once; repeating restore returns the same element without duplication. Successful jobs cannot be canceled. A deletion-pending asset cannot be restored (410).
- Cross-user job read/cancel/restore: denied (404); no changes to that job.
- Agent explicit invalid model: rejected before a run is created. The pre-fix reproduction's unexpectedly accepted run was canceled immediately, without starting its stream or invoking a provider.
- Agent empty workspace catalog: the server-configured APIYI default is accepted without an explicit client model. The test cancels the accepted run before streaming, avoiding any provider charge.

Controlled job fixtures test real application/database behavior, **not actual model generation or a live worker crash**. Real model generation is covered separately by the main browser suite.

## Confirmed repairs

1. Job routes formerly passed invalid enums and UUIDs to PostgreSQL, resulting in server errors. They now validate at the HTTP boundary; six regression tests verify no job-service calls occur for invalid inputs.
2. A client could supply an arbitrary Agent model and receive acceptance; legacy-provider fallback could then silently choose a different model. HTTP and WebSocket now validate explicit overrides against the configured server default or an available workspace text model. A server-configured APIYI environment default is retained by both transports when the workspace catalog is empty. Disabled/missing workspace defaults are rejected, including when the client explicitly names that default; there is no silent fallback to another workspace model. Regression assertions cover all these boundaries.

## Automated checks

Agent confirmation gating, durable proposal replay, billing passthrough, checkpoint repair, job restoration/service, provider snapshots/configuration/catalog, skill import boundaries, run metadata history, WebSocket authorization/retry/ACK, and the new parameter/model tests were run. These are unit/controlled tests, not claims that every corresponding external workflow was exercised. Server TypeScript validation passed.

## Remaining limitations

- No exhaustive visual/design quality evaluation of every built-in Skill.
- No genuine upstream timeout/cancellation race or deliberate Worker crash while a paid provider is executing.
- No real external skill package import or new-provider authentication/model-discovery call; security/contract paths are unit-tested, and provider CRUD uses a disabled fixture.
- Cancellation of an already terminal job currently returns 404; retry safety is verified, but the endpoint was not redesigned to return a replayed success response.
