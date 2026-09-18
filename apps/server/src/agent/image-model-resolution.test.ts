import { describe, expect, it } from "vitest";
import type { AvailableModel } from "../generation/providers/registry.js";
import { resolveImageGenerationModelProposal } from "./image-model-resolution.js";

const models: AvailableModel[] = [
  { id: "workspace:current-a", displayName: "Current A", description: "", provider: "test", upstreamModelId: "gpt-image-2-all" },
  { id: "workspace:current-b", displayName: "Current B", description: "", provider: "test", upstreamModelId: "gpt-image-2" },
];

describe("authoritative image model proposal resolution", () => {
  it("fails closed for a stale historical model instead of selecting another candidate", () => {
    expect(resolveImageGenerationModelProposal(
      { operation: "generate", model: "workspace:removed-history", title: "Logo", prompt: "Logo" },
      models,
    )).toMatchObject({ ok: false, code: "image_model_identifier_unavailable" });
  });

  it("uses the normal automatic default only when model is omitted or explicitly Auto", () => {
    for (const model of [undefined, "Auto"]) {
      const result = resolveImageGenerationModelProposal(
        { operation: "generate", ...(model === undefined ? {} : { model }), title: "Logo", prompt: "Logo" },
        models,
      );
      expect(result).toMatchObject({ ok: true, model: "workspace:current-a", repaired: true });
    }
  });

  it("keeps an exact current workspace alias without repairing it", () => {
    const result = resolveImageGenerationModelProposal(
      { operation: "generate", model: "workspace:current-b", title: "Logo", prompt: "Logo" },
      models,
    );
    expect(result).toMatchObject({ ok: true, model: "workspace:current-b", repaired: false });
  });

  it("removes a reference-only hint when no reference object exists", () => {
    const result = resolveImageGenerationModelProposal(
      { operation: "generate", model: "Auto", title: "Logo", prompt: "Logo", sourceUsage: "reference", inputImages: [] },
      models,
    );
    expect(result).toMatchObject({ ok: true, model: "workspace:current-a" });
    if (!result.ok) throw new Error("expected resolution");
    expect(result.args).not.toHaveProperty("sourceUsage");
    expect(result.args).not.toHaveProperty("inputImages");
  });

  it("honors the current manual choice instead of a different valid or historical model", () => {
    for (const proposed of ["workspace:current-b", "Auto"]) {
      const result = resolveImageGenerationModelProposal(
        { operation: "generate", model: proposed, title: "Logo", prompt: "Logo" },
        models,
        { manualModelIds: ["workspace:current-b"] },
      );
      expect(result).toMatchObject({ ok: true, model: "workspace:current-b" });
    }
  });

  it("fails closed when a manual choice is no longer in the current catalog", () => {
    expect(resolveImageGenerationModelProposal(
      { operation: "generate", model: "workspace:current-a", title: "Logo", prompt: "Logo" },
      models,
      { manualModelIds: ["workspace:removed-history"] },
    )).toMatchObject({ ok: false, code: "image_model_preference_unavailable" });
  });

  it("does not reinterpret manual mode with no selection as Auto", () => {
    expect(resolveImageGenerationModelProposal(
      { operation: "generate", model: "workspace:current-a", title: "Logo", prompt: "Logo" },
      models,
      { manualModelIds: [] },
    )).toMatchObject({ ok: false, code: "image_model_preference_empty" });
  });

  it("uses only an exact compatible model for background removal", () => {
    expect(resolveImageGenerationModelProposal(
      { operation: "remove_background", model: "Auto", title: "Cutout", prompt: "Cutout" },
      models,
    )).toMatchObject({ ok: true, model: "workspace:current-b" });
  });
});
