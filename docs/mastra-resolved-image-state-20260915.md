# Mastra resolved image framing

The native image tool resolves the current request once and carries its framing authority through source grounding. Grounding updates the final usage and rechecks model compatibility without rerunning ratio normalization from raw model arguments.

`mastra-image-ratio-state.ts` records usage, frame intent, ratio origin, and the loaded/current approximation authorization and original target. Independent output and source-bound framing choices are derived during that initial resolution. Editing preserves authenticated source dimensions unless the UI or current output request authorizes resizing. Model `resize` hints alone do not authorize a framing change. Descriptions of a source's ratio are excluded from output requests.

Explicit UI precedence, implicit editing/reference support, multiple explicit outputs, Auto model reselection, Low/1K defaults, unknown submission receipts and skill receipt scope remain covered. Skill approximation retains the original target for the doubled planning reference, including already legal custom ratios.

This change stays inside the native tool and its helper/tests. Job payloads, database schema, credit submission, confirmation policy, status permissions, worker checkpoints, legacy ratio normalization and write self-repair were not changed.

Sol (high) implemented the state refactor and tool regressions. Main reviewed the source/output distinction and ran integration acceptance. Provider submission is mocked in these checks; no paid generation is needed for this internal refactor.

An additional legacy `image-proposal-skill-semantics.integration.test.ts` run reported three skill composition conflicts before image tools were invoked. Main subsequently independently reproduced all three and confirmed the same failures with both changed native-image production modules forbidden from loading. The blocking reason is missing scoped `edit_image`, yielding `skill_unavailable`. No authentic pre-change snapshot was available; historical baseline failure is not claimed. See `skill-semantics-conflict-reproduction-20260915.md`. These failures are not included as passing checks.

Final acceptance: 110 unique tests passed across native tool (41), resolved ratio state (5), nonstandard approximation (12), source grounding (14), durable image jobs (18), Mastra Agent (14), and legacy native preflight (6). Server typecheck passed. API restarted with the local replica configuration as PID 20508 after confirming no queued/running background jobs and no recent active Agent run; the one historical stale run was left intact. API and web health returned HTTP 200.
