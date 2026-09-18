import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { AgentRunService } from "../agent/runtime.js";
import type { StreamEvent } from "@loomic/shared";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("WebSocket terminal publication active-run ordering", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map(app => app.close()));
    vi.restoreAllMocks();
  });

  async function setup(newTerminal: "run.completed" | "run.canceled" | "run.failed" | "throw") {
    const oldGate = deferred(); const newGate = deferred(); releases.push(oldGate.resolve, newGate.resolve);
    const manager = new ConnectionManager();
    const activeAtPublication: Array<{ runId: string; type: string; active: string | null }> = [];
    const originalPush = manager.pushToCanvas.bind(manager);
    vi.spyOn(manager, "pushToCanvas").mockImplementation(async (canvas, event) => {
      if (["run.completed", "run.failed", "run.canceled"].includes(event.type))
        activeAtPublication.push({ runId: event.runId, type: event.type, active: manager.getActiveRun(canvas)?.runId ?? null });
      await originalPush(canvas, event);
    });
    const agentRuns = {
      createRun: vi.fn((input: { prompt: string }) => ({ conversationId: "canvas", runId: input.prompt, sessionId: `server-session-${input.prompt}`, status: "accepted" })),
      async *streamRun(runId: string) {
        yield { type: "run.started", runId, conversationId: "canvas", sessionId: "session", timestamp: new Date().toISOString() } as StreamEvent;
        await (runId === "old" ? oldGate.promise : newGate.promise);
        if (runId === "new" && newTerminal === "throw") throw new Error("offline stream failure");
        const type = runId === "old" ? "run.completed" : newTerminal;
        yield { type, runId, timestamp: new Date().toISOString(), ...(type === "run.failed" ? { error: { code: "run_failed", message: "offline failure" } } : {}) } as StreamEvent;
      },
    } as unknown as AgentRunService;
    const app = Fastify(); apps.push(app);
    await app.register(websocket);
    await registerWsRoute(app, { agentRuns, connectionManager: manager,
      canvasService: { getCanvas: vi.fn(async () => ({ id: "canvas" })) } as never,
      auth: { async authenticate() {
      return { id: "owner", accessToken: "fake", email: "owner@example.test", userMetadata: {} };
    } } });
    await app.ready();
    const socket = await app.injectWS("/api/ws?token=fake&connectionId=test"); sockets.push(socket);
    socket.on("message", () => { /* consume frames; assertions inspect publication synchronously */ });
    async function start(runId: string) {
      socket.send(JSON.stringify({ type: "command", action: "agent.run", requestId: runId,
        payload: { prompt: runId, conversationId: "canvas", sessionId: "session", model: "apiyi:gemini-test" } }));
      await vi.waitFor(() => expect(manager.getActiveRun("canvas")?.runId).toBe(runId));
    }
    await start("old"); await start("new");
    async function resume() {
      const reply = new Promise<Record<string, any>>(resolve => {
        const onMessage = (raw: Buffer) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "command.ack" && message.action === "canvas.resume") {
            socket.off("message", onMessage); resolve(message.payload);
          }
        };
        socket.on("message", onMessage);
      });
      socket.send(JSON.stringify({ type: "command", action: "canvas.resume", payload: { canvasId: "canvas", lastSeq: 0 } }));
      return reply;
    }
    return { manager, oldGate, newGate, activeAtPublication, resume };
  }

  it.each(["run.completed", "run.canceled", "run.failed", "throw"] as const)(
    "restores the old run before publishing a new run's %s terminal", async terminal => {
      const { manager, oldGate, newGate, activeAtPublication } = await setup(terminal);
      newGate.resolve();
      await vi.waitFor(() => expect(activeAtPublication).toEqual([{ runId: "new", type: terminal === "throw" ? "run.failed" : terminal, active: "old" }]));
      expect(manager.getActiveRun("canvas")?.runId).toBe("old");
      oldGate.resolve();
      await vi.waitFor(() => expect(activeAtPublication.at(-1)).toEqual({ runId: "old", type: "run.completed", active: null }));
    },
  );

  it("an old run completing first never clears the newer consultation", async () => {
    const { manager, oldGate, newGate, activeAtPublication } = await setup("run.completed");
    oldGate.resolve();
    await vi.waitFor(() => expect(activeAtPublication).toEqual([{ runId: "old", type: "run.completed", active: "new" }]));
    expect(manager.getActiveRun("canvas")?.runId).toBe("new");
    newGate.resolve();
    await vi.waitFor(() => expect(manager.getActiveRun("canvas")).toBeNull());
  });

  it("resumes only with the server run's actual session identity, including restored and unknown runs", async () => {
    const { manager, oldGate, newGate, resume } = await setup("run.completed");
    await expect(resume()).resolves.toMatchObject({ activeRunId: "new", activeSessionId: "server-session-new" });
    newGate.resolve();
    await vi.waitFor(() => expect(manager.getActiveRun("canvas")?.runId).toBe("old"));
    await expect(resume()).resolves.toMatchObject({ activeRunId: "old", activeSessionId: "server-session-old" });
    manager.setActiveRun("canvas", "unknown-session");
    await expect(resume()).resolves.toMatchObject({ activeRunId: "unknown-session", activeSessionId: null });
    manager.clearActiveRun("canvas", "unknown-session"); oldGate.resolve();
    await vi.waitFor(() => expect(manager.getActiveRun("canvas")).toBeNull());
    await expect(resume()).resolves.toMatchObject({ activeRunId: null, activeSessionId: null });
  });
});
