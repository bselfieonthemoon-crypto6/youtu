import { describe, expect, it } from "vitest";

import type { ImageProvider } from "../types.js";
import {
  getImageProvider,
  resolveImageProviderName,
  runWithGenerationProviderScope,
} from "./registry.js";

function fakeProvider(name: string, modelId: string): ImageProvider {
  return {
    name,
    models: [
      { id: modelId, displayName: modelId, description: "test provider" },
    ],
    async generate() {
      return { url: name, mimeType: "image/png", width: 1, height: 1 };
    },
  };
}

describe("request-scoped generation providers", () => {
  it("isolates concurrent jobs using the same upstream model id", async () => {
    const first = fakeProvider("workspace:first", "shared-model");
    const second = fakeProvider("workspace:second", "shared-model");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstJob = runWithGenerationProviderScope(
      { imageProvider: first },
      async () => {
        await gate;
        const name = resolveImageProviderName("shared-model");
        return getImageProvider(name);
      },
    );
    const secondJob = runWithGenerationProviderScope(
      { imageProvider: second },
      async () => {
        release();
        await Promise.resolve();
        const name = resolveImageProviderName("shared-model");
        return getImageProvider(name);
      },
    );

    await expect(firstJob).resolves.toBe(first);
    await expect(secondJob).resolves.toBe(second);
  });

  it("isolates both primary and helper providers across concurrent two-stage jobs", async () => {
    const firstPrimary = fakeProvider("workspace:first-primary", "shared-primary");
    const firstHelper = fakeProvider("workspace:first-helper", "shared-helper");
    const secondPrimary = fakeProvider("workspace:second-primary", "shared-primary");
    const secondHelper = fakeProvider("workspace:second-helper", "shared-helper");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstJob = runWithGenerationProviderScope(
      { imageProvider: firstPrimary, auxiliaryImageProviders: [firstHelper] },
      async () => {
        await gate;
        return [
          getImageProvider(resolveImageProviderName("shared-primary")),
          getImageProvider(resolveImageProviderName("shared-helper")),
        ];
      },
    );
    const secondJob = runWithGenerationProviderScope(
      { imageProvider: secondPrimary, auxiliaryImageProviders: [secondHelper] },
      async () => {
        release();
        await Promise.resolve();
        return [
          getImageProvider(resolveImageProviderName("shared-primary")),
          getImageProvider(resolveImageProviderName("shared-helper")),
        ];
      },
    );

    await expect(firstJob).resolves.toEqual([firstPrimary, firstHelper]);
    await expect(secondJob).resolves.toEqual([secondPrimary, secondHelper]);
  });
});
