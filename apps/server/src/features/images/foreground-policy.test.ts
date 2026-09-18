import { describe, expect, it } from "vitest";
import { prepareForegroundPolicy, validateForegroundPolicy, foregroundPolicyDisclosure } from "./foreground-policy.js";
const models = ["gpt-image-2", "gpt-image-2-all", "another-model"].map(id => ({ id, displayName: id, provider: "test", description: "" }));
const input = { model: "another-model", quality: "hd", target: { kind: "design", placement: { role: "logo" } } };
const price = (model: string) => model === "gpt-image-2" ? 20 : 7;
describe("confirmed transparent foreground pipeline", () => {
  it("preserves the primary model and quotes both calls before confirmation", () => {
    const policy = prepareForegroundPolicy(input, models, price)!;
    expect(policy).toMatchObject({ mode: "api_matting", generationModel: "another-model", mattingModel: "gpt-image-2", generationCredits: 7, mattingCredits: 20, totalCredits: 27 });
    expect(foregroundPolicyDisclosure(policy)).toMatchObject({ providerCalls: 2, totalCredits: 27 });
    expect(validateForegroundPolicy(input, policy, models, price)).toEqual(policy);
  });
  it("native gpt-image-2 requests transparency once with no second charge", () => {
    expect(prepareForegroundPolicy({ ...input, model: "gpt-image-2" }, models, price)).toMatchObject({ mode: "native_transparent", mattingCredits: 0, totalCredits: 20 });
  });
  it.each(["jpg", "webp"])("rejects an explicitly incompatible %s foreground format", outputFormat => {
    expect(() => prepareForegroundPolicy({ ...input, outputFormat }, models, price)).toThrow("PNG");
  });
  it.each(["gpt-image-2-all", "gpt-image-2-vip"])("never treats %s as native transparency", model => {
    expect(() => prepareForegroundPolicy({ ...input, model }, [{ id: model, displayName: model, provider: "test", description: "" }], price)).toThrow("all/vip");
  });
  it("rejects stale quotes and unconfirmed old foreground jobs", () => {
    const policy = prepareForegroundPolicy(input, models, price)!;
    expect(() => validateForegroundPolicy(input, policy, models, () => 30)).toThrow("费用已变化");
    expect(() => validateForegroundPolicy(input, undefined, models, price)).toThrow("旧方案");
  });
  it("does not charge or matte backgrounds or standalone images", () => {
    expect(prepareForegroundPolicy({ ...input, target: { kind: "canvas" } }, models, price)).toBeUndefined();
    expect(prepareForegroundPolicy({ ...input, target: { kind: "design", placement: { role: "background" } } }, models, price)).toBeUndefined();
  });
  it("pins workspace aliases to their upstream model", () => {
    const aliasModels = models.map(model => ({ ...model, id: `workspace:${model.id}`, upstreamModelId: model.id }));
    const aliasInput = { ...input, model: "workspace:gpt-image-2-all" };
    const policy = prepareForegroundPolicy(aliasInput, aliasModels, price)!;
    expect(policy.mattingModel).toBe("workspace:gpt-image-2");
    expect(() => validateForegroundPolicy(aliasInput, policy, aliasModels.map(model => ({ ...model, upstreamModelId: "gpt-image-2-all" })), price)).toThrow("不一致");
  });
});
