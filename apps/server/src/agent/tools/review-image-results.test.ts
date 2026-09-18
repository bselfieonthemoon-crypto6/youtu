import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { createReviewImageResultsTool } from "./review-image-results.js";
import { reconcileWorkflowPlan, applyTrustedWorkflowEvent } from "../../features/agent-tasks/agent-workflow.js";
import { toolExecutionContext } from "./tool-run-context.js";
import type { AgentToolExecutionContext } from "./tool-run-context.js";

/**
 * Raw arguments as the model sends them, before the tool's Zod schema applies
 * defaults (`result_asset_ids`, `prompt_library_case_ids`, `comparison` all
 * default). Mastra types `execute`'s parameter from the schema's *parsed* output
 * and declares `execute` itself optional, so these direct calls use the view
 * below instead of repeating every defaulted field at each call site.
 */
type ReviewToolInput = {
  mode?: "result_verification" | "reference_analysis";
  job_id?: string;
  result_asset_ids?: string[];
  prompt_library_case_ids?: string[];
  comparison?: "individual" | "series" | "before_after";
};

/** Receipt fields these assertions read; the tool also returns other fields. */
type ReviewToolResult = {
  status?: "passed" | "unavailable";
  error?: string;
  summary?: string;
  viewed?: boolean;
  acceptanceRecorded?: boolean;
  reviewMode?: string;
  reviewed?: Array<{ id: string; source: string; role: string }>;
};

/** Keep the tool's own properties, but make `execute` required and callable with raw input. */
function directTool<T extends { execute?: unknown }>(tool: T) {
  return tool as unknown as Omit<T, "execute"> & {
    execute: (input: ReviewToolInput, context: AgentToolExecutionContext) => Promise<ReviewToolResult>;
  };
}

