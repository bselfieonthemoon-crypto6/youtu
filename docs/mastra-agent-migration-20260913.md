# Mastra conversational agent migration — 2026-09-13

## Scope and rollout

This replaces the conversational orchestration, not the model gateway, account system, canvas editor or image worker. The new path is entered before legacy task planning, image proposal approval, unattended continuation and phrase-confirmation middleware.

- Framework: `@mastra/core@1.66.0`, OpenAI-compatible provider adapter `@ai-sdk/openai-compatible@3.0.48`.
- Source-only pre-migration backup: `E:/Loomic-backup-before-mastra-20260913/source-only.zip` (1,487 files; ZIP entries verified against source hashes). No runtime/dependencies/databases/media were backed up.
- Local API launcher selects Mastra and only Mastra: `scripts/start-local-api.ps1` accepts `-AgentRuntime mastra` via `[ValidateSet('mastra')]`. The legacy runtime is retired.
- All deployments run Mastra. `LOOMIC_AGENT_RUNTIME` is optional and may only be unset or `mastra`; `legacy` (or any other value) now fails fast at startup (`resolveAgentRuntimeMode`). No remote environment or third-party channel configuration was modified.
- Additive migrations applied to **local replica only**: `20260913000010`, `20260913000011`, `20260913000012`.
- Do not delete legacy code/database records as part of rollback. Existing conversation and artifact history remains in the same tables.

## Preserved boundaries

- Model configuration is read from the current workspace's published, connection-tested catalog and frozen provider snapshots, not a hardcoded Gemini/OpenAI environment fallback.
- Ordinary semantic dialogue uses a compact system instruction, bounded historical facts/recent messages, and lazy tool discovery. Skills and prompt-library references are loaded on demand.
- Authenticated user/workspace/session/canvas scope, asset access, design revisions, billing, durable job receipts, cancellation and finalizer checks remain server-owned.
- A failed request does not invalidate the conversation. Uncertain submission outcomes keep their job identity and must not cause another paid submission. Explicit later user retries create a new turn.
- `generate_image` creates an independent image; `edit_image` carries 1–14 authenticated source assets. Both share per-turn unknown-submission state.
- Native board creation uses a task-free transaction and readback. Image placement reuses the existing design finalizer rather than creating a second mutation mechanism.
- A unique upstream model name or display name is mapped to its published workspace ID; unknown/ambiguous explicit names no longer silently become the first catalog entry. Manual UI choice remains primary.
- Source grounding can repair an independent tool proposal into a source-bound submission using scoped, authenticated image candidates. Explicit native-design sources use the same asset/lineage checks without an additional intent-model call. Source candidates use a separate bounded list of the last ten successful jobs, so a few failed retries do not erase the prior deliverable.
- Actual submitted model and ratio are projected into result receipts/status reads. The assistant must not infer the actual channel from the user's requested model.

## Real browser acceptance ledger

Dedicated QA canvas `91e19c4f-3d7c-4c86-9e49-7a44215ebc4f`, session `a32331a7-050f-46c6-bc24-1f6b79badc5f`. The user's original conversation was not used for testing. Evidence files live under `artifacts/paid-dialogue-live/browser-turns/` and screenshots under `artifacts/paid-dialogue-browser/`.

