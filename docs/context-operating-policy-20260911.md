# Context operating policy — 2026-09-11

## Principles

OpenAI does not prescribe a universal 16K/48K/128K application budget. Its
[conversation-state guidance](https://developers.openai.com/api/docs/guides/conversation-state)
requires accounting for input, output and reasoning in the model window;
[compaction guidance](https://developers.openai.com/api/docs/guides/compaction)
supports bounded working context for long interactions. These principles are
implemented locally for Loomic's third-party Chat Completions transport; this
is not OpenAI Responses server-side compaction.

Keep stable instructions and demand-loaded tools, retain recent literal user
constraints, and reuse source-linked summaries instead of summarizing every
turn. A target is not padding and is not an instruction to spend tokens.

## Implemented policy

- Exact DeepSeek upstream IDs `deepseek-v4-flash-vision-exp`,
  `deepseek-v4-flash`, `deepseek-flash`: input allowance at most 128,000;
  compaction soft threshold 48,000; working target 16,000; recent reserve 8,000.
- Normal completion allowance 8,000. An explicit caller output request over
  8,000 opts into 16,000 and a 32,000 working target. Explicit policy overrides
  take precedence. Conversation length alone does not increase output spend.
- Verified smaller provider capacities clamp these application allowances.
  Unknown provider capacity stays unknown; a matching model name does not
  verify a gateway's capacity or image accounting.
- Compaction and final request checking use the same frozen image estimate.
  The configured third-party DeepSeek endpoints remain unverified and use
  conservative 8,192/image estimates. Administrator-verified profiles can use
  documented values; 1,024/image is not silently assumed for third parties.
- Exact GPT Image 2 requests validate 16 reference images and 32,000 prompt
  characters before job creation/credit checks. These are documented request
  ceilings, not proof that every compatible gateway supports them. Unknown
  aliases do not inherit this model contract. Invalid references are rejected,
  not silently dropped. Shared transport's 32-image ceiling is not a promise of
  model support.
- Original conversation history remains stored. Working context is bounded;
  this does not promise perfect recall or error-free infinitely long dialogue.

## Live verification

API restarted with current source, shared contracts rebuilt. Isolated QA run
`3b47afb3-83c0-4510-a404-9b8dc21e89cf` completed on DeepSeek with no tool calls
and no image jobs. It recalled `aaaa.com`, 4:5 and a 3D wordmark without balls.
Provider-reported input: 15,176 tokens; output: 267. Conservative final estimate:
31,721. Snapshot confirms 128,000 input allowance, 48,000 soft threshold,
16,000 target and 8,000 completion allowance; verification remains unverified.

The 1,000-round tests are offline projections with image URL placeholders,
not 1,000 paid requests or visual-comprehension tests. Nine-reference transport
was code-reviewed; third-party nine-image generation is not live-verified here.

Final validation: server TypeScript check passed; 70 context/model-budget tests
passed, including short-request zero-summary behavior and verified nine-image
compactor/final-estimator consistency. Additional targeted image, billing,
intent, persistence and runtime suites passed; shared job contracts: 19 passed.
Luna/medium added budget tests; Terra/medium implemented image request limits;
the primary agent integrated, corrected test typing, reran checks and performed
the live request above.
