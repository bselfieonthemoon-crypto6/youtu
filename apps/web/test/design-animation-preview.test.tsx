import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignAnimationPreview } from "../src/components/design/design-animation-preview";

const mocks = vi.hoisted(() => ({ disposeCanvas: vi.fn(async () => {}), disposeEditor: vi.fn(), load: vi.fn(async () => {}), images: vi.fn(async () => ({ missingAssetObjectIds: ["missing"] })) }));
vi.mock("fabric", () => ({ Canvas: class { dispose = mocks.disposeCanvas; } }));
vi.mock("../src/components/design/fabric-object-editor", () => ({ FabricObjectEditor: class {
  dispose = mocks.disposeEditor; loadScene = mocks.load; waitForImages = mocks.images;
} }));
const scene = { canvas: { width: 100, height: 100 }, objects: [{ objectId: "one", type: "image", visible: true, animation: { type: "float", durationMs: 2000, amount: 10 } }] } as any;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("animation preview cleanup", () => {
  it("waits for pending asset work before disposing an unmounted preview", async () => {
    let finish!: () => void;
    mocks.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<DesignAnimationPreview scene={scene} autoPlay={false} pauseSignal={0} onReady={vi.fn()} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(mocks.disposeCanvas).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(mocks.disposeCanvas).toHaveBeenCalledTimes(1));
    expect(mocks.disposeEditor).toHaveBeenCalledTimes(1);
  });
  it("releases a failed paused preview immediately and only once", async () => {
    const view = render(<DesignAnimationPreview scene={scene} autoPlay={false} pauseSignal={0} onReady={vi.fn()} />);
    await waitFor(() => expect(mocks.disposeCanvas).toHaveBeenCalledTimes(1));
    expect(mocks.disposeEditor).toHaveBeenCalledTimes(1);
    view.unmount();
    await Promise.resolve();
    expect(mocks.disposeCanvas).toHaveBeenCalledTimes(1);
  });
  it("does not start previews for animation under a hidden group", async () => {
    render(<DesignAnimationPreview scene={{ ...scene, objects: [...scene.objects, { objectId: "group", type: "group", visible: false, childObjectIds: ["one"] }] }} autoPlay={false} pauseSignal={0} onReady={vi.fn()} />);
    await Promise.resolve();
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
