import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSocket } from "../src/hooks/use-websocket";
import { agentStartErrorMessage } from "../src/lib/agent-start-error";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: any[] = [];
  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());
const payload = { sessionId: "s", conversationId: "c", prompt: "edit" };
describe("Agent start acknowledgement", () => {
  it("sends refreshed credentials and reports the correlated server rejection immediately", () => {
    let token = "old";
    const getToken = () => token;
    const { result, unmount } = renderHook(() => useWebSocket(getToken));
    token = "fresh";
    const error = vi.fn();
    act(() => result.current.startRun(payload, vi.fn(), error));
    const socket = FakeSocket.instances[0]!;
    expect(socket.sent[0].accessToken).toBe("fresh");
    act(() =>
      socket.emit({
        type: "error",
        action: "agent.run",
        requestId: socket.sent[0].requestId,
        message: "Canvas not found or access denied",
      }),
    );
    expect(error).toHaveBeenCalledOnce();
    expect(agentStartErrorMessage(error.mock.calls[0]![0])).toContain("画布");
    unmount();
  });
  it("discards canceled/late acknowledgements instead of binding them to the next run", () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    const first = vi.fn(),
      second = vi.fn();
    let cancel: void | (() => void);
    act(() => {
      cancel = result.current.startRun(payload, first);
    });
    const socket = FakeSocket.instances[0]!;
    act(() => {
      if (typeof cancel === "function") cancel();
      result.current.startRun(payload, second);
    });
    act(() =>
      socket.emit({
        type: "command.ack",
        action: "agent.run",
        requestId: socket.sent[0].requestId,
        payload: { runId: "old" },
      }),
    );
    expect(second).not.toHaveBeenCalled();
    act(() =>
      socket.emit({
        type: "command.ack",
        action: "agent.run",
        requestId: socket.sent[1].requestId,
        payload: { runId: "new" },
      }),
    );
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    unmount();
  });
  it("rejects immediately when disconnected", () => {
    const { result, unmount } = renderHook(() => useWebSocket(() => "token"));
    FakeSocket.instances[0]!.readyState = 3;
    const error = vi.fn();
    act(() => result.current.startRun(payload, vi.fn(), error));
    expect(error).toHaveBeenCalledOnce();
    unmount();
  });
  it("rejects a second pending start without sending another command", () => {
    const getToken = () => "token";
    const { result, unmount } = renderHook(() => useWebSocket(getToken));
    const error = vi.fn();
    act(() => {
      result.current.startRun(payload);
      result.current.startRun(payload, vi.fn(), error);
    });
    expect(FakeSocket.instances[0]!.sent).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
    unmount();
  });
  it("returns authentication rejection to destructive confirmation instead of hanging", () => {
    const getToken = () => "token";
    const { result, unmount } = renderHook(() => useWebSocket(getToken));
    const ack = vi.fn();
    act(() => result.current.confirmAction("id", "confirm", ack));
    act(() =>
      FakeSocket.instances[0]!.emit({
        type: "error",
        action: "agent.confirm_action",
        code: "authentication_required",
        message: "登录状态已失效",
      }),
    );
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "failed",
          code: "authentication_required",
        }),
      }),
    );
    unmount();
  });
});
