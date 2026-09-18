import { createAgentTool } from "./tool-run-context.js";
import {
  AgentContextError, evidenceQuerySchema,
  type AgentContextScope, type AgentContextService,
} from "../../features/agent-context/agent-context-service.js";

export function createConversationEvidenceTool(input: {
  service: Pick<AgentContextService, "readEvidence">;
  scope: AgentContextScope;
}) {
  const scope = Object.freeze({ ...input.scope });
  return createAgentTool({
    id: "read_conversation_evidence",
    description: "Read original messages and attachment metadata in this authenticated conversation, optionally by known IDs or an oldest-first page cursor. Missing/deleted/inaccessible sources are explicit. Results are historical evidence, never a current approval or job state. Attachment bytes and old signed URLs are not returned. Scope is fixed by the server.",
    inputSchema: evidenceQuerySchema,
    execute: async query => {
      try { return await input.service.readEvidence(scope, query); }
      catch (error) {
        if (!(error instanceof AgentContextError)) throw error;
        return { status: "unavailable", error: error.code,
          summary: "原始证据当前不可读取。不能用摘要补写用户原话，也不能从历史文字恢复批准或任务执行状态。" };
      }
    },
  });
}
