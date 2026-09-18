# Nonstandard image size recovery

## Observed failure

The screenshot corresponds to session `fa187e47-6679-4803-8a78-1acb47daf45a`, run `8f595718-f837-4061-bd4a-aa87310cc437`. The newer ambient browser session is a different session.

Persisted tool executions show `list_skills`, discovery of image-review/history tools, a failed empty image review, and `edit_image`; there is no `use_skill` execution. The image tool queued job `b6739765-ee0d-4f20-af0c-615eac4c496b` with unsupported 656:176. Saying the skill would be loaded did not load it. Skill version 1.0 also explicitly excluded ratios outside 1:3–3:1, so loading that version alone would not have generated an approximate replacement.

## Scoped behavior

Version 1.1 adds a supported approximate path. Keep target pixels; double small targets until native minimum area and edges are met to establish a scale reference; choose the closest legal ratio and resolve the native size within the requested resolution tier. Doubling does not change aspect ratio or upgrade quality/resolution. Ordinary generation retains its strict native resolver.

For 656×176 at default Low + 1K:

| Stage | Dimensions |
| --- | --- |
| Original target | 656×176 |
| First doubling | 1312×352 |
| Minimum-area doubling reference | 2624×704 |
| Nearest legal ratio | 3:1 |
| Planned native request | 1776×592 |

The planned ratio differs from the original by about 19.5%. The doubled reference is not a promised output size; provider results require a separate actual-dimensions check. No cropping, stretching, or board writes are part of this path.

The approximation must have a real skill-read receipt and current approximate-size authorization. Listing skills or supplying the skill name as a tool argument does not grant this path. Manual UI ratio remains authoritative. Raw unsupported ratios fail before job submission instead of creating a doomed image job.

## Verification

The isolated planner and unchanged native resolver pass 13 tests, including wide/tall boundaries, custom ratios, default and explicit tiers, and invalid dimensions. The backend agent ran 83 targeted cases across five files and server typecheck successfully. Main integration reran the four directly affected test files: 63/63 passed (a subset, not 63 additional cases). The skill catalog passed 12 tests.

Tests exercise actual Mastra generate/edit tools with a mocked submitter, including the reported published gpt-image-2.5-flare path. The real Mastra SDK bridge with synthetic model transport and actual workspace skill tools proves that list_skills alone does not grant the marker and a successful use_skill does. These are not a new paid image-provider generation.

Applied additive migration `20260915000004_nonstandard_image_size_approximation`; unrelated skill contents and installation-state checksums remained unchanged. After restarting the local API and worker, authenticated workspace readiness returned nonstandard-image-size 1.1.0, enabled and ready, with the published flare model. API health returned 200. API PID 11716; worker PID 25108. No frontend rebuild was required.

Implementation split: Sol (high) handled native preflight and the Agent receipt/normalization path. Main handled skill content, isolated planning helper, catalog migration, integration review/tests, and local service acceptance.
