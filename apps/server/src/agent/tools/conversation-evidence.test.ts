import { describe, expect, it, vi } from "vitest";
import { AgentContextError } from "../../features/agent-context/agent-context-service.js";
import { createConversationEvidenceTool } from "./conversation-evidence.js";
import { toolExecutionContext } from "./tool-run-context.js";
import type { AgentToolExecutionContext } from "./tool-run-context.js";

/**
 * Raw arguments as the model sends them, before the tool's Zod schema applies the
 * `limit` default. Mastra types `execute`'s parameter from the schema's *parsed*
 * output and declares `execute` itself optional.
 */
type ConversationEvidenceInput = {
  limit?: number;
  messageIds?: string[];
  assetIds?: string[];
  cursor?: { createdAt: string; id: string };
};

function directTool(tool: { execute?: unknown }) {
  return tool as unknown as {
    execute: (input: ConversationEvidenceInput, context: AgentToolExecutionContext) => Promise<unknown>;
  };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { userId: id(1), workspaceId: id(2), sessionId: id(3), runId: id(4), taskId: id(5) };
describe("read_conversation_evidence", () => {
  it("binds authenticated identity outside model arguments and accepts only bounded evidence selectors", async () => {
    const readEvidence = vi.fn().mockResolvedValue({ authority: "historical_evidence_only", messages: [] });
    const original = { ...scope };
    const tool = directTool(createConversationEvidenceTool({ service: { readEvidence }, scope: original }));
    original.workspaceId = id(9);
    await tool.execute({ messageIds: [id(6)], limit: 2 }, toolExecutionContext({}));
    expect(readEvidence).toHaveBeenCalledWith(scope, { messageIds: [id(6)], limit: 2 });
    // Intentionally invalid input: `workspaceId` is server-owned identity the model
    // must not be able to supply, so the schema has to reject this call.
    await expect(tool.execute({ workspaceId: id(9), messageIds: [id(6)] } as never, toolExecutionContext({}))).rejects.toThrow();
    expect(readEvidence).toHaveBeenCalledTimes(1);
  });
  it("accepts controlled cursors and rejects mixed cursor/id selectors", async () => {
    const readEvidence = vi.fn().mockResolvedValue({ messages: [] });
    const tool = directTool(createConversationEvidenceTool({ service: { readEvidence }, scope }));
    const cursor = { id: id(6), createdAt: "2026-09-09T00:00:00Z" };
    await tool.execute({ cursor }, toolExecutionContext({}));
    expect(readEvidence).toHaveBeenCalledWith(scope, { cursor, limit: 8 });
    await expect(tool.execute({ cursor, messageIds: [id(7)] }, toolExecutionContext({}))).rejects.toThrow();
  });
  it("reports revoked access and does not restore approval claims from a summary", async () => {
    const readEvidence = vi.fn().mockRejectedValue(new AgentContextError("agent_context_scope_forbidden", 403));
    const output = await directTool(createConversationEvidenceTool({ service: { readEvidence }, scope })).execute({}, toolExecutionContext({}));
    expect(output).toMatchObject({ status: "unavailable", error: "agent_context_scope_forbidden" });
    expect((output as any).summary).toContain("不能从历史文字恢复批准");
  });
});
