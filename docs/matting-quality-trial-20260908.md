# Matting quality trial — 2026-09-08

## Scope and evidence

Read-only exports from two real local canvas jobs:

- `b968698e-81b0-4894-a862-fbfac142af04`: 1024×1024 black-background NPR/580 logo, remove-background result.
- `51d7f3bb-0cb3-4d81-83f8-28609c6db0ef`: 719×1280 green promotional poster, recomposed non-background split-layer results.

Originals, baseline results, source hashes, and review sheets are in
`artifacts/matting-quality-20260908/`. No source images were uploaded to a new
external service. No user canvas, job, model configuration, or subscription was
changed. Scripts only export local data and run an offline colour experiment.

## Observations (visual, not ground-truth accuracy scores)

- Logo: substantial black background remains as a cloudy alpha region. Letter
  edges and the `.com` area become partly transparent. These defects are visible
  on white and blue inspection backgrounds; a black background conceals them.
- Poster: the baseline preserves the bottom characters, while text and many
  decorative elements are omitted. This may suit “extract the characters” but
  not “keep all design elements and remove only the background”. The intent must
  be made explicit in the UI and editable selection/mask.
- The raw logo already contains transparent corners. Any new algorithm should
  preserve existing transparency and must not make transparent pixels opaque.

## Offline solid-colour candidate

Tested border-connected colour removal at tolerances 12, 24, and 40. It keeps
source RGB and bounds removal to background-coloured connected regions instead
of globally deleting a colour. Runtime was approximately 0.15–0.20 seconds on
this single logo, including PNG output; this is not an application latency SLA.

Larger tolerances clear the broad background but erode dark outline details.
Some detached corner outlines remain. This candidate is **not approved for
automatic/default use**. Potential future UI: explicit background-colour mode
with tolerance preview, keep/remove brushes and reversible confirmation.

## Precision-model comparison — completed with an approved maintenance window

Candidate: official `ZhengPeng7/BiRefNet_dynamic-matting`:
https://huggingface.co/ZhengPeng7/BiRefNet_dynamic-matting

Pinned revision: `074df545be87034e74a96bf71566ecbbc4c15f0a`. Downloaded to a separate
ignored benchmark directory; reviewed its loader/configuration, then ran local
offline inference. No dependencies or default model settings were replaced.

The user approved temporarily pausing the local background worker. Queued and
running jobs were checked (zero) before pause. The API stayed available. A
watchdog enforced a 10-minute limit and a low-memory cutoff; `finally` restarted
the worker. The precision process completed normally and exited.

CPU float32, two threads, maximum inference edge 1024 (not a 2K trial):

| Sample | Model input | Output | Inference/output time |
| --- | --- | --- | --- |
| Logo | 1024×1024 | 1024×1024 | 36.0 s |
| Poster | 576×1024 | 719×1280 | 18.8 s |

Checkpoint loading took 5.4 s, excluding Python imports. Source RGB was retained;
the proposed output also preserves existing transparency. Raw model alpha
outputs were saved separately. There are no hand-labelled accuracy scores.

For a like-operation control, both original samples were also rerun with the
current worker's `make_cutout`, without split-layer component filtering. The
current model uses its existing 1024-square preprocessor; the candidate keeps
aspect ratio rounded to 32-pixel multiples. This compares complete candidate
pipelines, not an experiment isolating weight changes from preprocessing.

Results in `controlled-model-comparison.png`:

- Logo: the precision model retains almost the entire black badge. It does
  **not** meet the intended background-removal goal and is not a suitable
  universal replacement.
- Poster: more of the bottom coins/foreground composition remains, but text
  and upper decorations are still discarded. Whether keeping the coins is
  desirable depends on the requested foreground.
- Conclusion: do not switch the default. Add explicit foreground intent and
  reversible keep/remove correction before promising robust design-asset matting.

Restoration checks: local API health HTTP 200; restored worker PID 29160; real
isolated transparent-erase job `30090760-cf77-4efa-b511-760cbca1d68d` succeeded
(128×128 PNG, 2.15 s, unmasked pixels unchanged). Four historical canvas-recovery
failures also appear in the restarted worker log; the same failures were present
in the pre-maintenance worker log. These unrelated failures were not modified.

## Acceptance before enabling a new mode

1. Same original pixels and explicit foreground intent across candidates.
2. Inspect on white, black and coloured backgrounds at 100% source resolution.
3. Verify lettering, fine lines, holes, glow, and original transparency.
4. Record memory, duration, failures and model revision alongside results.
5. Keep the current route available; introduce a candidate only after review.
6. Do not infer semantic design layers from connected-component counts.
