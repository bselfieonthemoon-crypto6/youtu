# Image cost receipt and matrix audit

This audit uses source inspection, the real local credit calculator and mocked OpenAI SDK transport. It makes no real provider or paid request.

## Receipt boundary

The web tool card renders a cost receipt only when the direct image tool reports a submitted lifecycle (`queued`, `processing`, `succeeded`, or `finished`) and supplies all four server-owned fields: `creditsCost`, `pricingVersion`, `actualQuality`, and `actualResolution`. A preflight failure, canceled job, or refunded state does not render a charge claim. The receipt says “本次任务”, not “已扣”, because the durable server outcome remains the authority for commit/refund.

## Quality and resolution matrix

`quality` and native `resolution` are independent request dimensions: standard/hd/ultra map to Low/Medium/High. `imageResolutionBillingQuality` takes the maximum quality/resolution rank for the current access and credit table. The calculator takes that same maximum once more, which is idempotent: no resolution multiplier is applied and no double charge was demonstrated. Low × 2K maps to the HD credit tier while the provider still receives low quality. This is the current credit-table policy, not a claim that provider quality was upgraded.

The calculator matrix covers five models × three qualities × three resolutions with commercial enforcement enabled, and separately checks the disabled zero-cost behavior. The mocked SDK matrix covers Image2, Flare, Sunburst and the existing compatible `-all` route × nine quality/resolution combinations. Native size control applies to the published native models; the compatible `-all` route retains its legacy fallback sizes. Therefore that legacy route does not establish that an arbitrary requested 2K/4K resolution is actually rendered, despite the resolution-based credit tier. No comparison to real supplier prices was performed.

Verified with one worker: tier guard 4 tests, OpenAI image provider 47 tests, web tool card 41 tests, all passed. Production pricing and provider mappings were not changed.
