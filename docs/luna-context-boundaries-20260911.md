# Context and active-skill boundary QA (2026-09-11)

This note records offline, deterministic regression checks. No provider/model request, database write, or image-understanding request was made.

## Verified in this run

Command:

```text
pnpm exec vitest run apps/server/src/agent/active-skill-guidance.test.ts apps/server/src/agent/context-budget.test.ts apps/server/src/agent/context-compaction.test.ts --config apps/server/vitest.config.ts
```

Baseline before the new active-skill cases: 3 files / 59 tests passed. The added interleaving and hostile-guide cases were then run with the same suite: 3 files / 61 tests passed.

- The lean offline estimator charges nine explicit image references at `9 * 8192` image tokens and accepts the packet under the 128K input ceiling. This is a conservative budget assertion, not proof that a visual provider can understand nine images.
- The compactor bounds a 1,000-round text/tool history to fewer than 40 projected messages and retains the latest user content and matched tool-call/result pairs. A mixed 1,000-round image fixture projects to 23 messages; a dense 1,000-image fixture is explicitly reported as over-sized before projection and is never sent to a provider.
- Two interleaved scope keys (`session-a` and `session-b`) retain only their own active skill packet. The current user message remains present in each packet.
- A hostile skill body is retained only as method data with `authority: method_suggestions_only`; the trusted system text explicitly denies changing goal, permissions, confirmation, cost, or execution state, and the hostile text is not promoted into the system message.

## Boundary interpretation

These tests prove local projection, accounting, scope matching, and authority labeling. They do not prove visual quality, provider acceptance, unlimited conversation length, or cross-process/session persistence. Real multi-tenant/API and job cancellation/charging checks remain separate.

