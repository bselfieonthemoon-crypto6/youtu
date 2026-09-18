# Native board creation verification

## Implementation

`create_design_boards` is registered for authenticated fresh runs. Runtime injects
the creation service with the original user prompt and attachment IDs. Migration
`20260910000008` atomically creates native design documents, canvas nodes and task
bindings, with canvas revision checks, tenant authorization and replay protection.

After commit, runtime binds the task and reads back document dimensions and node
placement. The old unscoped graph cannot perform further writes after creation,
including a committed creation whose verification failed. A `canvas.sync` event
asks the client to reload persisted canvas content.

This is a native blank-board path, not an image-generation workaround. Composite
design work must use a newly scoped task graph for subsequent writes.

## Evidence

- TypeScript server check passed.
- Root focused regression: 27 tests across 6 files passed.
- Integration agent also ran 108 intent gate/middleware tests successfully.
- `node scripts/test-agent-design-creation-local.mjs`: real PostgreSQL transaction
  passed dimensions, task/node binding, revision conflicts, idempotent replay,
  cross-user denial and failed-batch rollback. Test writes rolled back.
- Local migration 08 applied through `scripts/apply-local-agent-autonomy.mjs`.
- `apps/web/scripts/check-native-board-creation.mjs`: real RPC and production
  browser reload passed, one 658 x 176 native document, zero provider calls.
- Browser evidence: `artifacts/native-board-creation/refresh.png`.

Real model/Agent verification is performed separately by
`apps/web/scripts/check-native-board-agent.mjs --submit`; mocked tests and direct
RPC tests must not be reported as a real model pass.

## Defects found by real-model verification

- First live run read the canvas but did not create it. `inspect_canvas` exposed
  only a scene hash, not the integer DB revision required by creation. Added
  `canvas_revision` without changing the existing pagination fingerprint.
- Second live run attempted creation but the intent evidence loader rejected a
  valid newly initialized canvas (`content = {}`). This is a real application
  defect, not evidence that the user must refresh or clarify the already explicit
  request. The live test correctly rejected the nominal completed run.

Both defects are fixed. Missing `elements` is accepted for an empty canvas;
malformed non-array values are still rejected. Creation/layout observations use
the database revision; other scene-write observations retain their existing hash.

## Final live acceptance

- API restarted with current code, PID 25432; health passed.
- Real Agent test passed: canvas `7ec83395-12dd-47cb-a960-1c507dc59a89`,
  session `b0a47097-330f-481c-bfb9-3fd9e070b813`.
  Tools: inspect_canvas -> create_design_boards -> inspect_design.
  One 658 x 176 document, canvas.sync delivered, browser reload preserved it,
  zero image/video jobs.
- Real production-browser send test passed without refreshing first:
  canvas `b829d350-4bb7-4c56-beea-02540864d04f`,
  session `5cfb5ebb-f1d9-429a-b2cf-8a040a7a067b`.
  One visible board, exact DB dimensions, reload passed, run completed and zero
  background jobs (also checked after browser close).
- Screenshot: `artifacts/native-board-creation/browser-live.png`.
- Final TypeScript check passed. Inspector regression: 4/4; subsequent intent
  evidence/gate/middleware/runtime regression: 123/123 passed.

QA fixtures are isolated and retained. User artwork was not modified. This
acceptance covers native blank-board creation, not all autonomous design flows.
