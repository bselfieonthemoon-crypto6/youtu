import { describe, expect, it, vi } from "vitest";
import { createAgentContextService } from "./agent-context-service.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { userId: id(1), workspaceId: id(2), sessionId: id(3), runId: id(4) };
const capture = { contextRevision: 4, sourceWatermark: "source-4", historyEpoch: 0, taskChainId: null, taskRevision: null,
  designRevision: null, snapshot: null, executionStatePolicy: "reload_live_authority" };
const payload = { expectedContextRevision: 4, sourceWatermark: "source-4", summary: "Earlier discussion, not execution authority.",
  coverage: { messageIds: [id(6)], omissions: ["Original attachment bytes omitted."] }, modelVersion: "configured-v1", budgetPolicyVersion: "context-v1" };
const saved = { id: id(5), contextRevision: 5, sourceWatermark: "source-4", taskChainId: null, taskRevision: null,
  designRevision: null, summary: payload.summary, coverage: { ...payload.coverage, assetIds: [] }, contentHash: "hash",
  modelVersion: "configured-v1", budgetPolicyVersion: "context-v1", createdAt: "2026-09-09T00:00:00Z" };

describe("durable conversation context", () => {
  it("captures ordinary chat without creating or advancing a design task", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: capture, error: null });
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    expect(await service.capture(scope)).toEqual(capture);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("loomic_agent_context_capture", {
      p_user: id(1), p_workspace: id(2), p_session: id(3), p_run: id(4), p_task: null,
    });
  });
  it("persists the captured CAS revision and source watermark without inventing authority", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: saved, error: null });
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    expect(await service.commit(scope, payload)).toEqual(saved);
    expect(rpc.mock.calls[0]?.[1].p_payload).toEqual({ ...payload, coverage: { ...payload.coverage, assetIds: [] } });
    await expect(service.commit(scope, { ...payload, executionState: { approved: true } } as never)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["agent_context_scope_forbidden", 403], ["agent_context_task_forbidden", 403],
    ["agent_context_commit_conflict", 409], ["agent_context_task_superseded", 409], ["agent_context_source_missing", 409],
  ])("preserves %s and does not retry a stale commit", async (code, statusCode) => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: `private original text ${code}` }, data: null });
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.commit(scope, payload)).rejects.toMatchObject({ message: code, code, statusCode });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("reauthorizes every capture and read instead of caching a previous tenant response", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: capture, error: null })
      .mockResolvedValue({ data: null, error: { message: "agent_context_scope_forbidden" } });
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    await service.current(scope);
    await expect(service.current(scope)).rejects.toMatchObject({ code: "agent_context_scope_forbidden" });
    await expect(service.readEvidence(scope)).rejects.toMatchObject({ code: "agent_context_scope_forbidden" });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it("requires the history epoch rather than treating a missing invalidation version as zero", async () => {
    const { historyEpoch: _epoch, ...legacy } = capture;
    const rpc = vi.fn().mockResolvedValueOnce({ data: { ...capture, historyEpoch: 3 }, error: null })
      .mockResolvedValue({ data: legacy, error: null });
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.capture(scope)).resolves.toMatchObject({ historyEpoch: 3 });
    await expect(service.capture(scope)).rejects.toThrow();
  });
  it("keeps source missing markers and attachment metadata while omitting incidental storage fields", async () => {
    const evidence = { messages: [], attachments: [{ id: id(6), mimeType: "image/png", byteSize: 123,
      createdAt: "2026-09-09T00:00:00Z", object_path: "private/path", url: "old-signed-url" }],
      missingMessageIds: [id(7)], missingAssetIds: [id(8)], nextCursor: null,
      sourceWatermark: "source-4", contextRevision: 4, authority: "historical_evidence_only" };
    const rpc = vi.fn().mockResolvedValue({ data: evidence, error: null });
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    const output = await service.readEvidence(scope, { messageIds: [id(7)], assetIds: [id(8)] });
    expect(output.missingMessageIds).toEqual([id(7)]);
    expect(output.attachments[0]).not.toHaveProperty("object_path");
    expect(output.attachments[0]).not.toHaveProperty("url");
    expect(rpc.mock.calls[0]?.[1].p_query.limit).toBe(8);
  });
  it("rejects unbounded payloads before touching persistence", async () => {
    const rpc = vi.fn();
    const service = createAgentContextService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.commit(scope, { ...payload, publicPlan: "x".repeat(300000) })).rejects.toMatchObject({ code: "agent_context_payload_invalid" });
    await expect(service.readEvidence(scope, { limit: 1000 })).rejects.toThrow();
    await expect(service.readEvidence(scope, { workspaceId: id(8) } as never)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
