# Completed split progress placeholder recovery

The semantic split finalizer intentionally skipped replacing the original image, but also skipped retiring the separately created progress rectangle. Job `f29fdf71-cd5e-43c6-a57c-fe279d54fead` was already succeeded/finalized while placeholder `4ffpyf84doajcvdl9gku` remained generating.

The finalizer now tombstones only the matching job-owned placeholder after all layer insertions succeed. Source images and other jobs cannot match the cleanup guard. Canvas writes use the existing compare-and-swap retry mechanism. A completedJobId marker prevents stale higher-version browser saves from resurrecting completed progress; browser merging accepts that authoritative marker without repeatedly increasing versions. Partial layer delivery alone does not count as completion.

The existing placeholder was repaired using `scripts/repair-completed-split-placeholder.mts`. Before/after verification confirmed every other element and all image file records unchanged, including the user's prior deletion of one layer. Backup and report are under `artifacts/split-placeholder-recovery-20260915`.

Validation: 48 backend tests, 12 frontend merge tests, server typecheck, and production build passed. The build uses the repository's existing skip-typecheck setting. A separate authenticated browser opened the current canvas with zero page errors, zero failed requests, and zero image-generation submissions; its seven live image elements include the source and retained results, with no live progress rectangle. No paid regeneration was performed.

Served build: `.next-production-split-placeholder`. API PID 34256, worker PID 18864, web PID 40076 at acceptance. Main handled backend cleanup, existing-data repair, and integration acceptance; Terra (medium) handled frontend merge behavior.
