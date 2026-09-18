# Mastra image contract cleanup

The new-image tool description now acknowledges authenticated implicit reference grounding by the server. Explicit source IDs remain an edit_image contract, with sourceUsage distinguishing editing from reference-based creation. Model arguments cannot provide arbitrary source URLs or native-board targets.

The redundant ratio normalization immediately after initial model resolution was removed: that resolver changes the catalog model ID, not ratio or intent. Public schema parsing is centralized while source usage and verified ratio intent remain separate server metadata. Source grounding retains its established model/ratio validation order because newly bound sources can change model compatibility and source-frame preservation. This is a bounded cleanup, not removal of all repeated validation.

Main integration: 79 tests passed across Mastra image tools, approximate sizes, source grounding and durable image jobs. Backend agent also checked native-ratio preflight. Cases cover explicit/implicit sources, preserving vs resizing, manual UI precedence, Auto selection, Low/1K defaults, stale/current skill markers, and unknown submission outcomes. Submitters/provider transport are mocked; no new paid image generation was performed.

Cost confirmation, self-repair behavior, design-target paths, collaboration permissions, billing and worker checkpoints were not changed. Sol (high) implemented the contract/normalization cleanup; main reviewed boundaries and ran integration checks.

Final server typecheck passed. Agent instruction wording was aligned with the tool contract and its 14 tests passed. API was restarted after confirming no active background jobs; health returned HTTP 200. No web build or worker restart was needed for these Agent-only changes.
