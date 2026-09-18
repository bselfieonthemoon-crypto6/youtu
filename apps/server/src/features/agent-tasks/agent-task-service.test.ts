import { describe, expect, it, vi } from "vitest";
import { createAgentTaskService, isAgentTaskAttachmentRejected, type BeginAgentTaskInput } from "./agent-task-service.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const snapshot = {
  id: id(1), revision: 2, runId: id(2), sessionId: id(3), canvasId: id(4),
  goal: "Keep the layout and make the heading softer", corrections: ["Preserve the footer too"],
  target: { kind: "design", designId: id(5) }, brief: null,
};

describe("durable agent design intent", () => {
  it("registers a plain canvas review only when background identity is configured", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const options = { getAdminClient: () => ({ rpc }) as never };
    expect(createAgentTaskService(options).registerCanvasResultReview).toBeUndefined();
    const service = createAgentTaskService({ ...options, atomicAutonomy: { defaultEnabled: false } });
    await service.registerCanvasResultReview!({ userId: id(1), sessionId: id(2), runId: id(3), jobId: id(4) });
    expect(rpc).toHaveBeenCalledWith("loomic_register_canvas_result_review", {
      p_user: id(1), p_session: id(2), p_run: id(3), p_job: id(4),
    });
  });
  it("passes explicit correction identity and omission to the atomic database transition", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.begin({ userId: id(6), runId: id(2), sessionId: id(3), canvasId: id(4),
      prompt: "Preserve the footer too", correctionOfRunId: id(7) })).resolves.toEqual(snapshot);
    expect(rpc).toHaveBeenCalledWith("loomic_agent_task_begin", {
      p_user: id(6), p_run: id(2), p_session: id(3), p_canvas: id(4), p_prompt: "Preserve the footer too",
      p_correction_of: id(7), p_target: null,
    });
  });

  it("normalizes empty design selection to whole design and rejects incomplete canvas targets", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const input = { userId: id(6), runId: id(2), sessionId: id(3), canvasId: id(4), prompt: "Refine heading" };
    await service.begin({ ...input, target: { kind: "design", designId: id(5), objectIds: [] } });
    expect(rpc.mock.calls[0]?.[1].p_target).toEqual({ kind: "design", designId: id(5) });
    await expect(service.begin({ ...input, target: { kind: "canvas_image", elementId: "image" } as never })).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("leaves ordinary untracked chat unaffected and retrieves the durable snapshot on a new service", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: snapshot, error: null });
    await expect(createAgentTaskService({ getAdminClient: () => ({ rpc }) as never }).assertCurrentRun(id(8))).resolves.toBeNull();
    await expect(createAgentTaskService({ getAdminClient: () => ({ rpc }) as never }).getCurrent(id(6), id(3))).resolves.toEqual(snapshot);
  });

  it.each([
    ["agent_task_superseded", 409], ["agent_task_correction_conflict", 409],
    ["agent_task_target_forbidden", 403], ["agent_task_brief_invalid", 400],
  ])("preserves %s as a structured failure", async (message, statusCode) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message } });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.assertCurrentRun(id(2))).rejects.toMatchObject({ code: message, statusCode });
  });

  it("does not let stale work persist its brief", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "agent_task_superseded" } });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.updateBrief(id(7), { goal: "Old goal" })).rejects.toMatchObject({ code: "agent_task_superseded" });
  });

  it("sends task and workflow revisions to the dedicated CAS persistence RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...snapshot, brief: { agentWorkflow: { workflowRevision: 4 } } },
      error: null,
    });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.updateWorkflow!(id(2), 2, 3, {
      version: 1,
      workflowRevision: 4,
    })).resolves.toMatchObject({ revision: 2 });
    expect(rpc).toHaveBeenCalledWith("loomic_agent_task_update_workflow", {
      p_run: id(2),
      p_task_revision: 2,
      p_expected_workflow_revision: 3,
      p_workflow: { version: 1, workflowRevision: 4 },
    });
  });

  it("distinguishes superseded attachments from provider failures", () => {
    expect(isAgentTaskAttachmentRejected(new Error("Failed to write canvas: agent_task_superseded"))).toBe(true);
    expect(isAgentTaskAttachmentRejected({ message: "agent_task_target_mismatch" })).toBe(true);
    expect(isAgentTaskAttachmentRejected(new Error("provider quota exceeded"))).toBe(false);
  });
});

