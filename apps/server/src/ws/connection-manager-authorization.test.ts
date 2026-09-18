import { describe, expect, it, vi } from "vitest";

import { ConnectionManager } from "./connection-manager.js";

function socket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe("ConnectionManager canvas authorization", () => {
  it("fails closed and closes a revoked bound socket before broadcasting", async () => {
    const ws = socket();
    const manager = new ConnectionManager({ authorizeCanvas: async () => false });
    const id = manager.register("hint", "user-1", ws as never);
    manager.bindCanvas(id, "canvas-1", "workspace-1");

    await manager.pushToCanvas("canvas-1", {
      type: "canvas.sync",
      runId: "run-1",
      timestamp: new Date().toISOString(),
    });

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(
      4003,
      "Canvas access changed; reconnect required",
    );
    expect(manager.get(id)).toBeUndefined();
  });

  it("serializes fire-and-forget canvas events across async checks", async () => {
    const releases: Array<() => void> = [];
    const ws = socket();
    const manager = new ConnectionManager({
      authorizeCanvas: () => new Promise<boolean>((resolve) => {
        releases.push(() => resolve(true));
      }),
    });
    const id = manager.register("hint", "user-1", ws as never);
    manager.bindCanvas(id, "canvas-1", "workspace-1");

    const first = manager.pushToCanvas("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "A",
      timestamp: new Date().toISOString(),
    });
    const second = manager.pushToCanvas("canvas-1", {
      type: "message.delta",
      runId: "run-1",
      messageId: "message-1",
      delta: "B",
      timestamp: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await Promise.all([first, second]);

    expect(ws.send.mock.calls.map(([value]) => JSON.parse(value).event.delta))
      .toEqual(["A", "B"]);
  });

  it("does not apply a late authorization result to a new canvas binding", async () => {
    let release!: (value: boolean) => void;
    const ws = socket();
    const manager = new ConnectionManager({
      authorizeCanvas: () => new Promise<boolean>((resolve) => { release = resolve; }),
    });
    const id = manager.register("hint", "user-1", ws as never);
    manager.bindCanvas(id, "canvas-1", "workspace-1");
    const sending = manager.sendToCanvas("canvas-1", { type: "design.sync" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    manager.bindCanvas(id, "canvas-2", "workspace-1");
    release(true);

    await expect(sending).resolves.toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(manager.getEntry(id)?.canvasId).toBe("canvas-2");
  });

  it("rejects pending RPCs and explicitly closes on membership invalidation", async () => {
    const ws = socket();
    const manager = new ConnectionManager({ authorizeCanvas: async () => true });
    const id = manager.register("hint", "user-1", ws as never);
    manager.bindCanvas(id, "canvas-1", "workspace-1");
    const pending = manager.rpc(id, "canvas.inspect", {}, 1_000);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledOnce());

    expect(manager.revokeWorkspaceUser("workspace-1", "user-1")).toBe(1);
    await expect(pending).rejects.toThrow("disconnected");
    expect(ws.close).toHaveBeenCalledWith(
      4003,
      "Workspace access changed; reconnect required",
    );
  });
});