| Scenario | Result/evidence |
| --- | --- |
| Incomplete logo request; explicitly do not generate | PASS: `ce2422d2-e7ee-45c3-bb81-ee09b835fc47`; clarification streamed, no image job. Screenshot was captured before the final text delta. |
| Full brief plus typo confirmation | Initial failure: ordinary-user RLS cannot read `agent_runs`. Fixed with a server-owned run lookup that still verifies owner/session/status. |
| Same conversation, explicit retry after failure | PASS: run `a688c4da-0205-44cc-862c-4136752fcc06`, job `18f28d69-8dca-4dfe-877d-8a723d406298`, decoded 1024×1024 MOSS COFFEE logo in chat/canvas after reload. |
| Continue modifying a previous logo | Initial failure: job `f7134b54-8d5a-445c-a6da-fe7c7788066c` used no source. Not counted as a source-based edit pass. |
| Tool schema compatibility | Initial failure: run `52801990-5433-4775-9731-cd5b50a1ef68` failed before model execution due to a shared Zod3 target nested inside native Zod4. Fixed; complete mixed-version tool inventory now has a real SDK/DeepSeek-named synthetic-transport regression. |
| Retry source-based edit after correction | PASS: run `871ad7b5-f4fd-48cf-bb14-c4df6970d2ff`, job `43ba1e65-c347-4411-b0f9-255e76ef59f8`. One actual source `417bdec2-a013-4588-8621-0c9341188d76`; delivered dual-leaf logo with preserved wordmark/colors. |
| Create an empty editable native board without generating | PASS: run `508eadfc-3ead-4c2f-9769-c5b46e734c98`; design `8340794c-73df-44bb-83c2-f9575c21f925`, 1080×1440, revision 0, visible after reload. No legacy `agent_design_tasks` rows were created for this QA session. |
| Consult skill catalog/prompt library without generating | PASS for discovery only: run `54e32e6e-d2ef-4223-980c-a4e521f398b0`; `list_skills` and `search_prompt_library`, no new image. This is not claimed as reading the full skill guide. |
| Read campaign guide and generate into the native board | NOT PASSED: run `a26c1f18-005d-4019-9252-4d31b861e334` loaded the guide after correcting output-kind selection. Job `4cb82aca-e55b-46a1-851d-f520d20d9475` reached the design-target worker but Nano returned 1024×1024 for 3:4; existing pixel validation stopped publication. It also omitted the requested logo reference. Both issues are recorded separately. |
| Explicit GPT Image 2 retry with real logo source | Initial failure: run `0085e2a3-49ec-43f0-9f99-8c9af719dfd3`, job `7df9018d-5c5d-46fd-a452-a9494e642013`, input_images=1. The tool proposed `gpt-image-2`, but the reused resolver silently chose the first workspace ID (Nano). Fixed in the native model adapter; this failure is not attributed to GPT. |
| Ask failure cause without generating | Partial: run `d71fcabb-93a2-4b00-bca7-3f9e6c02d065` correctly distinguished pixel-size rejection from no provider output, with no new job. It incorrectly claimed GPT was actually used. Added actual-model projections and evidence-only instructions; the initial answer is not counted as a full pass. |
| Retry the native poster after model-alias correction | PASS for paid generation, source binding and persisted native delivery: run `18860a2f-f41a-4734-8eb8-44ce7c0e8f77`, job `ded61ada-06f7-4cfa-b95c-e0f7ecc4cd20`. Actual GPT Image 2 workspace alias `29a0cb35-0794-4239-9a95-948c8cf93705`; one real source; 1536×2048 output; native document advanced to revision 1. Reload screenshot visually verified the double-leaf MOSS poster. Initial no-reload DOM assertion failed because the board was offscreen and overlays are intentionally culled; fixed the test to fit the viewport without reloading before assertion. This initial run alone is not a no-reload preview pass. |
| Edit the native poster to NOW OPEN | PASS for source-bound image generation and replacement: run `34b2c1ae-85dd-46c2-8f43-55e1d9c03f20`, job `aec95ef8-6591-4177-9761-f3add1076d1f`, source asset `ac710f61-fda3-42f5-8871-3d0bfc0a5574`. One new job, same design, revision 2. The first live assertion incorrectly accepted a still-decoded old preview while “preview pending” was visible; tightened it to require a changed image source and no stale-preview hint. Do not count this screenshot alone as updated-preview acceptance. |
| Continue editing NOW OPEN to OPEN DAILY | Initial failure: run `cb3f564e-83a7-4dec-93fb-4d1bb9f5b8b4` put the design object ID into `source_asset_object_id`. Pre-submit target validation rejected it, but the adapter incorrectly reported an unknown submission and stopped recovery. No new image job was created. Fixed strict same-object normalization and submission-stage error classification: after a successful no-prior lookup, failures before durable create are not submitted; once create starts, uncertainty remains protected. |
| Recheck actual failed model after receipt projection repair | PASS: run `3e742ecf-b2b6-4b81-9fa0-30b2d95405a4` correctly identified failed job `7df9018d` as Nano, distinguished actual square output from the requested 3:4, and identified the later successful GPT jobs. No new image job or cancellation. Explicit job references are resolved with current-user scope, including older receipts outside the latest three. |
| Retry OPEN DAILY after target/preflight repair, including live preview | PASS: run `1312e00f-f051-45e9-b320-7d777a00c529`, exactly one job `cff667ce-40ab-412f-9ebe-ae3381d05cc6`, true source `73464c2b-9f24-4f27-a249-2ae6023b8694`, GPT Image 2, 1536×2048. Same native design advanced to document/preview revision 3/3 with one scene object, not a new board or duplicate layer. Without reloading, the preview image source changed from the pre-submit baseline and the stale indicator disappeared. Screenshot `artifacts/paid-dialogue-live/2026-09-13T05-16-39-681Z-live-delivery.png` was visually checked: OPEN DAILY, retained double-leaf logo, cream/navy design. A normal follow-up diagnostic conversation also completed while this image job was processing. |

