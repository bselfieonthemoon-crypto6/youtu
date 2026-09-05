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
});
