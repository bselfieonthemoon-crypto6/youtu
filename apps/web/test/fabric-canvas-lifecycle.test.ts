import { describe, expect, it, vi } from "vitest";

import { FabricCanvasLifecycle } from "../src/components/design/fabric-canvas-lifecycle";

describe("FabricCanvasLifecycle", () => {
  it("awaits disposal and leaves no Fabric instance after 20 open/close cycles", async () => {
    const lifecycle = new FabricCanvasLifecycle();
    let liveInstances = 0;
    let peakInstances = 0;
    const disposals: Array<ReturnType<typeof vi.fn>> = [];

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const dispose = vi.fn(async () => {
        await Promise.resolve();
        liveInstances -= 1;
      });
      disposals.push(dispose);
      const canvas = await lifecycle.mount(() => {
        liveInstances += 1;
        peakInstances = Math.max(peakInstances, liveInstances);
        return { dispose };
      });
      expect(lifecycle.hasActiveCanvas()).toBe(true);
      await lifecycle.unmount(canvas);
      expect(lifecycle.hasActiveCanvas()).toBe(false);
    }

    expect(peakInstances).toBe(1);
    expect(liveInstances).toBe(0);
    expect(disposals).toHaveLength(20);
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("disposes the prior instance before mounting a replacement", async () => {
    const events: string[] = [];
    const lifecycle = new FabricCanvasLifecycle();
    await lifecycle.mount(() => ({
      dispose: async () => {
        events.push("dispose:first");
      },
    }));
    await lifecycle.mount(() => {
      events.push("mount:second");
      return {
        dispose: async () => {
          events.push("dispose:second");
        },
      };
    });
    expect(events).toEqual(["dispose:first", "mount:second"]);
    await lifecycle.unmount();
  });

  it("ignores stale cleanup after a replacement is active", async () => {
    const lifecycle = new FabricCanvasLifecycle();
    const firstDispose = vi.fn(async () => true);
    const secondDispose = vi.fn(async () => true);
    const first = await lifecycle.mount(() => ({ dispose: firstDispose }));
    const second = await lifecycle.mount(() => ({ dispose: secondDispose }));

    await lifecycle.unmount(first);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
    expect(lifecycle.hasActiveCanvas()).toBe(true);

    await lifecycle.unmount(second);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it("can mount again after a constructor failure", async () => {
    const lifecycle = new FabricCanvasLifecycle();
    await expect(
      lifecycle.mount(() => {
        throw new Error("constructor failed");
      }),
    ).rejects.toThrow("constructor failed");

    const canvas = await lifecycle.mount(() => ({ dispose: async () => true }));
    expect(lifecycle.hasActiveCanvas()).toBe(true);
    await lifecycle.unmount(canvas);
  });
});
