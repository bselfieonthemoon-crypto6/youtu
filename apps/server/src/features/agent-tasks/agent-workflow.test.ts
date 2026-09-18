import { describe, expect, it, vi } from "vitest";

import type { AgentTaskService, AgentTaskSnapshot } from "./agent-task-service.js";
import {
  AGENT_WORKFLOW_BRIEF_KEY,
  AgentWorkflowError,
  applyTrustedWorkflowEvent,
  createAgentWorkflowController,
  reconcileCorrectionWorkflowPlan,
  reconcileWorkflowPlan,
  selectNextWorkflowStep,
  workflowOperationFingerprint,
  workflowRequirementsFingerprint,
  workflowTargetFingerprint,
  type WorkflowPlanInput,
} from "./agent-workflow.js";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "10000000-0000-4000-8000-000000000002",
  session: "10000000-0000-4000-8000-000000000003",
  canvas: "10000000-0000-4000-8000-000000000004",
  design: "10000000-0000-4000-8000-000000000005",
  otherDesign: "10000000-0000-4000-8000-000000000006",
  object: "10000000-0000-4000-8000-000000000007",
} as const;

function task(overrides: Partial<AgentTaskSnapshot> = {}): AgentTaskSnapshot {
  return {
    id: ids.task,
    revision: 3,
    runId: ids.run,
    sessionId: ids.session,
    canvasId: ids.canvas,
    goal: "制作并核对活动海报",
    corrections: [],
    target: { kind: "design", designId: ids.design },
    brief: { goal: "活动海报", preserve: ["品牌名"] },
    ...overrides,
  };
}

const plan: WorkflowPlanInput = {
  title: "活动海报闭环",
  steps: [
    { stepId: "inspect", title: "读取", intent: "读取当前结构", dependsOn: [] },
    { stepId: "edit", title: "修改", intent: "应用获准修改", dependsOn: ["inspect"] },
    { stepId: "verify", title: "核对", intent: "核对保存结果", dependsOn: ["edit"] },
  ],
};

function advanceCompleted(workflow: ReturnType<typeof reconcileWorkflowPlan>, stepId: string) {
  const started = applyTrustedWorkflowEvent(workflow, {
    type: "execution_started",
    stepId,
  }, "2026-09-09T00:01:00.000Z");
  const submitted = applyTrustedWorkflowEvent(started, {
    type: "job_submitted",
    stepId,
    jobId: `job-${stepId}`,
  }, "2026-09-09T00:02:00.000Z");
  return applyTrustedWorkflowEvent(submitted, {
    type: "job_finished",
    stepId,
    jobId: `job-${stepId}`,
    resultId: `result-${stepId}`,
    outcome: "succeeded",
    verificationRequired: false,
  }, "2026-09-09T00:03:00.000Z");
}

function advanceVerified(workflow: ReturnType<typeof reconcileWorkflowPlan>, stepId: string) {
  const started = applyTrustedWorkflowEvent(workflow, { type: "execution_started", stepId });
  const submitted = applyTrustedWorkflowEvent(started, { type: "job_submitted", stepId, jobId: `job-${stepId}` });
  const finished = applyTrustedWorkflowEvent(submitted, { type: "job_finished", stepId,
    jobId: `job-${stepId}`, resultId: `result-${stepId}`, outcome: "succeeded", verificationRequired: true });
  return applyTrustedWorkflowEvent(finished, { type: "verification_finished", stepId,
    jobId: `job-${stepId}`, resultId: `verification-${stepId}`, outcome: "succeeded" });
}

