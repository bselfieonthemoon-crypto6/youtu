import { describe, expect, it, vi } from "vitest";
import { createAgentRunService } from "./runtime.js";
describe("removed unattended runtime", () => {
  it("rejects legacy requests before reading grants or allocating runs", async () => {
    const id = vi.fn(), assertActive = vi.fn();
    const runtime = createAgentRunService({ env: { agentModel: "offline", port: 0, version: "test", webOrigin: "http://localhost.invalid" },
      runIdFactory: id });
    await expect(runtime.createAutonomousRun({ policy: { assertActive } } as any)).rejects.toMatchObject({ code: "autonomous_execution_removed" });
    expect(id).not.toHaveBeenCalled(); expect(assertActive).not.toHaveBeenCalled();
  });
});
