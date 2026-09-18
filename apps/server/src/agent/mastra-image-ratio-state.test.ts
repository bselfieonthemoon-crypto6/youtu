import { describe, expect, it } from "vitest";
import { bindNativeImageRatioUsage, resolveNativeImageRatio } from "./mastra-image-ratio-state.js";

describe("native image resolved ratio authority", () => {
  it.each([
    { preference: "16:9", userPrompt: "把图改成4:3", aspectRatio: "16:9", ratioSource: "explicit_ui" },
    { preference: "auto", userPrompt: "把图改成4:3", aspectRatio: "4:3", ratioSource: "user_request" },
    { preference: "auto", userPrompt: "制作横幅", aspectRatio: "16:9", ratioSource: "inferred_default" },
  ])("records $ratioSource before binding sources", ({ preference, userPrompt, aspectRatio, ratioSource }) => {
    const result = resolveNativeImageRatio({ args: { title: "图", prompt: "visual" }, preference,
      userPrompt, usage: "independent", skillLoaded: false });
    expect(result).toMatchObject({ ok: true, state: { frame: { aspectRatio, ratioSource } } });
  });
  it("keeps source preservation separate from an inferred independent banner frame", () => {
    const result = resolveNativeImageRatio({ args: { title: "Banner", prompt: "edit blue", aspectRatio: "16:9",
      aspectRatioIntent: "resize" }, preference: "auto", userPrompt: "把这个16:9的图改成蓝色",
      usage: "independent", skillLoaded: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bound = bindNativeImageRatioUsage(result.state, "edit");
    expect(bound.frame).toEqual({ intent: "preserve_source", ratioSource: "inferred_default" });
  });
  it("retains approximation target and authorization when usage changes", () => {
    const result = resolveNativeImageRatio({ args: { title: "Banner", prompt: "visual", aspectRatio: "3:1",
      aspectRatioIntent: "approximate" }, preference: "auto", userPrompt: "把图改成656×176，差不多就好",
      usage: "independent", skillLoaded: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bound = bindNativeImageRatioUsage(result.state, "edit");
    expect(bound).toMatchObject({ frame: { aspectRatio: "3:1", intent: "resize", ratioSource: "user_request" },
      approximation: { applied: true, authorized: true, skillLoaded: true, targetRatio: "656:176" } });
  });
});
