import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { evaluateSkillReadiness, skillCatalogTools } from "./skill-readiness.js";

const skillRoot = new URL("../../../../../skills/", import.meta.url);
const rasterDomains = [
  "logo-design", "campaign-design", "product-visual", "social-carousel", "series-visual-design",
] as const;
const catalogModels = [
  { id: "workspace:planner", upstreamModelId: "planner", modality: "text", capabilities: ["text", "vision_input"] },
  { id: "workspace:image", upstreamModelId: "image", modality: "image", capabilities: ["image_generation"] },
];

async function packageFor(slug: string) {
  const root = new URL(`${slug}/`, skillRoot);
  const [manifest, content] = await Promise.all([
    readFile(new URL("manifest.json", root), "utf8").then(JSON.parse),
    readFile(new URL("SKILL.md", root), "utf8"),
  ]);
  return { manifest, content };
}

describe("bundled raster skills match the Mastra image catalog", () => {
  it.each(rasterDomains)("%s is executable with the actual direct image tools, without native mutation or legacy confirmation dependencies", async slug => {
    const { manifest, content } = await packageFor(slug);
    const meta = manifest.metadata.loomic;
    expect(meta.execution).toBe("image");
    expect(meta.outputKinds).toContain("generation_request");
    expect(meta.requiredTools).toEqual(["generate_image", "edit_image"]);
    expect(meta.optionalTools).not.toContain("confirm_image_generation");
    expect(meta.optionalTools).not.toContain("get_image_proposal");
    expect(meta.requiredTools).not.toContain("manipulate_design");
    expect(meta.models.find((role: { role: string }) => role.role === "image").required).toBe(true);
    expect(evaluateSkillReadiness({ metadata: manifest.metadata, content, models: catalogModels,
      tools: skillCatalogTools("mastra") }).status).toBe("ready");
    expect(evaluateSkillReadiness({ metadata: manifest.metadata, content, models: [catalogModels[0]!],
      tools: skillCatalogTools("mastra") }).status).toBe("unavailable");
  });

  it("the prompt guide remains usable without an image model and cannot advertise removed image tools", async () => {
    const { manifest, content } = await packageFor("json-image-prompt");
    const meta = manifest.metadata.loomic;
    expect(meta.execution).toBe("guidance");
    expect(meta.requiredTools).toEqual([]);
    expect(meta.optionalTools).toEqual(["generate_image", "edit_image", "inspect_canvas"]);
    expect(evaluateSkillReadiness({ metadata: manifest.metadata, content, models: [catalogModels[0]!],
      tools: skillCatalogTools("mastra") }).status).toBe("ready");
  });
});
