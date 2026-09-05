import { describe, expect, it, vi } from "vitest";

import { ConnectionManager } from "./connection-manager.js";

describe("ConnectionManager canvas RPC routing", () => {
  it("sends screenshot RPC only to a connection bound to that canvas", async () => {
    const manager = new ConnectionManager();
    const homeSocket = { readyState: 1, send: vi.fn() };
    const canvasSocket = { readyState: 1, send: vi.fn() };
    manager.register("home-connection", "user-1", homeSocket as never);
    manager.register("canvas-connection", "user-1", canvasSocket as never);
    manager.bindCanvas("canvas-connection", "canvas-1");

    const pending = manager.rpcToCanvas<{ width: number }>(
      "canvas-1",
      "canvas.screenshot",
      { mode: "full" },
    );

    expect(homeSocket.send).not.toHaveBeenCalled();
    expect(canvasSocket.send).toHaveBeenCalledOnce();
    const request = JSON.parse(canvasSocket.send.mock.calls[0]![0] as string) as {
      id: string;
      method: string;
    };
    expect(request.method).toBe("canvas.screenshot");

    manager.handleRpcResponse("canvas-connection", {
      type: "rpc.response",
      id: request.id,
      result: { width: 1024 },
    });
    await expect(pending).resolves.toEqual({ width: 1024 });
  });
});
