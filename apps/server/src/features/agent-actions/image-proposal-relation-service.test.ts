import { describe, expect, it, vi } from "vitest";
import { createImageProposalRelationService } from "./image-proposal-relation-service.js";

const relationContext = {
  proposalId: "10000000-0000-4000-8000-000000000001",
  proposalInput: { title: "Banner" },
  requirement: { id: "10000000-0000-4000-8000-000000000002", content: "保存横幅方案" },
  turns: [{ id: "10000000-0000-4000-8000-000000000003", content: "这符合品牌吗？" }],
  hasMore: false,
};
const scope = {
  userId: "10000000-0000-4000-8000-000000000004",
  sessionId: "10000000-0000-4000-8000-000000000005",
  canvasId: "10000000-0000-4000-8000-000000000006",
  runId: "10000000-0000-4000-8000-000000000007",
  signal: new AbortController().signal,
};

describe("image proposal relation service", () => {
  it("records only the exact server-loaded classified turns", async () => {
    const rpc = vi.fn(async (name: string) => name === "loomic_get_image_proposal_relation_context"
      ? { data: relationContext, error: null } : { data: true, error: null });
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.reconcile({ ...scope, reviewer: vi.fn(async () => [
      { messageId: relationContext.turns[0]!.id, relation: "preserve" as const },
    ]) })).resolves.toBe("recorded");
    expect(rpc).toHaveBeenLastCalledWith("loomic_record_image_proposal_turn_relations", {
      p_user: scope.userId, p_session: scope.sessionId, p_canvas: scope.canvasId, p_run: scope.runId,
      p_proposal: relationContext.proposalId,
      p_relations: [{ message_id: relationContext.turns[0]!.id, relation: "preserve" }],
    });
  });

  it("does not persist unknown or mismatched reviewer output", async () => {
    const rpc = vi.fn(async () => ({ data: relationContext, error: null }));
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.reconcile({ ...scope, reviewer: async () => [
      { messageId: relationContext.turns[0]!.id, relation: "unknown" },
    ] })).resolves.toBe("unknown");
    await expect(service.reconcile({ ...scope, reviewer: async () => [
      { messageId: "10000000-0000-4000-8000-000000000099", relation: "preserve" },
    ] })).resolves.toBe("unknown");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not truncate an oversized user change into an authorizable classification", async () => {
    const oversized = { ...relationContext, turns: [{ ...relationContext.turns[0]!, content: "改".repeat(16_001) }] };
    const rpc = vi.fn(async () => ({ data: oversized, error: null }));
    const reviewer = vi.fn();
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.reconcile({ ...scope, reviewer })).resolves.toBe("unknown");
    expect(reviewer).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("binds only a reviewed assistant anchor returned by the server context", async () => {
    const assistantId = "10000000-0000-4000-8000-000000000008";
    const context = { proposalId: relationContext.proposalId, proposal: { title: "Banner", inputImageCount: 0 },
      messages: [{ id: assistantId, role: "assistant", content: "想生成时告诉我一声即可，我再提交任务。" }] };
    const rpc = vi.fn(async (name: string) => name === "loomic_get_contextual_image_confirmation_review"
      ? { data: context, error: null } : { data: relationContext.proposalId, error: null });
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.bindContextualConfirmation({ ...scope, reviewer: async () => ({
      decision: "invite", assistantMessageId: assistantId,
    }) })).resolves.toBe(relationContext.proposalId);
    expect(rpc).toHaveBeenLastCalledWith("loomic_bind_reviewed_contextual_image_confirmation", expect.objectContaining({
      p_proposal: relationContext.proposalId, p_assistant_message: assistantId,
    }));
  });

  it("does not bind a model-invented assistant anchor", async () => {
    const context = { proposalId: relationContext.proposalId, proposal: { inputImageCount: 0 },
      messages: [{ id: "10000000-0000-4000-8000-000000000008", role: "assistant", content: "继续讨论" }] };
    const rpc = vi.fn(async () => ({ data: context, error: null }));
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.bindContextualConfirmation({ ...scope, reviewer: async () => ({
      decision: "invite", assistantMessageId: "10000000-0000-4000-8000-000000000099",
    }) })).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
  });

  const semanticContext = {
    currentMessage: { id: "10000000-0000-4000-8000-000000000009", content: "缺定生成" },
    proposal: { id: relationContext.proposalId, status: "pending", title: "Banner", inputImageCount: 0,
      jobStatus: null, hasTrustedInvitation: true },
    recentDialogue: [{ role: "assistant" as const, content: "如果满意我就提交生成。" }],
  };

  it("binds an existing semantic confirmation to the server-loaded proposal, never a model ID", async () => {
    const rpc = vi.fn(async (name: string) => name === "loomic_get_semantic_image_confirmation_review"
      ? { data: semanticContext, error: null } : { data: relationContext.proposalId, error: null });
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.reviewSemanticConfirmation({ ...scope,
      reviewer: async () => ({ decision: "confirm_existing" }),
    })).resolves.toEqual({ decision: "confirm_existing", confirmationId: relationContext.proposalId });
    expect(rpc).toHaveBeenLastCalledWith("loomic_bind_reviewed_semantic_image_confirmation", {
      p_user: scope.userId, p_session: scope.sessionId, p_canvas: scope.canvasId,
      p_run: scope.runId, p_proposal: relationContext.proposalId,
    });
  });

  it("treats current-run review as routing until the exact frozen proposal is reviewed again", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "loomic_get_semantic_image_confirmation_review" ||
          name === "loomic_get_semantic_current_run_image_confirmation_review")
        return { data: semanticContext, error: null };
      return { data: relationContext.proposalId, error: null };
    });
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.reviewSemanticConfirmation({ ...scope,
      reviewer: async () => ({ decision: "confirm_current_run" }),
    })).resolves.toEqual({ decision: "confirm_current_run" });
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(service.bindSemanticCurrentRunProposal({ ...scope, proposalId: relationContext.proposalId,
      reviewer: async () => ({ decision: "confirm_current_run" }),
    })).resolves.toBe(relationContext.proposalId);
    expect(rpc).toHaveBeenLastCalledWith("loomic_bind_reviewed_semantic_current_run_image_confirmation",
      expect.objectContaining({ p_proposal: relationContext.proposalId }));
  });

  it("does not bind when post-freeze semantic review becomes ambiguous", async () => {
    const rpc = vi.fn(async () => ({ data: semanticContext, error: null }));
    const service = createImageProposalRelationService(() => ({ rpc }) as any);
    await expect(service.bindSemanticCurrentRunProposal({ ...scope, proposalId: relationContext.proposalId,
      reviewer: async () => ({ decision: "unknown" }),
    })).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
  });
});
