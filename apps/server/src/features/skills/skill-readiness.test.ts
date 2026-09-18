import { describe, expect, it } from "vitest";
import { evaluateSkillReadiness, restrictSkillReadinessToTools, skillCatalogTools } from "./skill-readiness.js";
const metadata = { loomic: { schemaVersion: 1, execution: "native", intents: [], outputKinds: [],
  requiredTools: ["manipulate_design"], optionalTools: [], models: [
    { role: "planner", required: true, preferredIds: ["gemini-3.1-flash-lite"] },
    { role: "image", required: false, preferredIds: ["gpt-image-2"], exactIds: ["gpt-image-2"] },
  ], limitations: ["Does not export editable SVG"], examples: [], sources: [] } };
const planner = { id: "workspace:planner", upstreamModelId: "gemini-3.1-flash-lite", modality: "text", capabilities: ["text", "vision_input"] };
const nativeImage = { id: "workspace:image", upstreamModelId: "gpt-image-2", modality: "image", capabilities: ["image_generation"] };
describe("skill dependencies are configuration facts, not quality claims", () => {
  it("does not mislabel pure guidance as a missing capability", () => {
    const guide = { loomic: { ...metadata.loomic, execution: "guidance", requiredTools: [], models: [{ role: "planner", required: true, preferredIds: [] }] } };
    expect(evaluateSkillReadiness({ metadata: guide, content: "guide", models: [planner] }).status).toBe("ready");
  });
  it("shows native mutations unavailable in the Mastra catalog too", () => {
    expect(evaluateSkillReadiness({ metadata, content: "guide", models: [planner,nativeImage], tools: skillCatalogTools("mastra") }).status).toBe("unavailable");
    expect(skillCatalogTools("mastra").has("edit_image")).toBe(true);
    expect(skillCatalogTools("mastra").has("confirm_image_generation")).toBe(false);
  });
  it("rechecks tools in scoped runs without promoting an unavailable catalog", () => {
    const ready = evaluateSkillReadiness({ metadata, content: "guide", models: [planner, nativeImage] });
    expect(restrictSkillReadinessToTools(metadata, ready, new Set())?.status).toBe("unavailable");
    expect(restrictSkillReadinessToTools(metadata, ready, new Set(["manipulate_design"]))?.status).toBe("ready");
    const blocked = { ...ready, status: "unavailable" as const };
    expect(restrictSkillReadinessToTools(metadata, blocked, new Set(["manipulate_design"]))).toBe(blocked);
  });
  it("matches public workspace IDs while preserving exact upstream requirements", () => {
    const result = evaluateSkillReadiness({ metadata, content: "guide", models: [planner, nativeImage] });
    expect(result.status).toBe("ready");
    expect(result.models).toContainEqual({ role: "image", modelId: "workspace:image", upstreamModelId: "gpt-image-2" });
    expect(result.reasons).toContain("Does not export editable SVG");
  });
  it("never treats -all as the exact native transparent model", () => {
    const result = evaluateSkillReadiness({ metadata, content: "guide", models: [planner, { ...nativeImage, upstreamModelId: "gpt-image-2-all" }] });
    expect(result.status).toBe("limited");
    expect(result.models.some(model => model.role === "image")).toBe(false);
  });
  it("recognizes the direct transparent-image edit tool", () => {
    const backgroundMetadata = { loomic: { ...metadata.loomic,
      requiredTools: ["edit_image"], optionalTools: ["generate_image"],
      models: [{ role: "image", required: true, preferredIds: [] }],
    } };
    expect(evaluateSkillReadiness({ metadata: backgroundMetadata, content: "guide", models: [nativeImage] }).status).toBe("ready");
    expect(restrictSkillReadinessToTools(backgroundMetadata, { status: "ready", reasons: [], models: [] }, new Set(["generate_image"])))
      .toMatchObject({ status: "unavailable" });
  });
  it("blocks required missing models and actual unavailable tools", () => {
    expect(evaluateSkillReadiness({ metadata, content: "guide", models: [] }).status).toBe("unavailable");
    expect(evaluateSkillReadiness({ metadata, content: "guide", models: [planner, nativeImage], tools: new Set() }).status).toBe("unavailable");
  });
  it("does not promote missing, invalid metadata, empty body or failed lookup to ready", () => {
    expect(evaluateSkillReadiness({ metadata: {}, content: "guide", models: [planner] }).status).toBe("limited");
    expect(evaluateSkillReadiness({ metadata, content: " ", models: [planner] }).status).toBe("unavailable");
    expect(evaluateSkillReadiness({ metadata, content: "guide", models: [planner], catalogUnavailable: true }).status).toBe("unavailable");
  });
  it("vision requires actual vision capability, not just the name of a model", () => {
    const visionMetadata = { loomic: { ...metadata.loomic, models: [{ role: "vision", required: true, preferredIds: [] }] } };
    expect(evaluateSkillReadiness({ metadata: visionMetadata, content: "guide", models: [{ ...planner, capabilities: ["text"] }] }).status).toBe("unavailable");
  });
});
