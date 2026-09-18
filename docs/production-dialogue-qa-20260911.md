# Real dialogue and image QA — 2026-09-11

## Scope and evidence

Normal API/WebSocket dialogue path with real third-party models; no mocked image completion and no direct proposal/job insertion. Separate QA project; existing user artwork untouched.

- Text model: deepseek-v4-flash-vision-exp.
- Image model: gpt-image-2, workspace:29a0cb35-0794-4239-9a95-948c8cf93705.
- Canvas: 51deede3-b8b6-4a19-8a53-78ed36b4e7b3.
- Session: 11e0af83-c478-424b-98ac-da9223aecacc.
- Full sanitized run manifest: artifacts/paid-dialogue-live/qa-production-series-20260911.json.
- Nine user turns completed at transport/run level. Two confirmation turns were application failures despite run status completed.
- Exactly two image jobs succeeded. No active job remained at final check.

## Results

| Turn | Request | Result |
|---|---|---|
| 1 | Vague tea-brand Logo request | Asked for brand name; no image job |
| 2 | Brand 澄屿 CHENGDAO, leaf/wave, blue/cream, no cup, 1:1; draft only | Saved plan; no job before confirmation |
| 3 | 确认生成 | One confirmation, one successful job; 2048x2048 |
| 4 | Same-series 山岚 poster, 无糖也有回甘, 4:5, reference previous Logo | Saved plan with actual first asset reference; no premature job |
| 5 | 确认生成 | One successful job; 1632x2048, approximate 4:5 due to output sizing |
| 6 | Only change 山岚 to 晚晴; draft first | Saved pending plan referencing latest poster, preserving other constraints |
| 7 | 确认，按这次修改生成。 | FAIL: internal review receipt; no image job |
| 8 | 确认生成 | FAIL: same receipt; no image job; pending plan still exists and is unexpired |
| 9 | Stop generating; recap current requirements and differences | No tools/jobs; remembers current/old title and constraints. Incorrectly describes plan as unsaved |

## Confirmed defects / limitations

1. Edited-plan confirmation fails for both natural and fixed confirmation wording. This is before third-party submission, not an image-provider failure. Failed runs: 9d5f53d0-7513-4e85-bcd4-e3dc669fe865 and 2c216043-4e44-4e70-8ae7-d761889ec42d. Pending proposal: 92e3b041-9b83-4f35-b5eb-285a97d4501b. Do not mark this flow passed.
2. Generic drafting failure receipt leaks into later dialogue: assistant claims the plan was not saved, but the existing pending proposal is persisted. Distinguish previous saved plan from a newly blocked tool call.
3. Same-series plan took approximately 92 seconds; functional success is not a latency acceptance.
4. Local approved cost was zero and balance stayed 550. This does not establish third-party cost or validate nonzero debit/refund accounting.

## UI verification

### Read-only root-cause audit

Sol verified that both SQL confirmation/decision classifiers return false for `确认，按这次修改生成。`, but true for `确认生成`. The proposal lookup treats the unrecognized confirmation as an intervening new requirement, hides the saved pending proposal, and continues to hide it on the next fixed confirmation. The agent then attempts to draft again; the write reviewer fails with `classification=invalid_output`, `finishReason=length`, `retryCount=1`, so the handler never submits a job. This is a classifier/scope error followed by reviewer-output failure, not a provider rejection.

Relevant paths: agent/image-confirmation-authorization.ts; agent/runtime.ts confirmation fast path; image-proposal-store.ts current-proposal RPC; SQL loomic_get_current_image_proposal; agent/intent-write-middleware.ts; agent/intent-write-gate.ts. Repair should unify confirmation semantics and prevent a misclassified confirmation from permanently hiding a valid proposal, retain accurate saved-plan state in failure receipts, and separately address reviewer truncation. No repair has been applied by this QA report.

Terra (medium) used an isolated authenticated Playwright context, read-only. Both generated images render in chat and canvas after reload; image HTTP responses 200; no console/page errors or persistent loading. Screenshots: ui-image1-canvas-20260911.png, ui-image2-canvas-20260911.png, ui-final-recap-canvas-20260911.png under artifacts/paid-dialogue-live.

## Not covered by this live batch

Forced provider failure/fallback, unknown upstream outcome, cancellation during generation, worker restart, duplicate concurrent confirmation, nonzero debit/refund, nine simultaneous reference images, multi-user isolation, and hundreds/thousands of real turns. Prior unit/mock tests are not substitutes for these live cases. No provider configuration was altered to force failures.

Main agent performed real dialogue and DB checks; Terra (medium) independently checked UI; Sol (high) investigated the confirmation failure read-only. No production code changes were made in this QA batch.
