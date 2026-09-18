import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { postprocessDesignImage } from "./design-image-postprocess.js";
import type { ImageForegroundPolicy } from "@loomic/shared";
const policy: ImageForegroundPolicy = { version: 1, mode: "api_matting", generationModel: "test", mattingModel: "gpt-image-2", generationCredits: 1, mattingCredits: 2, totalCredits: 3, pricingVersion: "credits-v1" };
const transparent = () => sharp(Buffer.from([255,0,0,255,0,0,0,0]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
describe("confirmed design foreground postprocess", () => {
  it.each([undefined, { kind: "canvas" }, { kind: "design", placement: { role: "background" } }])("preserves non-foreground pixels: %j", async target => {
    const source = Buffer.from("source");
    expect(await postprocessDesignImage(source, "image/jpeg", target)).toEqual({ buffer: source, mimeType: "image/jpeg" });
  });
  it.each([undefined, "logo", "product", "title", "subtitle", "decoration"])("calls confirmed API for foreground role %s", async role => {
    const output = await transparent();
    const removeBackground = vi.fn(async () => output);
    expect(await postprocessDesignImage(Buffer.from("source"), "image/jpeg", { kind: "design", placement: { role } }, { policy, removeBackground })).toEqual({ buffer: output, mimeType: "image/png" });
    expect(removeBackground).toHaveBeenCalledTimes(1);
  });
  it("rejects unconfirmed foreground processing without any fallback", async () => {
    await expect(postprocessDesignImage(Buffer.from("source"), "image/jpeg", { kind: "design" })).rejects.toMatchObject({ code: "foreground_policy_required" });
  });
  it("native transparency validates pixels without calling matting", async () => {
    const source = await transparent(); const removeBackground = vi.fn();
    await postprocessDesignImage(source, "image/png", { kind: "design" }, { policy: { ...policy, mode: "native_transparent" }, removeBackground });
    expect(removeBackground).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain paid API result", async () => {
    const removeBackground = vi.fn(async () => { throw new Error("unknown outcome"); });
    await expect(postprocessDesignImage(Buffer.from("source"), "image/jpeg", { kind: "design" }, { policy, removeBackground })).rejects.toThrow("unknown outcome");
    expect(removeBackground).toHaveBeenCalledTimes(1);
  });
  it.each([0, 255])("does not accept empty/opaque PNG alpha=%i", async alpha => {
    const output = await sharp(Buffer.from([255,0,0,alpha]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    await expect(postprocessDesignImage(output, "image/png", { kind: "design" }, { policy, removeBackground: async () => output })).rejects.toMatchObject({ code: "background_removal_invalid_output" });
  });
});
