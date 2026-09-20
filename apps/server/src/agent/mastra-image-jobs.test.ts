import { describe, expect, it, vi } from "vitest";

import { insertImageGenerationPlaceholder } from "../features/canvas/canvas-element-writer.js";
import { JobServiceError, type JobService } from "../features/jobs/job-service.js";
import { finalizeImageJobToCanvas, finalizeTerminalImageJobPlaceholder } from "../features/jobs/job-canvas-finalizer.js";
import { createMastraImageJobSubmitter as createRawMastraImageJobSubmitter,
  MastraImagePreflightError, mastraImageSubmissionKey, type MastraImageJobContext } from "./mastra-image-jobs.js";

// Spread the REAL module: a plain factory also hid the label constants, and reading
// one from the mocked module throws "No ... export is defined on the mock" — the same
// test-only breakage the finalizer's own suite hit when the canceled label became a
// shared constant. Only the writers are replaced.
vi.mock("../features/canvas/canvas-element-writer.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../features/canvas/canvas-element-writer.js")>()),
  insertImageGenerationPlaceholder: vi.fn(async () => ({ elementId: "placeholder", placement: { x: 0, y: 0, width: 512, height: 512 } })),
  markImageGenerationPlaceholderFailed: vi.fn(async () => true),
  insertImageElement: vi.fn(async () => ({ elementId: "completed-image", inserted: true })),
  removeCompletedImagePlaceholder: vi.fn(async () => true),
}));

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  session: "10000000-0000-4000-8000-000000000003",
  canvas: "10000000-0000-4000-8000-000000000004",
  run: "10000000-0000-4000-8000-000000000005",
  message: "10000000-0000-4000-8000-000000000006",
  job: "10000000-0000-4000-8000-000000000007",
  design: "10000000-0000-4000-8000-000000000008",
  request: "10000000-0000-4000-8000-000000000009",
  activeDesign: "10000000-0000-4000-8000-000000000010",
};

function client(scopeValid = true, sessionCreator = ids.user, currentUserText = "制作海报") {
  const rows: Record<string, unknown> = {
    agent_runs: scopeValid ? { id: ids.run, session_id: ids.session, created_by: ids.user,
      request_message_id: ids.message, status: "running" } : null,
    chat_sessions: { id: ids.session, canvas_id: ids.canvas, created_by: sessionCreator },
    canvases: scopeValid ? { id: ids.canvas, workspace_id: ids.workspace } : null,
    workspace_members: { workspace_id: ids.workspace, user_id: ids.user, role: "owner" },
    chat_messages: { id: ids.message, session_id: ids.session, role: "user", content: currentUserText },
  };
  const upsert = vi.fn(async (_message: unknown, _options?: unknown) => ({ error: null }));
  return { upsert, value: { from: vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    const chain: any = { select: () => chain, eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return chain;
    }, maybeSingle: async () => {
      const row = rows[table] as Record<string, unknown> | null;
      return { data: row && filters.every(([column, value]) => row[column] === value) ? row : null, error: null };
    }, upsert };
    return chain;
  }) } };
}

function context(): MastraImageJobContext {
  return { userId: ids.user, accessToken: "token", workspaceId: ids.workspace,
    sessionId: ids.session, canvasId: ids.canvas, runId: ids.run,
    signal: new AbortController().signal };
}

function input() {
  return { operation: "generate" as const, title: "Poster", prompt: "A real poster",
    model: "workspace:image", aspectRatio: "16:9" };
}

function createMastraImageJobSubmitter(
  deps: Parameters<typeof createRawMastraImageJobSubmitter>[0],
) {
  return createRawMastraImageJobSubmitter({
    creditService: { getSubscription: vi.fn(async () => ({ plan: "pro" })),
      getBalance: vi.fn(async () => ({ balance: 100, plan: "pro", dailyClaimed: false })) } as never,
    tierGuard: { calculateCreditCost: vi.fn(() => 0), checkModelAccess: vi.fn(),
      checkResolution: vi.fn(), checkConcurrency: vi.fn(async () => undefined) } as never,
    ...deps,
    ...(deps.jobService ? { jobService: Object.assign(
      { findMastraImageSubmission: vi.fn(async () => null) }, deps.jobService,
    ) as JobService } : {}),
  });
}

