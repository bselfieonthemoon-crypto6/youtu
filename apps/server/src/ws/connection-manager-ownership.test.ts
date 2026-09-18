import { describe, expect, it, vi } from "vitest";

import { ConnectionManager } from "./connection-manager.js";

function fakeSocket() {
  return { readyState: 1, send: vi.fn() };
}

function rpcRequest(socket: ReturnType<typeof fakeSocket>) {
  return JSON.parse(socket.send.mock.calls.at(-1)![0] as string) as {
    id: string;
  };
}

describe("ConnectionManager socket ownership", () => {
  it("keeps colliding client IDs isolated across users and close generations", () => {
    const manager = new ConnectionManager();
    const oldSocket = fakeSocket();
    const newSocket = fakeSocket();
    const oldId = manager.register("known-client-id", "user-a", oldSocket as never);
    const newId = manager.register("known-client-id", "user-b", newSocket as never);

    expect(oldId).not.toBe(newId);
    expect(manager.get("known-client-id")).toBeUndefined();
    expect(manager.sendTo(oldId, { owner: "a" })).toBe(true);
    expect(oldSocket.send).toHaveBeenCalledWith(JSON.stringify({ owner: "a" }));
    expect(newSocket.send).not.toHaveBeenCalled();

    manager.remove(oldId);
    expect(manager.sendTo(newId, { owner: "b" })).toBe(true);
    expect(newSocket.send).toHaveBeenCalledWith(JSON.stringify({ owner: "b" }));
  });

  it("does not let a same-user reconnect receive an old generation's delayed send", () => {
    const manager = new ConnectionManager();
    const oldSocket = fakeSocket();
    const newSocket = fakeSocket();
    const oldId = manager.register("reconnect-id", "same-user", oldSocket as never);
    const newId = manager.register("reconnect-id", "same-user", newSocket as never);

    manager.remove(oldId);
    expect(manager.sendTo(oldId, { type: "late-receipt" })).toBe(false);
    expect(newSocket.send).not.toHaveBeenCalled();
    expect(manager.sendTo(newId, { type: "current-receipt" })).toBe(true);
  });

  it("binds pending RPCs to the destination connection and socket instance", async () => {
    const manager = new ConnectionManager();
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    const connectionA = manager.register("rpc-a", "user-a", socketA as never);
    const connectionB = manager.register("rpc-b", "user-b", socketB as never);
    const pending = manager.rpc<{ owner: string }>(
      connectionA,
      "canvas.inspect",
      {},
      1_000,
    );
    const request = rpcRequest(socketA);

    expect(
      manager.handleRpcResponse(connectionB, {
        type: "rpc.response",
        id: request.id,
        result: { owner: "b" },
      }, socketB as never),
    ).toBe(false);
    expect(
      manager.handleRpcResponse(connectionA, {
        type: "rpc.response",
        id: request.id,
        result: { owner: "spoofed-a" },
      }, socketB as never),
    ).toBe(false);

    expect(
      manager.handleRpcResponse(connectionA, {
        type: "rpc.response",
        id: request.id,
        result: { owner: "a" },
      }, socketA as never),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ owner: "a" });
  });

  it("rejects only the closed generation's RPC and preserves a reconnect RPC", async () => {
    const manager = new ConnectionManager();
    const oldSocket = fakeSocket();
    const newSocket = fakeSocket();
    const oldId = manager.register("same-id", "same-user", oldSocket as never);
    const oldPending = manager.rpc(oldId, "old.request", {}, 1_000);
    const newId = manager.register("same-id", "same-user", newSocket as never);
    const newPending = manager.rpc<{ generation: string }>(
      newId,
      "new.request",
      {},
      1_000,
    );
    const newRequest = rpcRequest(newSocket);

    manager.remove(oldId);
    await expect(oldPending).rejects.toThrow("disconnected");
    expect(
      manager.handleRpcResponse(newId, {
        type: "rpc.response",
        id: newRequest.id,
        result: { generation: "new" },
      }, newSocket as never),
    ).toBe(true);
    await expect(newPending).resolves.toEqual({ generation: "new" });
  });

  it("never resolves a retired server ID through an attacker-controlled client ID", () => {
    const manager = new ConnectionManager();
    const victimSocket = fakeSocket();
    const attackerSocket = fakeSocket();
    const retiredVictimId = manager.register(
      "victim-client-id",
      "victim",
      victimSocket as never,
    );
    const attackerId = manager.register(
      retiredVictimId,
      "attacker",
      attackerSocket as never,
    );

    manager.remove(retiredVictimId);
    expect(manager.sendTo(retiredVictimId, { type: "late" })).toBe(false);
    expect(attackerSocket.send).not.toHaveBeenCalled();
    expect(manager.sendTo(attackerId, { type: "current" })).toBe(true);
  });

  it("does not overload RPC connection identity with client IDs or user IDs", async () => {
    const manager = new ConnectionManager();
    const victimSocket = fakeSocket();
    const attackerSocket = fakeSocket();
    manager.register("unrelated", "victim-user-id", victimSocket as never);
    manager.register("victim-user-id", "attacker", attackerSocket as never);

    await expect(
      manager.rpc("victim-user-id", "canvas.inspect", {}),
    ).rejects.toThrow("not available");
    expect(victimSocket.send).not.toHaveBeenCalled();
    expect(attackerSocket.send).not.toHaveBeenCalled();
  });
});
