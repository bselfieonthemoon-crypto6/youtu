// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationCanvasPresenceProvider } from "../src/components/chat/generation-canvas-presence";
import { ToolBlockView } from "../src/components/chat/tool-block-view";
afterEach(cleanup);

const block = { type: "tool" as const, toolCallId: "call", toolName: "generate_image",
  status: "completed" as const, output: { jobId: "job", status: "succeeded" } };
type Element = { id: string; isDeleted?: boolean; customData?: { sourceJobId?: string; jobId?: string } };
function scene(initial: Element[] = []) {
  let elements = initial;
  let listener = () => {};
  const unsubscribe = vi.fn();
  return { api: { getSceneElementsIncludingDeleted: () => elements,
    onChange: (callback: () => void) => { listener = callback; return unsubscribe; } },
    set: (next: Element[], notify = true) => { elements = next; if (notify) listener(); }, unsubscribe };
}
describe("generation recovery uses the real canvas", () => {
  it.each([
    { id: "job" },
    { id: "different", customData: { sourceJobId: "job" } },
    { id: "different", customData: { jobId: "job" } },
    { id: "job", isDeleted: true },
    { id: "deleted", isDeleted: true, customData: { sourceJobId: "job" } },
  ])("hides recovery for present or deleted result %j", element => {
    const state = scene([element]);
    render(<GenerationCanvasPresenceProvider api={state.api}><ToolBlockView block={block} /></GenerationCanvasPresenceProvider>);
    expect(screen.queryByRole("button", { name: "放入画布" })).not.toBeInTheDocument();
  });
  it("hides while the canvas is unknown", () => {
    render(<ToolBlockView block={block} />);
    expect(screen.queryByRole("button", { name: "放入画布" })).not.toBeInTheDocument();
  });
  it("reacts to canvas sync and undo without waiting for another chat message", () => {
    const state = scene();
    const view = render(<GenerationCanvasPresenceProvider api={state.api}><ToolBlockView block={block} onRestoreGeneration={vi.fn()} /></GenerationCanvasPresenceProvider>);
    expect(screen.getByRole("button", { name: "放入画布" })).toBeEnabled();
    act(() => state.set([{ id: "image", customData: { sourceJobId: "job" } }]));
    expect(screen.queryByRole("button", { name: "放入画布" })).not.toBeInTheDocument();
    act(() => state.set([{ id: "image", isDeleted: true, customData: { sourceJobId: "job" } }]));
    expect(screen.queryByRole("button", { name: "放入画布" })).not.toBeInTheDocument();
    view.unmount();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });
  it("rechecks a result inserted between render and click", () => {
    const state = scene(); const restore = vi.fn();
    render(<GenerationCanvasPresenceProvider api={state.api}><ToolBlockView block={block} onRestoreGeneration={restore} /></GenerationCanvasPresenceProvider>);
    const button = screen.getByRole("button", { name: "放入画布" });
    state.set([{ id: "job" }], false);
    fireEvent.click(button);
    expect(restore).not.toHaveBeenCalled();
  });
  it("does not confuse another job with this result", () => {
    const state = scene([{ id: "other" }]);
    render(<GenerationCanvasPresenceProvider api={state.api}><ToolBlockView block={block} onRestoreGeneration={vi.fn()} /></GenerationCanvasPresenceProvider>);
    expect(screen.getByRole("button", { name: "放入画布" })).toBeEnabled();
  });
});
