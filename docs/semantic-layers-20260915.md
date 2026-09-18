# Semantic layer separation acceptance — 2026-09-15

## Behavior

The image toolbar's 图层拆分 action now accepts 2–4 distinct element descriptions. A published workspace image model generates one repaired opaque background and one transparent PNG per named element. Foregrounds are cropped to their alpha bounds and retain placement metadata. Results are independent canvas assets placed beside the preserved original. Design-editor finalization also preserves the original.

Requests use Low (`standard`) + 1K and require background repair. The dialog quotes the selected model and total of 3–5 calls before submission. Legacy local and Qwen routes remain separate. The image-layer-separation guidance skill is version 2.2.0; it describes the toolbar accurately and does not advertise a nonexistent Agent split tool.

Each provider stage has an exclusive durable checkpoint and archived source, so recovery can reuse completed stages. Worker routing resolves the published provider for semantic jobs instead of treating them as local image operations.

## Real integration result

- Separate QA canvas: `9f99679f-06c9-40a1-8970-7ad34898ee6c`.
- Successful job: `a0ee95f3-8f7d-47d2-9e13-b1353a479361`.
- Model: published workspace alias `workspace:0a23c8b6-ce4c-46ca-9ac3-e0ffd37b5e51` (gpt-image-2.5-flare).
- Submitted through the actual browser toolbar with the left snake and right person descriptions.
- Outputs: repaired background 1280×560; snake 380×544 at (84, 0); person 472×545 at (739, 0).
- Downloaded PNGs verified: opaque background, visible foreground pixels and actual zero-alpha pixels, all three assets inserted, original element retained.
- Visual inspection of the repaired background and white-composited alpha previews confirmed both requested characters removed from the background and isolated in the foreground assets.
- Evidence: `artifacts/semantic-layers-20260915/browser.json`, `result.json`, `before-submit.png`, and `layer-*.png`.

An initial QA job failed with `model_not_found` before provider execution because worker routing classified semantic splitting as local. The routing was fixed and tested before a new QA submission. The failed job had no archived assets or credit transactions. Local credit cost was null; real monetary billing was not verified.

## Checks

- Final server integration: 90 tests across worker, semantic/Qwen HTTP routes, durable image recovery, and both canvas finalizers passed.
- Server typecheck passed.
- Shared contract: 24 tests and build passed.
- Targeted frontend: 10 tests passed.
- Skill catalog: 12 tests passed; additive local migration applied.
- Production web build `.next-production-semantic-layers` passed and is served on port 3020.
- Full web typecheck retains four preexisting errors in `design-create-panel.test.tsx`; the production build skips typechecking by existing configuration.

## Limits

This is generative extraction and inpainting, not recovery of the original author's hidden layers. Details and placement can vary, and occluded content is inferred. Alpha validation checks file validity rather than exact semantic fidelity. The current toolbar requires element descriptions; automatic enumeration of every object and editable text reconstruction are not included.

Backend work: Sol (high). Frontend work: Terra (medium). Main agent: skill integration, production startup, real browser/provider acceptance, and visual inspection.
