import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";

afterEach(() => vi.restoreAllMocks());

describe("ConnectionManager active run stack", () => {
  it("restores an older still-running task after the newer consultation completes", () => {
    const manager = new ConnectionManager();
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    manager.setActiveRun("canvas", "old-design");
    manager.setActiveRun("canvas", "new-consultation");
    expect(manager.getActiveRun("canvas")).toEqual({ runId: "new-consultation", startedAt: 200 });
    manager.clearActiveRun("canvas", "new-consultation");
    expect(manager.getActiveRun("canvas")).toEqual({ runId: "old-design", startedAt: 100 });
    manager.clearActiveRun("canvas", "old-design");
    expect(manager.getActiveRun("canvas")).toBeNull();
  });

  it("an out-of-order old terminal cannot erase a newer run or reappear later", () => {
    const manager = new ConnectionManager();
    for (const id of ["old", "middle", "new"]) manager.setActiveRun("canvas", id);
    manager.clearActiveRun("canvas", "old");
    manager.clearActiveRun("canvas", "middle");
    expect(manager.getActiveRun("canvas")?.runId).toBe("new");
    manager.clearActiveRun("canvas", "new");
    expect(manager.getActiveRun("canvas")).toBeNull();
  });

  it("duplicate starts and repeated terminal cleanup are idempotent", () => {
    const manager = new ConnectionManager();
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    manager.setActiveRun("canvas", "old"); manager.setActiveRun("canvas", "new");
    manager.setActiveRun("canvas", "old");
    expect(manager.getActiveRun("canvas")).toEqual({ runId: "new", startedAt: 200 });
    manager.clearActiveRun("canvas", "new"); manager.clearActiveRun("canvas", "new");
    expect(manager.getActiveRun("canvas")).toEqual({ runId: "old", startedAt: 100 });
    manager.clearActiveRun("canvas", "missing");
    expect(manager.getActiveRun("canvas")?.runId).toBe("old");
  });

  it("isolates canvases and does not expose a mutable internal entry", () => {
    const manager = new ConnectionManager();
    manager.setActiveRun("a", "run-a"); manager.setActiveRun("b", "run-b");
    const external = manager.getActiveRun("a")!; external.runId = "tampered";
    manager.clearActiveRun("a", "run-b");
    expect(manager.getActiveRun("a")?.runId).toBe("run-a");
    expect(manager.getActiveRun("b")?.runId).toBe("run-b");
    manager.dispose();
    expect(manager.getActiveRun("a")).toBeNull(); expect(manager.getActiveRun("b")).toBeNull();
  });

  it("restores each run's own session and leaves unknown identity unknown", () => {
    const manager = new ConnectionManager();
    manager.setActiveRun("canvas", "old", "session-a");
    manager.setActiveRun("canvas", "new", "session-b");
    expect(manager.getActiveRun("canvas")).toMatchObject({ runId: "new", sessionId: "session-b" });
    manager.setActiveRun("canvas", "new", "cannot-rebind-existing-run");
    expect(manager.getActiveRun("canvas")?.sessionId).toBe("session-b");
    manager.clearActiveRun("canvas", "new");
    expect(manager.getActiveRun("canvas")).toMatchObject({ runId: "old", sessionId: "session-a" });
    manager.setActiveRun("canvas", "unknown");
    expect(manager.getActiveRun("canvas")?.sessionId).toBeUndefined();
  });
});