Reload inspection decoded the three successful logos. Two older signed-image URLs initially raised `ERR_BLOCKED_BY_ORB`, followed by successful image hydration; this is not reported as a zero-network-error pass.

## Validation boundaries

Unit tests, synthetic SSE/SDK tests and TypeScript checks complement—not replace—real browser/provider acceptance. Nine-reference and long-history tests are synthetic unless explicitly listed otherwise above. No claim is made about unlimited conversation turns, every provider, every multi-tenant race or zero future bugs.

The real browser runs used the isolated local replica and real third-party generation channels. Its existing commercial-enforcement setting is disabled, so local credit charges of zero do not verify production SaaS debit/refund behavior; billing concurrency and uncertain-outcome cases here have targeted automated checks, not a paid production multi-user acceptance claim.

Nano Banana non-square delivery failure was also recorded before this migration in `docs/agent-dialogue-acceptance-20260911-luna.md`. Passing with another model does not fix or validate that gateway's Nano route.

Latest unified checks: `vitest run mastra` passed **17 files / 124 tests**; chat generation presentation passed **13 tests**. Server and web TypeScript checks passed. Target normalization/submission-stage suites also passed (overlap with these tests is not added to the unique total). SDK/structured-output cases use synthetic transport and are not additional paid end-to-end turns.

Video compatibility is registered from the live workspace catalog, with no old environment-provider fallback. It has focused tests but no real paid video acceptance in this migration. Existing limitations remain: after the ten-minute foreground wait there is no durable video-to-canvas auto-finalizer; transient canvas insertion failure also lacks automatic durable recovery. No claim of complete video closure is made.

## Handoff

The local application is running the Mastra entry; the core image dialogue acceptance path above passed with real third-party requests. This is not a claim that all tools/providers are seamlessly equivalent: Nano non-square output remains a known failure, video is not fully accepted, and many-reference/very-long-history/multi-user production billing runs remain uncovered. Some assistant replies are still overly verbose with internal IDs, and tool discovery/argument mistakes can still be corrected within a turn; these usability issues are not hidden by the successful delivery verdict. Legacy runtime remains available for explicit rollback; no remote rollout was performed.

Implementation used Sol (high) for runtime, durable submission and permission/integration review, and Terra (medium) for tool adapters and focused tests. The parent did integration and real browser acceptance. One earlier child model label was inconsistent in prior records; no Astra execution is claimed for this migration.

OpenAI Docs skill was used to review [OpenAI agent orchestration guidance](https://developers.openai.com/api/docs/guides/agents/orchestration), together with [Mastra agent documentation](https://mastra.ai/docs/agents/overview) and [streaming API](https://mastra.ai/reference/streaming/agents/stream). These are implementation references, not a certification or guarantee of application correctness.