describe("agent workflow DAG", () => {
  it("retains an unchanged paid correction result for re-verification by default", () => {
    const previousTask = task();
    const oneStep = { title: "image", steps: [{ stepId: "render", title: "Render",
      intent: "Generate the approved board", dependsOn: [] }] } satisfies WorkflowPlanInput;
    const previous = advanceVerified(reconcileWorkflowPlan({ task: previousTask, plan: oneStep }), "render");
    const corrected = task({ revision: 4, runId: "10000000-0000-4000-8000-000000000008",
      corrections: ["Keep the rendered board; only adjust the next board"] });
    const next = reconcileCorrectionWorkflowPlan({ task: corrected, previousTask, previous, plan: oneStep });
    expect(next.steps[0]).toMatchObject({ status: "running", requiresResultReverification: true,
      jobs: ["job-render"], results: [{ kind: "execution", outcome: "succeeded", verificationRequired: true }] });
    expect(next.steps[0]!.results.some(result => result.kind === "verification")).toBe(false);
    expect(selectNextWorkflowStep(next)).toBeNull();
  });

  it("preserves completed only with exact fingerprints and server-issued explicit correction evidence", () => {
    const previousTask = task();
    const oneStep = { title: "image", steps: [{ stepId: "render", title: "Render",
      intent: "Generate the approved board", dependsOn: [] }] } satisfies WorkflowPlanInput;
    const previous = advanceVerified(reconcileWorkflowPlan({ task: previousTask, plan: oneStep }), "render");
    const correctionText = "Keep the rendered board exactly unchanged; only adjust the next board";
    const corrected = task({ revision: 4, runId: "10000000-0000-4000-8000-000000000008",
      corrections: [correctionText] });
    const requirements = workflowRequirementsFingerprint({ copy: "approved", style: "approved" });
    const step = oneStep.steps[0]!;
    const next = reconcileCorrectionWorkflowPlan({ task: corrected, previousTask, previous, plan: oneStep,
      preservationEvidence: [{ source: "server_verified_authenticated_user_correction", taskId: ids.task,
        baseRevision: 3, correctionIndex: 0, correctionText, stepId: "render",
        targetFingerprint: workflowTargetFingerprint(corrected.target),
        operationFingerprint: workflowOperationFingerprint(step),
        previousRequirementsFingerprint: requirements, nextRequirementsFingerprint: requirements }] });
    expect(next.steps[0]).toMatchObject({ status: "completed", requiresResultReverification: false,
      jobs: ["job-render"] });
  });

  it("does not preserve completion when evidence or operation differs", () => {
    const previousTask = task();
    const oldPlan = { title: "image", steps: [{ stepId: "render", title: "Render",
      intent: "Generate the approved board", dependsOn: [] }] } satisfies WorkflowPlanInput;
    const previous = advanceVerified(reconcileWorkflowPlan({ task: previousTask, plan: oldPlan }), "render");
    const correctionText = "Change the completed board to blue";
    const corrected = task({ revision: 4, runId: "10000000-0000-4000-8000-000000000008", corrections: [correctionText] });
    const changed = { title: "image", steps: [{ ...oldPlan.steps[0]!, intent: "Regenerate the approved board in blue" }] };
    const hash = workflowRequirementsFingerprint({ color: "blue" });
    const next = reconcileCorrectionWorkflowPlan({ task: corrected, previousTask, previous, plan: changed,
      preservationEvidence: [{ source: "server_verified_authenticated_user_correction", taskId: ids.task,
        baseRevision: 3, correctionIndex: 0, correctionText, stepId: "render",
        targetFingerprint: workflowTargetFingerprint(corrected.target),
        operationFingerprint: workflowOperationFingerprint(changed.steps[0]!),
        previousRequirementsFingerprint: hash, nextRequirementsFingerprint: hash }] });
    expect(next.steps[0]).toMatchObject({ status: "ready", requiresResultReverification: false,
      jobs: [], results: [] });
  });

  it("requires equal scoped requirement fingerprints and prior server verification", () => {
    const previousTask = task();
    const oneStep = { title: "image", steps: [{ stepId: "render", title: "Render",
      intent: "Generate the approved board", dependsOn: [] }] } satisfies WorkflowPlanInput;
    const previous = advanceCompleted(reconcileWorkflowPlan({ task: previousTask, plan: oneStep }), "render");
    const correctionText = "Keep the existing render if it still satisfies the revised copy";
    const corrected = task({ revision: 4, runId: "10000000-0000-4000-8000-000000000008",
      corrections: [correctionText] });
    const step = oneStep.steps[0]!;
    const next = reconcileCorrectionWorkflowPlan({ task: corrected, previousTask, previous, plan: oneStep,
      preservationEvidence: [{ source: "server_verified_authenticated_user_correction", taskId: ids.task,
        baseRevision: 3, correctionIndex: 0, correctionText, stepId: "render",
        targetFingerprint: workflowTargetFingerprint(corrected.target),
        operationFingerprint: workflowOperationFingerprint(step),
        previousRequirementsFingerprint: workflowRequirementsFingerprint({ copy: "old" }),
        nextRequirementsFingerprint: workflowRequirementsFingerprint({ copy: "revised" }) }] });
    expect(next.steps[0]).toMatchObject({ status: "running", requiresResultReverification: true,
      jobs: ["job-render"] });
  });
  it("derives deterministic readiness while keeping the plan explicitly non-authoritative", () => {
    const workflow = reconcileWorkflowPlan({
      task: task(),
      plan,
      workflowId: "20000000-0000-4000-8000-000000000001",
      now: "2026-09-09T00:00:00.000Z",
    });
    expect(workflow.authority).toBe("planning_snapshot_not_execution_authority");
    expect(workflow.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["inspect", "ready"],
      ["edit", "planned"],
      ["verify", "planned"],
    ]);
    expect(selectNextWorkflowStep(workflow)?.stepId).toBe("inspect");
  });

  it.each([
    {
      code: "agent_workflow_dependency_missing",
      steps: [{ stepId: "a", title: "A", intent: "A", dependsOn: ["missing"] }],
    },
    {
      code: "agent_workflow_cycle",
      steps: [
        { stepId: "a", title: "A", intent: "A", dependsOn: ["b"] },
        { stepId: "b", title: "B", intent: "B", dependsOn: ["a"] },
      ],
    },
    {
      code: "agent_workflow_duplicate_step",
      steps: [
        { stepId: "a", title: "A", intent: "A", dependsOn: [] },
        { stepId: "a", title: "B", intent: "B", dependsOn: [] },
      ],
    },
  ])("rejects invalid graphs: $code", ({ code, steps }) => {
    expect(() => reconcileWorkflowPlan({
      task: task(),
      plan: { title: "invalid", steps },
    })).toThrowError(expect.objectContaining({ code }));
  });

  it("bounds plans to twenty steps", () => {
    expect(() => reconcileWorkflowPlan({
      task: task(),
      plan: {
        title: "too many",
        steps: Array.from({ length: 21 }, (_, index) => ({
          stepId: `step-${index}`,
          title: `Step ${index}`,
          intent: "work",
          dependsOn: [],
        })),
      },
    })).toThrow();
  });

  it("allows cross-artboard planning but marks it non-executable", () => {
    const workflow = reconcileWorkflowPlan({
      task: task({
        target: { kind: "design", designId: ids.design, objectIds: [ids.object] },
      }),
      plan: {
        title: "多画板计划",
        steps: [
          {
            stepId: "other-board",
            title: "另一个画板板",
            intent: "仅记录候选目标",
            dependsOn: [],
            target: { kind: "design", designId: ids.otherDesign },
          },
        ],
      },
    });
    expect(workflow.steps[0]).toMatchObject({
      status: "needs_attention",
      requiresTargetConfirmation: true,
    });
    expect(selectNextWorkflowStep(workflow)).toBeNull();
    expect(() => selectNextWorkflowStep(workflow, "other-board")).toThrowError(
      expect.objectContaining({ code: "agent_workflow_target_not_authorized" }),
    );
    expect(() => applyTrustedWorkflowEvent(workflow, {
      type: "execution_started",
      stepId: "other-board",
    })).toThrowError(expect.objectContaining({
      code: "agent_workflow_target_not_authorized",
    }));
  });

  it("makes only an authenticated canonical scope target executable", () => {
    const other = { kind: "design" as const, designId: ids.otherDesign };
    const workflow = reconcileWorkflowPlan({
      task: task(),
      authorizedTargets: [task().target, other],
      plan: { title: "明确授权多画板", steps: [{ stepId: "other-board", title: "更新第二画板",
        intent: "执行用户明确选择的第二画板", dependsOn: [], target: other }] },
    });
    expect(workflow.steps[0]).toMatchObject({ status: "ready", requiresTargetConfirmation: false });
    expect(selectNextWorkflowStep(workflow, "other-board", [other], task().target)?.target).toEqual(other);
    expect(() => selectNextWorkflowStep(workflow, "other-board", [], task().target))
      .toThrowError(expect.objectContaining({ code: "agent_workflow_target_not_authorized" }));
  });

  it("tracks multiple trusted jobs/results and completes only after required verification", () => {
    let workflow = reconcileWorkflowPlan({ task: task(), plan });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "execution_started", stepId: "inspect",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "proposal_created", stepId: "inspect", proposalId: "proposal-one",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "proposal_created", stepId: "inspect", proposalId: "proposal-two",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", jobId: "job-one",
      proposalId: "proposal-one",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", jobId: "job-two",
      proposalId: "proposal-two",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_finished", stepId: "inspect", jobId: "job-one",
      resultId: "execution-one", outcome: "succeeded", verificationRequired: true,
    });
    expect(workflow.steps[0]).toMatchObject({
      status: "waiting_job",
      proposalIds: ["proposal-one", "proposal-two"],
      jobs: ["job-one", "job-two"],
    });
    expect(workflow.steps[1]?.status).toBe("planned");
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "verification_finished", stepId: "inspect",
      resultId: "verification-one", jobId: "job-one",
      outcome: "succeeded",
    });
    expect(workflow.steps[0]?.status).toBe("waiting_job");
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_finished", stepId: "inspect", jobId: "job-two",
      resultId: "execution-two", outcome: "succeeded", verificationRequired: true,
    });
    expect(workflow.steps[0]?.status).toBe("running");
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "verification_finished", stepId: "inspect",
      resultId: "verification-two", jobId: "job-two",
      outcome: "succeeded",
    });
    expect(workflow.steps[0]?.status).toBe("completed");
    const replayedVerification = applyTrustedWorkflowEvent(workflow, {
      type: "verification_finished", stepId: "inspect",
      resultId: "verification-two", jobId: "job-two",
      outcome: "succeeded",
    });
    expect(replayedVerification.workflowRevision).toBe(workflow.workflowRevision);
    expect(workflow.steps[0]?.results.map((result) => result.kind)).toEqual([
      "execution",
      "verification",
      "execution",
      "verification",
    ]);
    expect(workflow.steps[1]?.status).toBe("ready");
  });

  it("requires a trusted native execution result before verification and sends unavailable review to attention", () => {
    const started = applyTrustedWorkflowEvent(
      reconcileWorkflowPlan({ task: task(), plan }),
      { type: "execution_started", stepId: "inspect" },
    );
    expect(() => applyTrustedWorkflowEvent(started, {
      type: "verification_finished",
      stepId: "inspect",
      resultId: "premature-review",
      outcome: "succeeded",
    })).toThrowError(expect.objectContaining({
      code: "agent_workflow_verification_untrusted",
    }));
    const executed = applyTrustedWorkflowEvent(started, {
      type: "execution_finished",
      stepId: "inspect",
      resultId: "native-execution",
      outcome: "succeeded",
      verificationRequired: true,
    });
    const unavailable = applyTrustedWorkflowEvent(executed, {
      type: "verification_finished",
      stepId: "inspect",
      resultId: "native-review-unavailable",
      outcome: "failed",
      summary: "visual_unavailable",
    });
    expect(unavailable.steps[0]).toMatchObject({
      status: "needs_attention",
      results: expect.arrayContaining([expect.objectContaining({
        kind: "verification",
        outcome: "failed",
        summary: "visual_unavailable",
      })]),
    });
    const verified = applyTrustedWorkflowEvent(executed, {
      type: "verification_finished",
      stepId: "inspect",
      resultId: "native-review",
      outcome: "succeeded",
    });
    expect(verified.steps[0]?.status).toBe("completed");
    expect(verified.steps[1]?.status).toBe("ready");
  });

  it("completes a native execution without review only when the trusted result says verification is unnecessary", () => {
    const started = applyTrustedWorkflowEvent(
      reconcileWorkflowPlan({ task: task(), plan }),
      { type: "execution_started", stepId: "inspect" },
    );
    const completed = applyTrustedWorkflowEvent(started, {
      type: "execution_finished",
      stepId: "inspect",
      resultId: "read-result",
      outcome: "succeeded",
      verificationRequired: false,
    });
    expect(completed.steps[0]?.status).toBe("completed");
  });

  it("never resurrects a failed review when a later job callback arrives", () => {
    let workflow = reconcileWorkflowPlan({ task: task(), plan });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", jobId: "job-one",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", jobId: "job-two",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_finished", stepId: "inspect", jobId: "job-one",
      resultId: "execution-one", outcome: "succeeded", verificationRequired: true,
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "verification_finished", stepId: "inspect", jobId: "job-one",
      resultId: "review-one", outcome: "failed",
    });
    expect(workflow.steps[0]?.status).toBe("needs_attention");
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_finished", stepId: "inspect", jobId: "job-two",
      resultId: "execution-two", outcome: "succeeded", verificationRequired: false,
    });
    expect(workflow.steps[0]?.status).toBe("needs_attention");
    expect(workflow.status).toBe("needs_attention");
  });

  it("rejects job results that were never submitted by the trusted server path", () => {
    const workflow = applyTrustedWorkflowEvent(
      reconcileWorkflowPlan({ task: task(), plan }),
      { type: "execution_started", stepId: "inspect" },
    );
    expect(() => applyTrustedWorkflowEvent(workflow, {
      type: "job_finished",
      stepId: "inspect",
      jobId: "invented-job",
      resultId: "invented-result",
      outcome: "succeeded",
      verificationRequired: false,
    })).toThrowError(expect.objectContaining({
      code: "agent_workflow_job_untrusted",
    }));
  });

  it("binds confirmed jobs to a server-recorded proposal and replays events idempotently", () => {
    let workflow = reconcileWorkflowPlan({ task: task(), plan });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "proposal_created", stepId: "inspect", proposalId: "proposal-one",
    });
    const replayedProposal = applyTrustedWorkflowEvent(workflow, {
      type: "proposal_created", stepId: "inspect", proposalId: "proposal-one",
    });
    expect(replayedProposal.workflowRevision).toBe(workflow.workflowRevision);
    expect(() => applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", jobId: "job-one",
      proposalId: "unknown-proposal",
    })).toThrowError(expect.objectContaining({
      code: "agent_workflow_proposal_untrusted",
    }));
    const submitted = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", jobId: "job-one",
      proposalId: "proposal-one",
    });
    const replayedJob = applyTrustedWorkflowEvent(submitted, {
      type: "job_submitted", stepId: "inspect", jobId: "job-one",
      proposalId: "proposal-one",
    });
    expect(replayedJob.workflowRevision).toBe(submitted.workflowRevision);
    const finished = applyTrustedWorkflowEvent(submitted, {
      type: "job_finished", stepId: "inspect", jobId: "job-one",
      resultId: "result-one", outcome: "succeeded", verificationRequired: false,
    });
    const replayedResult = applyTrustedWorkflowEvent(finished, {
      type: "job_finished", stepId: "inspect", jobId: "job-one",
      resultId: "result-one", outcome: "succeeded", verificationRequired: false,
    });
    expect(replayedResult.workflowRevision).toBe(finished.workflowRevision);
  });

  it("does not complete while another recorded proposal has no submitted job", () => {
    let workflow = reconcileWorkflowPlan({ task: task(), plan });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "proposal_created", stepId: "inspect", proposalId: "proposal-one",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "proposal_created", stepId: "inspect", proposalId: "proposal-two",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", proposalId: "proposal-one", jobId: "job-one",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_finished", stepId: "inspect", jobId: "job-one",
      resultId: "result-one", outcome: "succeeded", verificationRequired: false,
    });
    expect(workflow.steps[0]).toMatchObject({
      status: "waiting_job",
      proposalJobs: { "proposal-one": "job-one" },
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_submitted", stepId: "inspect", proposalId: "proposal-two", jobId: "job-two",
    });
    workflow = applyTrustedWorkflowEvent(workflow, {
      type: "job_finished", stepId: "inspect", jobId: "job-two",
      resultId: "result-two", outcome: "succeeded", verificationRequired: false,
    });
    expect(workflow.steps[0]?.status).toBe("completed");
  });

  it("preserves an unchanged completed result across a task correction but resets changed work", () => {
    const previous = advanceCompleted(
      reconcileWorkflowPlan({ task: task(), plan }),
      "inspect",
    );
    const corrected = task({
      revision: 4,
      runId: "30000000-0000-4000-8000-000000000001",
      corrections: ["改为暖色"],
    });
    const next = reconcileWorkflowPlan({
      task: corrected,
      previous,
      plan: {
        ...plan,
        steps: plan.steps.map((step) =>
          step.stepId === "edit" ? { ...step, intent: "按纠正改为暖色" } : step),
      },
    });
    expect(next.workflowId).toBe(previous.workflowId);
    expect(next.taskRevision).toBe(4);
    expect(next.steps[0]).toMatchObject({
      stepId: "inspect",
      status: "completed",
      jobs: ["job-inspect"],
    });
    expect(next.steps[1]).toMatchObject({ stepId: "edit", status: "ready" });
    expect(next.steps[1]?.results).toEqual([]);
  });
});

