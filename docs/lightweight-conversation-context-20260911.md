# Lightweight conversation context

## Implemented scope

- Original graph and database history remain intact. Model requests use a bounded projection instead of pinning every historical user message.
- Keep up to four recent complete conversation groups and eight complete recent user messages within the available budget. Pending tool calls stay paired with results.
- Validated historical summaries retain up to twelve facts and twelve unresolved items, with source references. Append-only updates summarize the delta instead of repeatedly summarizing the full history. History edits and authorization changes invalidate stale projections.
- Summary recovery is capped at three calls. Recoverable truncation/format errors can fall back to an opaque source index for complete historical tool exchanges; no unvalidated facts are reused. Epoch, permission, source-integrity, and cancellation failures still stop. Active task mode additionally requires an independently projected durable intent for this fallback.
- Summary reserve matches its 6k output allowance. The final loaded-tool packet is remeasured; excessive summary records are projected out whole with source/hash retrieval markers.
- Intent prompts use a bounded brief/goal/correction projection; write guards still receive authoritative full state. Summaries do not confer permission to generate or modify anything.
- Passive canvas image metadata is deduplicated and capped at ten candidates. Selected images take priority, then reverse scene order (an approximation of recency, not semantic relevance). Names, titles, and roles are bounded. Three candidates are marked eligible for optional vision input; this does not automatically load three images. Explicit user attachments retain their existing path.
- Ordinary image draft/confirmation no longer requires a separate `update_design_brief` call. Live scope, unresolved questions, intent review, confirmation, and payment protections remain in place.
- Brief and verification schemas are demand-loaded, not unconditional core tools.

## Verification

- Root final integration: 170 tests passed across 15 test files, including context compaction, fixed overhead, intent projection, design tools, demand loading, passive images, runtime canvas context, intent write middleware, budget, runtime recovery, and context persistence.
- Server TypeScript check passed.
- Synthetic 100/1000-round bounded packets: 5,271/5,277 conservative tokens; eight retained user messages; summary size 2,157/2,174 bytes. These are isolated compactor fixtures, not production all-in token measurements.
- After real QA exposed remaining overhead, the prepared-agent fixed first packet fixture fell from 28,148 to 14,784 conservative tokens, including 1,219 for three tool schemas. Provider tokenization may differ; no arbitrary multiplier was applied to the estimator.

### Issues found by live acceptance, not hidden by unit tests

- Run `4efcdaa7-c620-44c4-81fc-56ec8f3e5652` correctly recalled `aaaa.com`, 3D wordmark, no balls, and changed 1:1 to 4:5 without generating.
- The next draft update, `c9e51ce8-e099-44c4-94c1-6dd687a24114`, still failed at 41,013 estimated tokens. This exposed a 2,000-token summary headroom versus a 6,000-token summary allowance, requiring final-packet adaptive projection and additional fixed-prompt reduction.
- Run `f30f5a5d-2500-4ff1-8643-b0a7b1789766` in the 100+ round QA conversation read canvas/proposal/history but failed after repeated summary truncation. This exposed excessive recovery latency and the need for a provenance-only fallback for completed historical exchanges.
- Both failures created zero image jobs.

### Successful live retests

- Draft retest `86f3f9b2-b65b-4d43-990e-3c44a06b3a50`: read previous proposal and saved revised 4:5 draft. Database proposal is pending, text still specifies `aaaa.com`, 3D lettering and no balls. Zero image jobs. Loaded-tool request measured 28,539 conservative tokens.
- Long conversation turn 110, run `e0498401-402f-4edb-b43e-0e793c210028`: completed in about 53 seconds with thirteen read-only tool calls. Correctly recovered 澄屿 / CHENGDAO / 山岚 / 无糖，也有回甘, poster 4:5 versus membership card 3:2, and separate content constraints. Zero image jobs. Snapshot estimates ranged from 19,132 to 33,236.
- These are real-provider dialogue/draft tests, not 110 freshly paid turns in this change. The fixture already contained its earlier long conversation and two generated images. No new image-generation quality/visual acceptance is claimed.
- Final API reload included the active-task fallback compatibility case; health and TypeScript checks passed. User artwork was not modified.

## Review ownership

Sol / high implemented bounded history, intent projection, fixed-prompt reduction and summary recovery. Terra / medium implemented passive image selection and metadata bounds. Root integrated ordinary draft flow, demand-loading changes, regression verification, deployment and live QA.

## Limits

This prevents ordinary history growth from accumulating indefinitely in each model request. It is not a guarantee of infinite perfect recall or zero provider failures. An individually oversized current request or indispensable tool payload can still exceed the budget. Missing or ambiguous historical evidence must be retrieved or clarified, not guessed. Automatic image generation and unattended execution were not reintroduced.