function designTarget(role: "background" | "product" = "background") {
  return { kind: "design" as const, design_id: ids.activeDesign, expected_revision: 4,
    placement: { x: 0, y: 0, width: 800, height: 800, role } };
}

function queuedJob() {
  return { id: ids.job, workspace_id: ids.workspace, project_id: "project", canvas_id: ids.canvas,
    target_kind: "canvas", design_id: null, session_id: ids.session, thread_id: null,
    queue_name: "image_generation_jobs", job_type: "image_generation", status: "queued",
    payload: {}, result: null, error_code: null, error_message: null, attempt_count: 0,
    max_attempts: 3, created_by: ids.user, created_at: "now", updated_at: "now",
    started_at: null, completed_at: null, failed_at: null, canceled_at: null } as const;
}

describe("Mastra image job submitter", () => {
  it.each(["processing", "succeeded", "canceled", "dead_letter"].flatMap(status =>
    [0, 7].map(cost => ({ status, cost }))))(
    "preserves the same persisted $cost credit receipt from submission through $status",
    async ({ status, cost }) => {
      const database = client(true, ids.user, "使用Medium画质生成海报");
      let durableJob: any;
      const createJobWithReplay = vi.fn(async (_user: unknown, request: any) => {
        durableJob = { ...queuedJob(), credits_cost: request.providerBilling.creditsCost,
          payload: { ...request.payload, mastra_submission_key: request.mastraSubmission.key,
            mastra_credits_cost: request.providerBilling.creditsCost, mastra_pricing_version: request.providerBilling.pricingVersion } };
        return { job: durableJob, replayed: false, billingCommitted: false };
      });
      const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
        jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
          createJobWithReplay, commitMastraImageJob: vi.fn(async () => undefined) } as unknown as JobService,
        tierGuard: { calculateCreditCost: vi.fn(() => cost), checkModelAccess: vi.fn(),
          checkResolution: vi.fn(), checkConcurrency: vi.fn(async () => undefined) } as never,
        workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
      const submitted = await submitter.submit(context(), { ...input(), quality: "hd", resolution: "1k" });
      const receipt = { creditsCost: cost, pricingVersion: "credits-v1", actualQuality: "Medium", actualResolution: "1K" };
      expect(submitted).toMatchObject(receipt);
      expect(database.upsert.mock.calls.at(-1)?.[0]).toMatchObject({ content_blocks: [expect.objectContaining({
        output: expect.objectContaining({ ...receipt, status: "queued" }),
      })] });
      const queuedCard: any = database.upsert.mock.calls.at(-1)?.[0];
      expect(queuedCard.content_blocks[0].output.creditsCost).toBe(durableJob.credits_cost);
      expect(queuedCard.content_blocks[0].output).not.toHaveProperty("billing");
      if (status !== "processing") {
        const upsert = vi.fn(async (_message: unknown, _options?: unknown) => ({ error: null }));
        // The canvas success path now writes the card with a scoped UPDATE, so a
        // chat placeholder the user deleted through "edit and resend" is never
        // resurrected. The terminal-placeholder path still upserts.
        const chatUpdateChain: any = { eq: () => chatUpdateChain,
          select: async () => ({ data: [{ id: durableJob.id }], error: null }) };
        const chatUpdate = vi.fn(() => chatUpdateChain);
        const updateChain: any = { eq: () => updateChain, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) };
        const admin = { from: (table: string) => table === "chat_messages" ? { upsert, update: chatUpdate } : { update: () => updateChain } };
        const finalized = { ...durableJob, status, result: status === "succeeded" ? {
          asset_id: "asset-1", object_path: "workspace/generated.png", signed_url: "https://example.com/generated.png",
          width: 1024, height: 576, mime_type: "image/png",
        } : null };
        if (status === "succeeded") await finalizeImageJobToCanvas(admin as never, finalized);
        else await finalizeTerminalImageJobPlaceholder(admin as never, finalized);
        const writeSpy = status === "succeeded" ? chatUpdate : upsert;
        // A terminal status writes TWO chat rows: the submission card is rewritten
        // in place (keeping its position in the transcript) and a terminal notice
        // is appended so the real outcome, not the earlier "正在生成中" promise,
        // is the newest message.
        if (status === "succeeded") {
          expect(writeSpy).toHaveBeenCalledOnce();
        } else {
          expect(writeSpy).toHaveBeenCalledTimes(2);
          expect(upsert.mock.calls[1]?.[0]).toMatchObject({
            content_blocks: [expect.objectContaining({ type: "text", text: expect.any(String) })],
          });
        }
        const card: any = writeSpy.mock.calls[0]?.[0];
        // The scoped UPDATE carries the target id in its WHERE clause instead.
        if (status !== "succeeded") expect(card.id).toBe(durableJob.id);
        expect(card.content_blocks[0].output).toMatchObject({ ...receipt, status });
        expect(card.content_blocks[0].output.creditsCost).toBe(durableJob.credits_cost);
        expect(card.content_blocks[0].output).not.toHaveProperty("billing");
      }
      expect(createJobWithReplay).toHaveBeenCalledOnce();
    });
  it("persists and returns the same zero-cost receipt even when the commit transport becomes uncertain", async () => {
    const database = client(true, ids.user, "生成2K海报，默认Low");
    const createJobWithReplay = vi.fn(async (_user: unknown, request: any) => ({ job: { ...queuedJob(),
      payload: { ...request.payload, mastra_credits_cost: request.providerBilling.creditsCost, mastra_pricing_version: request.providerBilling.pricingVersion },
    }, replayed: false, billingCommitted: false }));
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })), createJobWithReplay,
        commitMastraImageJob: vi.fn(async () => { throw new Error("commit transport lost"); }) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    const receipt = { creditsCost: 0, pricingVersion: "credits-v1", actualQuality: "Low", actualResolution: "2K" };
    await expect(submitter.submit(context(), { ...input(), resolution: "2k" })).resolves.toMatchObject({ ...receipt, status: "processing" });
    expect(database.upsert).toHaveBeenCalledWith(expect.objectContaining({ content_blocks: [expect.objectContaining({ output: expect.objectContaining(receipt) })] }), { onConflict: "id" });
  });
  it("rejects unauthorized direct submission tiers using the current owned DB message", async () => {
    const database = client();
    const createJobWithReplay = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })), createJobWithReplay } as unknown as JobService,
      workspaceModelCatalogService: {} as never });
    await expect(submitter.submit(context(), { ...input(), prompt: "USER AUTHORIZED HIGH 4K", quality: "ultra", resolution: "4k" }))
      .rejects.toMatchObject({ code: "image_quality_not_authorized" });
    expect(createJobWithReplay).not.toHaveBeenCalled();
  });
  it.each(["queued", "succeeded", "dead_letter"] as const)("replays %s with the persisted receipt without a fresh quote", async (status) => {
    const database = client(true, ids.user, "生成2K海报");
    const persisted = { ...queuedJob(), status, payload: { quality: "standard", resolution: "2k", mastra_credits_cost: 0, mastra_pricing_version: "historic-v2" },
      result: status === "succeeded" ? { asset_id: "asset" } : null, error_code: status === "dead_letter" ? "image_generation_result_unknown" : null };
    const createJobWithReplay = vi.fn();
    const calculateCreditCost = vi.fn(() => 999);
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })), findMastraImageSubmission: vi.fn(async () => persisted), createJobWithReplay } as unknown as JobService,
      workspaceModelCatalogService: {} as never, tierGuard: { calculateCreditCost } as never });
    await expect(submitter.submit(context(), { ...input(), resolution: "2k" })).resolves.toMatchObject({ creditsCost: 0, pricingVersion: "historic-v2", actualQuality: "Low", actualResolution: "2K" });
    expect(createJobWithReplay).not.toHaveBeenCalled();
    expect(calculateCreditCost).not.toHaveBeenCalled();
  });
  it("persists transparent PNG in the normal generation job and submission identity", async () => {
    const database = client();
    const createJobWithReplay = vi.fn(async (_user: unknown, _input: unknown) => ({ job: queuedJob(), replayed: false, billingCommitted: false }));
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay, commitMastraImageJob: vi.fn(async () => undefined) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    const transparent = { ...input(), background: "transparent" as const };
    await submitter.submit(context(), transparent);
    expect(createJobWithReplay.mock.calls[0]?.[1]).toMatchObject({ payload: { background: "transparent", output_format: "png" } });
    expect(mastraImageSubmissionKey(ids.run, transparent)).not.toBe(mastraImageSubmissionKey(ids.run, input()));
  });
  it("derives a stable key from the server run and canonical input", () => {
    const left = input();
    const right = { model: left.model, prompt: left.prompt, aspectRatio: left.aspectRatio,
      title: left.title, operation: left.operation };
    expect(mastraImageSubmissionKey(ids.run, left)).toBe(mastraImageSubmissionKey(ids.run, right));
    expect(mastraImageSubmissionKey(ids.run, left)).toMatch(new RegExp(`^${ids.run}:[0-9a-f]{64}$`));
  });

  it("fails closed when billing enforcement is unavailable", async () => {
    const submitter = createRawMastraImageJobSubmitter({ createUserClient: vi.fn(),
      jobService: {} as JobService, workspaceModelCatalogService: {} as never });
    await expect(submitter.submit(context(), input()))
      .rejects.toThrow("mastra_image_job_dependencies_unavailable");
  });

  it("reports an unavailable catalog model as no-write preflight instead of unknown submission", async () => {
    const database = client();
    const createJobWithReplay = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => null) } as never });
    const error = await submitter.submit(context(), input()).catch(value => value);
    expect(error).toBeInstanceOf(MastraImagePreflightError);
    expect(error).toMatchObject({ code: "provider_snapshot_invalid" });
    expect(createJobWithReplay).not.toHaveBeenCalled();
  });

  it("submits one authorized job with a server-only durable identity", async () => {
    const database = client();
    const createJobWithReplay = vi.fn(async (_user: unknown, _input: unknown) => ({
      job: queuedJob(), replayed: false, billingCommitted: false,
    }));
    const commitMastraImageJob = vi.fn(async () => undefined);
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay, commitMastraImageJob } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit(context(), input())).resolves.toMatchObject({ jobId: ids.job, status: "processing" });
    expect(createJobWithReplay).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.user }),
      expect.objectContaining({
        workspaceId: ids.workspace, sessionId: ids.session, deferEnqueue: true,
        mastraSubmission: { defaultRunLimit: 4, runId: ids.run, key: expect.stringMatching(new RegExp(`^${ids.run}:[0-9a-f]{64}$`)) },
      }),
    );
    expect(commitMastraImageJob).toHaveBeenCalledOnce();
    expect(database.upsert).toHaveBeenCalledOnce();
  });

  it("uses standard for ordinary generation billing when quality is omitted", async () => {
    const database = client();
    const createJobWithReplay = vi.fn(async (_user: unknown, _request: { payload: Record<string, unknown> }) => ({ job: queuedJob(), replayed: false, billingCommitted: false }));
    const checkResolution = vi.fn();
    const calculateCreditCost = vi.fn(() => 0);
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay, commitMastraImageJob: vi.fn(async () => undefined) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never,
      tierGuard: { calculateCreditCost, checkModelAccess: vi.fn(), checkResolution,
        checkConcurrency: vi.fn(async () => undefined) } as never });

    await submitter.submit(context(), input());

    expect(checkResolution).toHaveBeenCalledWith("pro", "standard");
    expect(calculateCreditCost).toHaveBeenCalledWith("gpt-image-2", "image_generation", { quality: "standard", imageResolution: "1k" });
    expect(createJobWithReplay.mock.calls[0]?.[1]).toMatchObject({ payload: { model: "workspace:image" } });
    expect(createJobWithReplay.mock.calls[0]?.[1].payload).toMatchObject({ quality: "standard", resolution: "1k" });
  });

  it("fails before job creation when the run is not owned by the current scope", async () => {
    const database = client(false);
    const createJobWithReplay = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay } as unknown as JobService,
      workspaceModelCatalogService: {} as never });
    await expect(submitter.submit(context(), input())).rejects.toThrow("mastra_image_run_scope_forbidden");
    expect(createJobWithReplay).not.toHaveBeenCalled();
  });

  it("allows the current run owner to submit in a workspace-shared session", async () => {
    const database = client(true, "10000000-0000-4000-8000-000000000099");
    const createJobWithReplay = vi.fn(async (_user: unknown, _input: unknown) => ({ job: queuedJob(), replayed: false, billingCommitted: false }));
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay, commitMastraImageJob: vi.fn(async () => undefined) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit(context(), input())).resolves.toMatchObject({ jobId: ids.job });
    expect(createJobWithReplay).toHaveBeenCalledOnce();
  });

  it("replays a definite terminal rejection with its structured retry classification", async () => {
    const database = client();
    const job = { ...queuedJob(), status: "dead_letter" as const,
      error_code: "provider_rejected", error_message: "provider rejected" };
    const commitMastraImageJob = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay: vi.fn(async () => ({ job, replayed: true, billingCommitted: true })),
        commitMastraImageJob } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit(context(), input())).resolves.toMatchObject({
      jobId: ids.job, error: "provider rejected", errorCode: "provider_rejected", retryEligible: true,
    });
    expect(commitMastraImageJob).not.toHaveBeenCalled();
  });

  it("replays an unknown terminal provider outcome without marking it retry eligible", async () => {
    const database = client();
    const job = { ...queuedJob(), status: "dead_letter" as const,
      error_code: "image_generation_result_unknown", error_message: "provider response was lost" };
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay: vi.fn(async () => ({ job, replayed: true, billingCommitted: true })) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });

    await expect(submitter.submit(context(), input())).resolves.toMatchObject({
      jobId: ids.job, error: "provider response was lost",
      errorCode: "image_generation_result_unknown", retryEligible: false,
    });
  });

  it("never accepts the legacy proposal or replay controls at runtime", async () => {
    const submitter = createMastraImageJobSubmitter({ createUserClient: vi.fn(), jobService: {} as JobService,
      workspaceModelCatalogService: {} as never });
    await expect(submitter.submit(context(), { ...input(), proposalId: ids.job } as never))
      .rejects.toThrow("mastra_image_legacy_submission_identity_forbidden");
  });

  it("keeps an unknown commit result queryable without canceling a possibly enqueued job", async () => {
    const database = client();
    const cancelUncommittedMastraImageJob = vi.fn();
    const commitMastraImageJob = vi.fn(async () => { throw new Error("transport outcome unknown"); });
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay: vi.fn(async () => ({ job: queuedJob(), replayed: false,
        billingCommitted: false })), commitMastraImageJob, cancelUncommittedMastraImageJob } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit(context(), input())).resolves.toMatchObject({ jobId: ids.job, status: "processing" });
    expect(commitMastraImageJob).toHaveBeenCalledOnce();
    expect(cancelUncommittedMastraImageJob).not.toHaveBeenCalled();
  });

  it("cancels only a newly staged job after a definitive database rejection", async () => {
    const database = client();
    const cancelUncommittedMastraImageJob = vi.fn(async () => true);
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay: vi.fn(async () => ({ job: queuedJob(), replayed: false,
          billingCommitted: false })),
        commitMastraImageJob: vi.fn(async () => { throw new JobServiceError(
          "mastra_commit_rejected", "rejected", 409); }),
        cancelUncommittedMastraImageJob } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit(context(), input())).resolves.toMatchObject({
      jobId: ids.job, error: "Image submission was rejected before enqueue",
    });
    expect(cancelUncommittedMastraImageJob).toHaveBeenCalledOnce();
  });

  it("keeps the job queryable when publication wins the compensation CAS", async () => {
    const database = client();
    const cancelUncommittedMastraImageJob = vi.fn(async () => false);
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay: vi.fn(async () => ({ job: queuedJob(), replayed: false,
          billingCommitted: false })),
        commitMastraImageJob: vi.fn(async () => { throw new JobServiceError(
          "mastra_commit_rejected", "rejected", 409); }),
        cancelUncommittedMastraImageJob } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit(context(), input())).resolves.toMatchObject({ jobId: ids.job, status: "processing" });
    expect(cancelUncommittedMastraImageJob).toHaveBeenCalledOnce();
  });

  it("never ordinary-cancels an already-published replay when the run aborts", async () => {
    const database = client();
    const controller = new AbortController();
    const cancelJob = vi.fn();
    const cancelUncommittedMastraImageJob = vi.fn(async () => false);
    const commitMastraImageJob = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay: vi.fn(async () => {
          controller.abort();
          return { job: queuedJob(), replayed: true, billingCommitted: true };
        }), cancelJob, cancelUncommittedMastraImageJob, commitMastraImageJob } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await expect(submitter.submit({ ...context(), signal: controller.signal }, input()))
      .resolves.toMatchObject({ jobId: ids.job, status: "processing" });
    expect(cancelUncommittedMastraImageJob).toHaveBeenCalledOnce();
    expect(cancelJob).not.toHaveBeenCalled();
    expect(commitMastraImageJob).not.toHaveBeenCalled();
  });

  it("accepts legacy background removal only with an explicit Medium 1K current request", async () => {
    const database = client(true, ids.user, "使用Medium画质去背景");
    const createJobWithReplay = vi.fn(async (_user: unknown, _input: unknown) => ({
      job: queuedJob(), replayed: false, billingCommitted: false,
    }));
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay, commitMastraImageJob: vi.fn(async () => undefined) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });
    await submitter.submit(context(), { ...input(), operation: "remove_background", quality: "hd", resolution: "1k", inputImages: ["data:image/png;base64,eA=="] });
    expect(createJobWithReplay.mock.calls[0]?.[1]).toMatchObject({ payload: {
      operation: "remove_background", output_format: "png", quality: "hd", resolution: "1k",
    } });
  });
  it.each([
    ["去背景", "standard", "1k"],
    ["使用High画质去背景", "ultra", "1k"],
    ["使用Medium画质输出2K去背景图", "hd", "2k"],
  ] as const)("rejects mismatched legacy background removal for %s before any durable write", async (text, quality, resolution) => {
    const database = client(true, ids.user, text);
    const createJobWithReplay = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })), createJobWithReplay } as unknown as JobService,
      workspaceModelCatalogService: {} as never });
    await expect(submitter.submit(context(), { ...input(), operation: "remove_background", quality, resolution, inputImages: ["data:image/png;base64,eA=="] }))
      .rejects.toMatchObject({ code: "image_legacy_background_removal_contract_required" });
    expect(createJobWithReplay).not.toHaveBeenCalled();
  });

  it("persists all nine reference images in caller order", async () => {
    const database = client();
    const createJobWithReplay = vi.fn(async (_user: unknown, _input: unknown) => ({
      job: queuedJob(), replayed: false, billingCommitted: false,
    }));
    const references = Array.from({ length: 9 }, (_, index) => `data:image/png;base64,cmVm${index}`);
    const submitter = createMastraImageJobSubmitter({ createUserClient: () => database.value,
      jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
        createJobWithReplay, commitMastraImageJob: vi.fn(async () => undefined) } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({ upstreamModelId: "gpt-image-2" })) } as never });

    await expect(submitter.submit(context(), { ...input(), inputImages: references })).resolves.toMatchObject({ status: "processing" });
    expect(createJobWithReplay.mock.calls[0]?.[1]).toMatchObject({ payload: { input_images: references } });
  });

  it("rejects every native-design target before catalog, billing, or durable job creation", async () => {
    const createUserClient = vi.fn();
    const createJobWithReplay = vi.fn();
    const resolvePublishedModel = vi.fn();
    const getSubscription = vi.fn();
    const getBalance = vi.fn();
    const submitter = createMastraImageJobSubmitter({ createUserClient,
      jobService: { createJobWithReplay } as unknown as JobService,
      workspaceModelCatalogService: { resolvePublishedModel } as never,
      creditService: { getSubscription, getBalance } as never });

    const error = await submitter.submit(context(), { ...input(), target: designTarget() }).catch(value => value);
    expect(error).toBeInstanceOf(MastraImagePreflightError);
    expect(error).toMatchObject({ code: "mastra_image_canvas_target_required" });
    expect(createUserClient).not.toHaveBeenCalled();
    expect(resolvePublishedModel).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
    expect(createJobWithReplay).not.toHaveBeenCalled();
  });
});