describe("read-only intent preparation and CAS activation", () => {
  const input: BeginAgentTaskInput = { userId: id(6), runId: id(2), sessionId: id(3), canvasId: id(4),
    prompt: "Keep the original title\n原文字体不变", target: { kind: "design", designId: id(5), objectIds: [id(50)] } };
  const candidate = () => ({ ...structuredClone(snapshot), goal: input.prompt, corrections: [], target: structuredClone(input.target!), brief: null });
  const preparedValue = () => ({ snapshot: candidate(), baseTaskId: id(1), baseRevision: 1, baseRunId: id(7) });

  it("only calls the read-only prepare RPC and freezes the source-bearing result", async () => {
    const raw = preparedValue();
    const rpc = vi.fn().mockResolvedValue({ data: raw, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("loomic_agent_task_prepare", {
      p_user: input.userId, p_run: input.runId, p_session: input.sessionId, p_canvas: input.canvasId,
      p_prompt: input.prompt, p_target: input.target, p_correction_of: null,
    });
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.snapshot)).toBe(true);
    expect(Object.isFrozen(prepared.snapshot.target)).toBe(true); expect(Object.isFrozen(prepared.snapshot.corrections)).toBe(true);
    expect(() => { prepared.snapshot.goal = "model rewrite"; }).toThrow();
    raw.snapshot.goal = "changed mock transport result";
    expect(prepared.snapshot.goal).toBe(input.prompt);
  });

  it("passes the prepared CAS base and identical original input to one activate RPC", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: preparedValue(), error: null }).mockResolvedValueOnce({ data: candidate(), error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    await expect(service.activate(input, prepared)).resolves.toEqual(candidate());
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(["loomic_agent_task_activate", {
      p_user: input.userId, p_run: input.runId, p_session: input.sessionId, p_canvas: input.canvasId,
      p_prompt: input.prompt, p_target: input.target, p_correction_of: null, p_prepared: prepared,
    }]);
    expect(rpc.mock.calls.some(([name]) => name === "loomic_agent_task_begin")).toBe(false);
  });

  it("activates and enrolls through one RPC when automatic execution is configured", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: preparedValue(), error: null }).mockResolvedValueOnce({ data: candidate(), error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never, atomicAutonomy: { defaultEnabled: true } });
    const prepared = await service.prepare(input);
    await service.activate(input, prepared);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(["loomic_agent_task_activate_autonomous", expect.objectContaining({ p_prepared: prepared, p_default_enabled: true })]);
  });

  it("uses a provisional run ID only for a new prepared task and accepts its real activated ID", async () => {
    const newCandidate = { ...candidate(), id: input.runId, revision: 1 };
    const actual = { ...newCandidate, id: id(90) };
    const rpc = vi.fn().mockResolvedValueOnce({ data: { snapshot: newCandidate, baseTaskId: null, baseRevision: null, baseRunId: null }, error: null })
      .mockResolvedValueOnce({ data: actual, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    await expect(service.activate(input, prepared)).resolves.toEqual(actual);
    expect(prepared.snapshot.id).toBe(input.runId);
  });

  it.each([
    { prompt: "Rewrite the user's original words" }, { userId: id(19) }, { runId: id(20) }, { sessionId: id(21) },
    { canvasId: id(22) }, { target: { kind: "design" as const, designId: id(25) } }, { correctionOfRunId: id(29) },
  ])("rejects changing prepared identity, original text or scope before the DB call: %j", async (change) => {
    const rpc = vi.fn().mockResolvedValue({ data: preparedValue(), error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    await expect(service.activate({ ...input, ...change }, prepared)).rejects.toMatchObject({ code: "agent_task_activation_conflict", statusCode: 409 });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("rejects reconstructed model output or a different service's handle", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: preparedValue(), error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    await expect(service.activate(input, structuredClone(prepared))).rejects.toMatchObject({ code: "agent_task_activation_conflict" });
    await expect(createAgentTaskService({ getAdminClient: () => ({ rpc }) as never }).activate(input, prepared)).rejects.toMatchObject({ code: "agent_task_activation_conflict" });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("preserves correction identity and lets the database inherit the prior goal and target", async () => {
    const correction = { ...input, target: undefined, correctionOfRunId: id(7), prompt: "保留页脚原文，不要红色" };
    const { target: _target, ...withoutTarget } = correction;
    const correctionCandidate = { ...candidate(), goal: "Original user goal", corrections: [correction.prompt] };
    const rpc = vi.fn().mockResolvedValueOnce({ data: { ...preparedValue(), snapshot: correctionCandidate }, error: null })
      .mockResolvedValueOnce({ data: correctionCandidate, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(withoutTarget);
    await service.activate(withoutTarget, prepared);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_target: null, p_correction_of: id(7), p_prompt: correction.prompt });
    expect(prepared.snapshot.goal).toBe("Original user goal");
  });

  it("reports a late activation CAS conflict without retrying or invoking legacy begin", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: preparedValue(), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "agent_task_activation_conflict" } });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    await expect(service.activate(input, prepared)).rejects.toMatchObject({ code: "agent_task_activation_conflict", statusCode: 409 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each(["agent_task_session_forbidden", "agent_task_target_forbidden", "agent_task_service_role_forbidden", "agent_task_correction_conflict"])
    ("fails a rejected preparation without touching activate: %s", async message => {
      const rpc = vi.fn().mockResolvedValue({ data: null, error: { message } });
      const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
      await expect(service.prepare(input)).rejects.toMatchObject({ code: message });
      expect(rpc).toHaveBeenCalledOnce(); expect(rpc.mock.calls[0]![0]).toBe("loomic_agent_task_prepare");
    });

  it("does not accept malformed or scope-mismatched prepare responses", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { ...preparedValue(), baseRevision: null }, error: null })
      .mockResolvedValueOnce({ data: { ...preparedValue(), snapshot: { ...candidate(), sessionId: id(80) } }, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    await expect(service.prepare(input)).rejects.toThrow();
    await expect(service.prepare(input)).rejects.toMatchObject({ code: "agent_task_preparation_invalid" });
  });

  it("rejects an activated snapshot for a different intent, even when its run ID matches", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: preparedValue(), error: null })
      .mockResolvedValueOnce({ data: { ...candidate(), goal: "Unexpected rewritten intent" }, error: null });
    const service = createAgentTaskService({ getAdminClient: () => ({ rpc }) as never });
    const prepared = await service.prepare(input);
    await expect(service.activate(input, prepared)).rejects.toMatchObject({ code: "agent_task_activation_conflict" });
  });
});
