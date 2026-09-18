import { describe, expect, it, vi } from "vitest";
import {
  loadOrGenerateImageSource,
  recoverOrGenerateImageSource,
  type GeneratedSource,
} from "./image-source-checkpoint.js";
import type {
  ImageGenerationCheckpoint,
  ImageGenerationCheckpointState,
} from "./image-generation-checkpoint.js";
describe("generation before local processing", () => {
  it("reuses the stored original on worker retry without calling the paid provider", async () => {
    let stored: GeneratedSource | null = null;
    const source = { buffer: Buffer.from("original"), mimeType: "image/png" };
    const generate = vi.fn(async () => source);
    const save = vi.fn(async (value: GeneratedSource) => {
      stored = value;
    });
    const options = { load: async () => stored, generate, save };
    expect(await loadOrGenerateImageSource(options)).toBe(source);
    // Simulate local matting failure/process restart after a durable save.
    expect(await loadOrGenerateImageSource(options)).toBe(source);
    expect(generate).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });
  it("fails closed on a checkpoint read error, not by creating another image", async () => {
    const generate = vi.fn();
    await expect(
      loadOrGenerateImageSource({
        load: async () => {
          throw Error("storage unavailable");
        },
        generate,
        save: vi.fn(),
      }),
    ).rejects.toThrow("storage unavailable");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("durable provider generation boundary", () => {
  it("persists the returned reference and pixels before archiving", async () => {
    const events: string[] = [];
    const source = { buffer: Buffer.from("pixels"), mimeType: "image/png" };
    const checkpoint = checkpointStub({ claimed: true }, events);

    await expect(
      recoverOrGenerateImageSource({
        checkpoint,
        loadArchived: async () => null,
        generate: async () => {
          events.push("generate");
          return { url: "https://provider.test/result.png", mimeType: "image/png" };
        },
        download: async () => {
          events.push("download");
          return source;
        },
        archive: async () => events.push("archive"),
      }),
    ).resolves.toBe(source);

    expect(events).toEqual([
      "claim",
      "generate",
      "returned:https",
      "download",
      "returned:data",
      "archive",
      "archived",
    ]);
  });

  it("resumes returned results without calling the provider", async () => {
    const events: string[] = [];
    const returned = state({
      status: "returned",
      result: { url: "https://provider.test/result.png", mimeType: "image/png" },
    });
    const generate = vi.fn();
    await recoverOrGenerateImageSource({
      checkpoint: checkpointStub({ claimed: false, state: returned }, events),
      loadArchived: async () => null,
      generate,
      download: async () => ({ buffer: Buffer.from("pixels"), mimeType: "image/png" }),
      archive: async () => undefined,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(events).toContain("returned:data");
  });

  it("fails closed when a previous provider call has an unknown outcome", async () => {
    const generate = vi.fn();
    await expect(
      recoverOrGenerateImageSource({
        checkpoint: checkpointStub(
          { claimed: false, state: state({ status: "calling", claimedAt: new Date().toISOString() }) },
          [],
        ),
        loadArchived: async () => null,
        generate,
        download: vi.fn(),
        archive: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "image_generation_result_unknown" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("checks the attempt state then reconciles an archived source without generating", async () => {
    const events: string[] = [];
    const checkpoint = checkpointStub({ claimed: true }, events);
    const source = { buffer: Buffer.from("legacy"), mimeType: "image/png" };
    await expect(
      recoverOrGenerateImageSource({
        checkpoint,
        loadArchived: async () => source,
        generate: vi.fn(),
        download: vi.fn(),
        archive: vi.fn(),
      }),
    ).resolves.toBe(source);
    expect(events).toEqual(["claim", "archived"]);
  });
});

function checkpointStub(
  claimResult:
    | { claimed: true }
    | { claimed: false; state: ImageGenerationCheckpointState },
  events: string[],
): ImageGenerationCheckpoint {
  return {
    claim: vi.fn(async () => {
      events.push("claim");
      return claimResult;
    }),
    saveReturned: vi.fn(async (result) => {
      events.push(result.url.startsWith("data:") ? "returned:data" : "returned:https");
    }),
    saveRejected: vi.fn(async () => undefined),
    saveArchived: vi.fn(async () => {
      events.push("archived");
    }),
  };
}

function state(
  value:
    | { status: "calling"; claimedAt: string }
    | { status: "returned"; result: { url: string; mimeType: string } },
): ImageGenerationCheckpointState {
  return {
    version: 1,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    requestFingerprint: "a".repeat(64),
    variant: "image-generation-source",
    ...value,
  };
}