describe("persistent workflow controller", () => {
  function fixture(loadAuthorizedTargets?: Parameters<typeof createAgentWorkflowController>[0]["loadAuthorizedTargets"]) {
    let snapshot = task();
    const service = {
      assertCurrentRun: vi.fn(async () => structuredClone(snapshot)),
      updateBrief: vi.fn(async (_runId: string, brief: Record<string, unknown>) => {
        snapshot = { ...snapshot, brief: structuredClone(brief) };
        return structuredClone(snapshot);
      }),
      updateWorkflow: vi.fn(async (
        _runId: string,
        taskRevision: number,
        expectedWorkflowRevision: number | null,
        workflow: Record<string, unknown>,
      ) => {
        if (snapshot.revision !== taskRevision)
          throw new AgentWorkflowError("agent_workflow_task_revision_conflict");
        const current = snapshot.brief?.[AGENT_WORKFLOW_BRIEF_KEY] as
          | { workflowRevision?: number }
          | undefined;
        if ((current?.workflowRevision ?? null) !== expectedWorkflowRevision)
          throw new AgentWorkflowError("agent_workflow_revision_conflict");
        snapshot = {
          ...snapshot,
          brief: {
            ...(snapshot.brief ?? {}),
            [AGENT_WORKFLOW_BRIEF_KEY]: structuredClone(workflow),
          },
        };
        return structuredClone(snapshot);
      }),
    } as unknown as AgentTaskService;
    const runtime = { snapshot, service };
    const controller = createAgentWorkflowController({
      task: runtime,
      ...(loadAuthorizedTargets ? { loadAuthorizedTargets } : {}),
      now: () => "2026-09-09T00:00:00.000Z",
    });
    return {
      controller,
      runtime,
      service,
      setSnapshot(next: AgentTaskSnapshot) { snapshot = next; },
    };
  }

  it("merges workflow state into the existing brief instead of replacing design intent", async () => {
    const f = fixture();
    const workflow = await f.controller.recordPlan(plan);
    expect(f.runtime.snapshot.brief).toMatchObject({
      goal: "活动海报",
      preserve: ["品牌名"],
      [AGENT_WORKFLOW_BRIEF_KEY]: { workflowId: workflow.workflowId },
    });
    expect(await f.controller.readPlan()).toMatchObject({
      workflowId: workflow.workflowId,
    });
  });

  it("refreshes a confirmed canonical scope into a ready cross-board step", async () => {
    const other = { kind: "design" as const, designId: ids.otherDesign };
    let authorized = [task().target];
    const f = fixture(async () => authorized);
    await f.controller.recordPlan({ title: "two boards", steps: [{ stepId: "other-board", title: "Other",
      intent: "Update explicit other board", dependsOn: [], target: other }] });
    expect((await f.controller.readPlan())?.steps[0]).toMatchObject({ status: "needs_attention", requiresTargetConfirmation: true });
    authorized = [task().target, other];
    const refreshed = await f.controller.refreshTargetAuthorization();
    expect(refreshed?.steps[0]).toMatchObject({ status: "ready", requiresTargetConfirmation: false });
    await expect(f.controller.selectNext("other-board")).resolves.toMatchObject({ target: other });
  });

  it("rejects a corrected task revision before writing stale workflow state", async () => {
    const f = fixture();
    f.setSnapshot(task({
      revision: 4,
      runId: "30000000-0000-4000-8000-000000000001",
    }));
    await expect(f.controller.recordPlan(plan)).rejects.toMatchObject({
      code: "agent_workflow_revision_stale",
    });
    expect(f.service.updateBrief).not.toHaveBeenCalled();
  });

  it("serializes concurrent trusted callbacks so job and result updates are not lost locally", async () => {
    const f = fixture();
    await f.controller.recordPlan(plan);
    await f.controller.recordTrustedEvent({
      type: "execution_started", stepId: "inspect",
    });
    await Promise.all([
      f.controller.recordTrustedEvent({
        type: "job_submitted", stepId: "inspect", jobId: "job-a",
      }),
      f.controller.recordTrustedEvent({
        type: "job_submitted", stepId: "inspect", jobId: "job-b",
      }),
    ]);
    expect((await f.controller.readPlan())?.steps[0]?.jobs).toEqual([
      "job-a",
      "job-b",
    ]);
  });
});
