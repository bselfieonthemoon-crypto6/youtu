# Independent skill composition conflict reproduction

## Verified outcome

Main independently ran `image-proposal-skill-semantics.integration.test.ts`: 4 tests, 3 failures, 1 pass, exit code 1. The failing cases cover logo/literal prompt, carousel style/copy, and current correction. Each fails when inspecting `compose_skills`, before calling `generate_image`.

The captured composition result is `status: conflict`, `code: skill_unavailable`, for `logo-design` or `campaign-design`. Both entries report `本轮任务未开放必需工具：edit_image。不能扩大当前任务范围来执行技能。` Required image and planner models were found. The optional vision-model warning is not the blocking dependency.

## Isolation control

Ran the same test with a Vite plugin that throws if either refactored production module (`mastra-image-tool.ts`, `mastra-image-ratio-state.ts`) is loaded. A transparent wrapper records the real `composeWorkspaceSkills` result and readiness, without changing its return value. The plugin audited 63 unique Agent modules; neither blocked module was loaded. The result remains 3 failures / 1 pass with the same skill-unavailable conflicts.

Evidence and reproducible configuration are under `artifacts/skill-conflict-repro-20260915/`: `current-results.json`, `isolated-results.json`, `composition-results.jsonl`, `module-audit.jsonl`, `isolated.config.ts`, and `capture.setup.ts`. Run from `apps/server`:

```powershell
pnpm exec vitest run src/agent/image-proposal-skill-semantics.integration.test.ts
pnpm exec vitest run src/agent/image-proposal-skill-semantics.integration.test.ts --config ../../artifacts/skill-conflict-repro-20260915/isolated.config.ts
```

The capture/audit files append for repeatability; the JSON test report represents the latest run. All model calls in the suite are offline mocks. No paid generation, database modification, service restart or production-code change was performed.

## Historical baseline limitation

The relevant native-tool and integration-test files are untracked in Git, and no exact pre-refactor backup was found. Therefore an authentic pre-change checkout was not reproduced. The isolation result demonstrates that these failures occur without loading the latest native-image refactor; it does not establish when the required-tool mismatch was introduced.

The next repair, if requested, should assess the old suite's tool fixture against current Skill dependencies and old proposal/confirmation semantics. Making this first assertion pass alone would not prove the remainder of the legacy suite passes.

Main performed this bounded reproduction directly; no subagents were used.

## Subsequent migration

The source suite has since been migrated to Mastra. The 3-failure reports above describe its original legacy version, preserved as `artifacts/skill-conflict-repro-20260915/legacy-suite-source.txt`. The old isolation configuration intentionally rejects Mastra image modules and should not be used to validate the migrated suite. See `mastra-skill-semantics-test-migration-20260915.md` for the repair and current checks.
