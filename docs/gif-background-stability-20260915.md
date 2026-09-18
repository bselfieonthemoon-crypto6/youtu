# GIF background colour stability

## Cause and change

The old browser exporter quantized each rendered frame independently and wrote a local palette per frame. Moving subjects changed the palette assigned to stationary background pixels. Per-frame bin caches can introduce additional colour differences even when a palette is reused.

The exporter now freezes the input scene, collects a bounded sample across a deterministic render pass, and builds one global palette and one fixed RGB lookup for the whole animation. The second render pass encodes with that lookup. Memory is bounded to one rendered frame, at most 262144 sampled pixels, the lookup and encoded output, rather than caching 60 full RGBA frames.

Transparent pixels have a reserved index and explicit one-bit alpha. Fully opaque animation uses keep-frame disposal; transparent animation clears between full-frame images to avoid trails. Dimensions, animation timing, source design, and image-generation settings are unchanged. The additional render pass can increase export time. GIF's palette still limits colour fidelity compared with the browser's full-colour preview.

## Validation

- Seven exporter tests passed, including decoding real GIF bytes and checking stationary colour stability and transparent sprite trails. The new regression fails the old per-frame palette implementation (four decoded colours for a stationary pixel).
- A separate verification used the existing repaired-background and transparent-snake assets. The actual exporter produced a 12-frame GIF; the old encoder was run against the same rendered frames.
- Independent Pillow decoding found total RGB difference in the untouched background region: old 3036367; fixed 0. Both animations still move. Evidence: `artifacts/gif-stability-20260915/decoded-result.json`, `before.gif`, `fixed.gif`.
- This test uses real assets with a deterministic test render port. It does not claim to reproduce an unavailable downloaded user GIF or unsaved browser animation settings. No model calls or design edits were made.
- Production build `.next-production-gif-stable-palette` passed and is served on port 3020 (PID 24268); the canvas route returned HTTP 200. The existing build configuration skips type validation. A separate full web typecheck reports eight errors outside the GIF files (design-create-panel tests, optional accessToken props, and canvas-element-merge tests); the GIF source and tests have no reported type errors. Full output is saved with the verification artifacts.

Main implemented the exporter and independently checked real-asset decoding. Terra (medium, as configured at spawn) added the GIF decoding regression tests.