async function fixture(resultReviewScope?: { jobId: string; assetIds: string[] }) {
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#22c55e" } }).png().toBuffer();
  const assetId = "10000000-0000-4000-8000-000000000001";
  const result = { assetId, workspaceId: "20000000-0000-4000-8000-000000000002" };
  const filters = new Map<string, unknown>();
  const query: any = {
    select: () => query,
    eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
    is: (key: string, value: unknown) => { filters.set(key, value); return query; },
    single: async () => ({ data: {
      id: assetId, bucket: "workspace-assets", object_path: "result.png", mime_type: "image/png",
      byte_size: bytes.byteLength, workspace_id: result.workspaceId, deletion_pending_at: null,
    }, error: null }),
  };
  const client: any = { from: vi.fn(() => query), storage: { from: vi.fn(() => ({ download: async () => ({
    data: { size: bytes.byteLength, type: "image/png", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null,
  }) })) } };
  const generate = vi.fn(async (_input: unknown) => ({
    text: '{"blockingIssues":[],"suggestions":[],"uncertainties":[]}', usage: {},
  }));
  const snapshot: any = {
    id: "task", revision: 3, runId: "run", sessionId: "session", canvasId: "canvas", goal: "保持商品完整",
    corrections: [], target: { kind: "canvas_image", elementId: "element", assetId: "30000000-0000-4000-8000-000000000003" },
    brief: { goal: "保持商品完整", preserve: ["文案"], changes: ["换背景"], acceptance: ["无裁切"], questions: [],
      imageVerification: { summary: "旧反馈不应进入新核验" } },
  };
  const task: any = {
    snapshot, requiresDesignVerification: true,
    latestImageResult: { assetIds: [assetId], jobId: "job-1" },
    service: {
      assertCurrentRun: vi.fn(async () => snapshot),
      updateBrief: vi.fn(async (_runId, brief) => { snapshot.brief = brief; return snapshot; }),
    },
  };
  const tool = directTool(createReviewImageResultsTool({
    createUserClient: () => client, model: { generate } as never,
    currentUserPrompt: "请换背景但不要裁切商品", task,
    ...(resultReviewScope ? { resultReviewScope } : {}),
  }));
  return { ...result, tool, task, generate, filters, client };
}

describe("review_image_results tool", () => {
  it("directs future-edit source inspection to reference analysis", async () => {
    const f = await fixture();
    expect(f.tool.description).toContain("Use mode=reference_analysis");
    expect(f.tool.description).toContain("do not judge that source against changes that have not been generated yet");
    const output = await f.tool.execute({ mode: "reference_analysis", result_asset_ids: [f.assetId] }, toolExecutionContext({
      configurable: { access_token: "token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ viewed: true, acceptanceRecorded: false, reviewMode: "reference_analysis" });
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });
  it("reads prepared prior results without persisting old acceptance into a new task", async () => {
    const f = await fixture();
    f.task.phase = "prepared";
    f.task.readResultSnapshot = vi.fn(async () => f.task.snapshot);
    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: [f.assetId] }, toolExecutionContext({
      configurable: { access_token: "token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ status: "passed", viewed: true, acceptanceRecorded: false });
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
    expect(f.task.readResultSnapshot).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])("reviews a newly generated canvas image only with its server marker (%s)", async registered => {
    const jobId = "50000000-0000-4000-8000-000000000005";
    const f = await fixture({ jobId, assetIds: ["10000000-0000-4000-8000-000000000001"] });
    f.task.snapshot.target.assetId = f.assetId;
    f.task.snapshot.brief.imageResult = { jobId };
    if (registered) f.task.snapshot.brief.canvasResultReview = { mode: "read_only", jobId };
    const jobQuery: any = { select: () => jobQuery, eq: () => jobQuery, maybeSingle: async () => ({ data: {
      id: jobId, status: "succeeded", job_type: "image_generation", workspace_id: f.workspaceId,
      session_id: "session", canvas_id: "canvas", payload: {},
      result: { asset_id: f.assetId, canvas_element_id: "element", canvas_finalized_at: new Date().toISOString() },
    }, error: null }) };
    const assets = f.client.from.getMockImplementation()!;
    f.client.from.mockImplementation((table: string) => table === "background_jobs" ? jobQuery : assets(table));
    const output = await f.tool.execute({ mode: "result_verification", job_id: jobId }, toolExecutionContext({
      configurable: { access_token: "token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject(registered ? { status: "passed", viewed: true, acceptanceRecorded: true }
      : { status: "unavailable", viewed: false });
    expect(f.generate).toHaveBeenCalledTimes(registered ? 1 : 0);
  });
  it.each([true, false])("only a server-scoped workflow job can review an older batch image (scope=%s)", async (scoped) => {
    const jobId = "50000000-0000-4000-8000-000000000005";
    const assetId = "10000000-0000-4000-8000-000000000001";
    const f = await fixture(scoped ? { jobId, assetIds: [assetId] } : undefined);
    f.task.snapshot.id = "60000000-0000-4000-8000-000000000006";
    f.task.snapshot.runId = "70000000-0000-4000-8000-000000000007";
    let workflow = reconcileWorkflowPlan({ task: f.task.snapshot,
      plan: { title: "两张图分别检查", steps: [{ stepId: "images", title: "出图", intent: "生成获准的变体", dependsOn: [] }] } });
    workflow = applyTrustedWorkflowEvent(workflow, { type: "job_submitted", stepId: "images", jobId });
    f.task.snapshot.brief.agentWorkflow = workflow;
    f.task.snapshot.brief.imageResult = { jobId: "80000000-0000-4000-8000-000000000008" };
    const jobQuery: any = { select: () => jobQuery, eq: () => jobQuery, maybeSingle: async () => ({ data: {
      id: jobId, status: "succeeded", job_type: "image_generation", workspace_id: f.workspaceId,
      session_id: "session", canvas_id: "canvas", payload: { origin_run_id: f.task.snapshot.runId,
        source_element_id: "element", source_asset_id: f.task.snapshot.target.assetId }, result: { asset_id: assetId },
    }, error: null }) };
    const assets = f.client.from.getMockImplementation()!;
    f.client.from.mockImplementation((table: string) => table === "background_jobs" ? jobQuery : assets(table));
    const output = await f.tool.execute({ mode: "result_verification", job_id: jobId }, toolExecutionContext({
      configurable: { access_token: "token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject(scoped ? { status: "passed", viewed: true, acceptanceRecorded: false }
      : { status: "unavailable", viewed: false, error: "review_job_not_current" });
    expect(f.generate).toHaveBeenCalledTimes(scoped ? 1 : 0);
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
    expect(f.task.snapshot.brief.imageResult.jobId).toBe("80000000-0000-4000-8000-000000000008");
  });

  it("does not save a review if a newer persisted result appears while vision is running", async () => {
    const f = await fixture();
    f.generate.mockImplementation(async () => {
      f.task.snapshot.brief.imageResult = { jobId: "80000000-0000-4000-8000-000000000008" };
      return { text: '{"blockingIssues":[],"suggestions":[],"uncertainties":[]}', usage: {} };
    });
    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: [f.assetId] }, toolExecutionContext({
      configurable: { access_token: "token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ status: "unavailable", error: "review_result_changed" });
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("rejects results outside the immutable continuation scope before vision or storage", async () => {
    const f = await fixture({ jobId: "50000000-0000-4000-8000-000000000005", assetIds: ["10000000-0000-4000-8000-000000000001"] });
    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: ["80000000-0000-4000-8000-000000000008"] }, toolExecutionContext({
      configurable: { access_token: "token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ status: "unavailable", error: "review_continuation_scope_mismatch" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.client.from).not.toHaveBeenCalled();
  });
  it("reviews and records only the exact latest successful standalone result", async () => {
    const f = await fixture();
    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: [f.assetId] }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ status: "passed", viewed: true, acceptanceRecorded: true,
      reviewed: [{ id: f.assetId, source: "workspace_asset", role: "result" }] });
    expect(f.task.service.updateBrief).toHaveBeenCalledWith("run", expect.objectContaining({
      imageVerification: expect.objectContaining({ taskRevision: 3, resultAssetIds: [f.assetId], jobId: "job-1", status: "passed", viewed: true }),
    }));
    const prompt = (f.generate.mock.calls[0]![0] as { user: string }).user;
    expect(prompt).toContain("请换背景但不要裁切商品");
    expect(prompt).not.toContain("旧反馈不应进入新核验");
    expect(f.filters.get("workspace_id")).toBe(f.workspaceId);
  });

  it("does not read or persist an unrelated workspace asset as the task result", async () => {
    const f = await fixture();
    const unrelated = "40000000-0000-4000-8000-000000000004";
    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: [unrelated] }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_result_identity_mismatch" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("reports a pending asynchronous result without retrying or reading the original source", async () => {
    const f = await fixture();
    delete f.task.latestImageResult;
    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: [f.assetId] }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));
    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_result_not_ready" });
    expect(output.summary).toContain("不会自动重发");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("recovers the exact succeeded task result by job id before inspecting pixels", async () => {
    const f = await fixture();
    const jobId = "50000000-0000-4000-8000-000000000005";
    (f.task.snapshot.brief as any).imageResult = { jobId, visualStatus: "unverified", viewed: false };
    f.task.latestImageResult = { jobId: "40000000-0000-4000-8000-000000000004", assetIds: ["40000000-0000-4000-8000-000000000004"] };
    const jobFilters = new Map<string, unknown>();
    const jobQuery: any = {
      select: () => jobQuery,
      eq: (key: string, value: unknown) => { jobFilters.set(key, value); return jobQuery; },
      maybeSingle: async () => ({ data: {
        id: jobId, status: "succeeded", job_type: "image_generation",
        workspace_id: f.workspaceId, session_id: "session", canvas_id: "canvas",
        payload: { origin_run_id: "run", source_element_id: "element", source_asset_id: "30000000-0000-4000-8000-000000000003" },
        result: { asset_id: f.assetId },
      }, error: null }),
    };
    const assetImplementation = f.client.from.getMockImplementation()!;
    f.client.from.mockImplementation((table: string) => table === "background_jobs" ? jobQuery : assetImplementation(table));

    const output = await f.tool.execute({ mode: "result_verification", job_id: jobId }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "passed", viewed: true, acceptanceRecorded: true,
      reviewed: [{ id: f.assetId, source: "workspace_asset", role: "result" }] });
    expect(jobFilters).toEqual(new Map([["id", jobId], ["workspace_id", f.workspaceId]]));
    expect(f.task.latestImageResult).toEqual({ jobId, assetIds: [f.assetId] });
    expect(f.task.service.updateBrief).toHaveBeenCalledWith("run", expect.objectContaining({
      imageVerification: expect.objectContaining({ jobId, resultAssetIds: [f.assetId], viewed: true, status: "passed" }),
    }));
  });

  it("rejects a succeeded job from another task before reading its asset or invoking vision", async () => {
    const f = await fixture();
    delete f.task.latestImageResult;
    const jobId = "50000000-0000-4000-8000-000000000005";
    const jobQuery: any = {
      select: () => jobQuery, eq: () => jobQuery,
      maybeSingle: async () => ({ data: {
        id: jobId, status: "succeeded", job_type: "image_generation",
        workspace_id: f.workspaceId, session_id: "session", canvas_id: "canvas",
        payload: { origin_run_id: "another-run", source_element_id: "element", source_asset_id: "30000000-0000-4000-8000-000000000003" },
        result: { asset_id: f.assetId },
      }, error: null }),
    };
    f.client.from.mockImplementation((table: string) => {
      if (table !== "background_jobs") throw new Error("asset_lookup_must_not_start");
      return jobQuery;
    });

    const output = await f.tool.execute({ mode: "result_verification", job_id: jobId }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_job_task_mismatch" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it.each([
    ["missing or RLS-hidden job", { row: null }, "review_job_not_authorized"],
    ["non-succeeded job", { status: "processing" }, "review_job_not_succeeded"],
    ["non-image job", { job_type: "video_generation" }, "review_job_type_invalid"],
    ["another session", { session_id: "another-session" }, "review_job_task_mismatch"],
    ["another canvas", { canvas_id: "another-canvas" }, "review_job_task_mismatch"],
    ["another origin run", { payload: { origin_run_id: "another-run", source_element_id: "element", source_asset_id: "30000000-0000-4000-8000-000000000003" } }, "review_job_task_mismatch"],
    ["another source element", { payload: { origin_run_id: "run", source_element_id: "another-element", source_asset_id: "30000000-0000-4000-8000-000000000003" } }, "review_job_task_mismatch"],
    ["another source asset", { payload: { origin_run_id: "run", source_element_id: "element", source_asset_id: "40000000-0000-4000-8000-000000000004" } }, "review_job_task_mismatch"],
    ["invalid result asset", { result: { asset_id: "not-an-asset-id" } }, "review_job_result_invalid"],
    ["original source as result", { result: { asset_id: "30000000-0000-4000-8000-000000000003" } }, "review_job_result_is_source"],
  ] as const)("fails closed for %s without downstream work", async (_label, override, errorCode) => {
    const f = await fixture();
    delete f.task.latestImageResult;
    const jobId = "50000000-0000-4000-8000-000000000005";
    const base = {
      id: jobId, status: "succeeded", job_type: "image_generation",
      workspace_id: f.workspaceId, session_id: "session", canvas_id: "canvas",
      payload: { origin_run_id: "run", source_element_id: "element", source_asset_id: "30000000-0000-4000-8000-000000000003" },
      result: { asset_id: f.assetId },
    };
    const row = "row" in override && override.row === null ? null : { ...base, ...override };
    const jobQuery: any = {
      select: () => jobQuery, eq: () => jobQuery,
      maybeSingle: async () => ({ data: row, error: null }),
    };
    f.client.from.mockImplementation((table: string) => {
      if (table !== "background_jobs") throw new Error("asset_lookup_must_not_start");
      return jobQuery;
    });

    const output = await f.tool.execute({ mode: "result_verification", job_id: jobId }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: errorCode });
    expect(f.client.from).toHaveBeenCalledTimes(1);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("rejects an explicit asset that disagrees with the authorized job result", async () => {
    const f = await fixture();
    delete f.task.latestImageResult;
    const jobId = "50000000-0000-4000-8000-000000000005";
    const jobQuery: any = {
      select: () => jobQuery, eq: () => jobQuery,
      maybeSingle: async () => ({ data: {
        id: jobId, status: "succeeded", job_type: "image_generation",
        workspace_id: f.workspaceId, session_id: "session", canvas_id: "canvas",
        payload: { origin_run_id: "run", source_element_id: "element", source_asset_id: "30000000-0000-4000-8000-000000000003" },
        result: { asset_id: f.assetId },
      }, error: null }),
    };
    f.client.from.mockImplementation((table: string) => {
      if (table !== "background_jobs") throw new Error("asset_lookup_must_not_start");
      return jobQuery;
    });

    const output = await f.tool.execute({ mode: "result_verification", job_id: jobId,
      result_asset_ids: ["40000000-0000-4000-8000-000000000004"] }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_job_asset_mismatch" });
    expect(f.client.from).toHaveBeenCalledTimes(1);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("rejects an older job from the same run when a newer result marker is persisted", async () => {
    const f = await fixture();
    const oldJobId = "50000000-0000-4000-8000-000000000005";
    const currentJobId = "60000000-0000-4000-8000-000000000006";
    (f.task.snapshot.brief as any).imageResult = { jobId: currentJobId, visualStatus: "unverified", viewed: false };
    f.task.latestImageResult = { jobId: oldJobId, assetIds: [f.assetId] };

    const output = await f.tool.execute({ mode: "result_verification", job_id: oldJobId }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_job_not_current" });
    expect(f.client.from).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("uses process-local latest job identity only when no persisted marker exists", async () => {
    const f = await fixture();
    const oldJobId = "50000000-0000-4000-8000-000000000005";

    const output = await f.tool.execute({ mode: "result_verification", job_id: oldJobId }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_job_not_current" });
    expect(f.client.from).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("does not let direct asset ids bypass a newer persisted job marker", async () => {
    const f = await fixture();
    const currentJobId = "60000000-0000-4000-8000-000000000006";
    (f.task.snapshot.brief as any).imageResult = { jobId: currentJobId, visualStatus: "unverified", viewed: false };

    const output = await f.tool.execute({ mode: "result_verification", result_asset_ids: [f.assetId] }, toolExecutionContext({
      configurable: { access_token: "user-token", workspace_id: f.workspaceId },
    }));

    expect(output).toMatchObject({ status: "unavailable", viewed: false, error: "review_job_not_current" });
    expect(f.client.from).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.task.service.updateBrief).not.toHaveBeenCalled();
  });

  it("caps the whole request and never starts vision or persists after a late Storage response", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      let release!: (value: unknown) => void;
      (f.client.storage.from as any) = () => ({ download: () => new Promise(resolve => { release = resolve; }) });
      const pending = f.tool.execute({ mode: "result_verification", result_asset_ids: [f.assetId] }, toolExecutionContext({
        configurable: { access_token: "user-token", workspace_id: f.workspaceId },
      }));
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toMatchObject({ status: "unavailable", viewed: false, error: "image_review_timeout" });
      release({ data: { size: 1, type: "image/png", arrayBuffer: async () => new ArrayBuffer(1) }, error: null });
      await vi.runAllTimersAsync();
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.task.service.updateBrief).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
