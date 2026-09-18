import { expect, it } from "vitest";
import { designObjectAnimationSchema, designObjectPatchSchema } from "./design-contracts";
it("validates finite animation bounds and allows clearing an animation", () => {
  expect(designObjectAnimationSchema.parse({ type: "scale", durationMs: 2000, amount: 20 }).type).toBe("scale");
  expect(designObjectPatchSchema.parse({ object_type: "image", animation: null }).animation).toBeNull();
  for (const bad of [
    { type: "breathing", durationMs: 2000, amount: 10 },
    { type: "float", durationMs: 0, amount: 10 },
    { type: "float", durationMs: 2000, amount: Infinity },
    { type: "scale", durationMs: 2000, amount: 101 },
    { type: "scale", durationMs: 2000, amount: 10, opacity: 0.5 },
  ]) expect(designObjectAnimationSchema.safeParse(bad).success).toBe(false);
});
