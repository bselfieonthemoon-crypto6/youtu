import { describe, expect, it } from "vitest";

import {
  createCanvasFileLoadQueue,
  visibleCanvasFileIds,
} from "../src/lib/canvas-file-loader";

const candidates = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    fileId: `file-${index}`,
    assetId: `asset-${index}`,
    meta: {},
  }));

describe("canvas file loading", () => {
  it("never exceeds the configured download concurrency", async () => {
    let active = 0;
    let maximum = 0;
    let loaded = 0;
    let finish: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queue = createCanvasFileLoadQueue({
      concurrency: 4,
      async load(candidate) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return `data:image/webp;base64,${candidate.fileId}`;
      },
      onLoaded() {
        loaded += 1;
        if (loaded === 25) finish?.();
      },
    });

    queue.enqueue(candidates(25));
    await completed;
    expect(maximum).toBe(4);
    queue.dispose();
  });

  it("retries a transient failure without duplicating a queued file", async () => {
    let attempts = 0;
    let finish: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queue = createCanvasFileLoadQueue({
      retryDelayMs: 10,
      async load() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary");
        return "data:image/webp;base64,ok";
      },
      onLoaded() {
        finish?.();
      },
    });
    const file = candidates(1)[0];
    if (!file) throw new Error("fixture missing");
    queue.enqueue([file, file]);
    await completed;
    expect(attempts).toBe(2);
    queue.dispose();
  });

  it("selects only viewport-near images and orders the closest first", () => {
    const elements = Array.from({ length: 1_000 }, (_, index) => ({
      id: `element-${index}`,
      type: "image",
      fileId: `file-${index}`,
      x: index * 200,
      y: 0,
      width: 100,
      height: 100,
    }));
    const visible = visibleCanvasFileIds(
      elements,
      {
        width: 1_000,
        height: 800,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      },
      0,
    );

    expect(visible).toHaveLength(6);
    expect(visible[0]).toBe("file-2");
    expect(visible).not.toContain("file-999");
  });
});
