import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_GENERATION_CANCELED_LABEL } from "../canvas/canvas-element-writer.js";

const markImageGenerationPlaceholderFailed = vi.hoisted(() => vi.fn());

// Spread the REAL module and override only the placeholder settler, exactly like
// the finalizer's own test: the other exports (and the canceled-label constant)
// must stay real so a renamed constant can never be papered over here.
vi.mock("../canvas/canvas-element-writer.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../canvas/canvas-element-writer.js")>()),
  markImageGenerationPlaceholderFailed,
}));

import { createJobService } from "./job-service.js";
import {
  canvasFailureLabel,
  finalizeTerminalImageJobPlaceholder,
  type FinalizableJob,
} from "./job-canvas-finalizer.js";

/**
 * The canvas the paid regression left behind.
 *
 * `artifacts/agent-regression-20260920/flows/generate-then-withdraw` is the flow
 * that failed: the user asked for an image, then asked the agent to withdraw it.
 * The agent's `cancel_image_job` tool cancelled job 5b2fea73…, the job row read
 * `canceled`, and the canvas still carried placeholder 38bf4883… in the
 * `generating` state — the checker's `stale_generating_placeholder` violation.
 * These ids are the real ones, so the regression shape itself is under test.
 */
const JOB_ID = "5b2fea73-30c4-43b8-9abd-da085817568e";
const PLACEHOLDER_ID = "38bf4883-ab8b-400c-96ff-f195bff22f65";
const CANVAS_ID = "e3ae8ecb-6451-4afd-a27f-9481fd327dd0";
const SESSION_ID = "c9fb571b-b157-4c11-8b09-fc7e708ada83";
const WORKSPACE_ID = "0a23c8b6-ce4c-46ca-9ac3-e0ffd37b5e51";
const USER_ID = "b1b94c9a-cec3-4321-8eb4-898a6a5a41d6";

const IMAGE_JOB_SCOPE = {
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  canvasId: CANVAS_ID,
  liveDesignIds: new Set<string>(),
};

type JobRow = Record<string, any>;
type Placeholder = {
  status: "generating" | "error" | "canceled";
  jobId: string;
  errorMessage?: string;
  isDeleted?: boolean;
};

function queuedJob(overrides: JobRow = {}): JobRow {
  return {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    project_id: null,
    canvas_id: CANVAS_ID,
    target_kind: "canvas",
    design_id: null,
    session_id: SESSION_ID,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "queued",
    payload: {
      mastra_submission_key: "run:5b2fea73",
      title: "宠物友好咖啡馆宣传海报",
      target: { kind: "canvas", canvas_id: CANVAS_ID, element_id: PLACEHOLDER_ID },
    },
    result: {},
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: USER_ID,
    created_at: "2026-09-20T12:03:31.928820+00:00",
    updated_at: "2026-09-20T12:03:31.928820+00:00",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function simpleQuery(data: unknown) {
  const query: any = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data, error: null }),
  };
  return query;
}

function createHarness(
  job: JobRow = queuedJob(),
  placeholder: Placeholder | null = { status: "generating", jobId: JOB_ID },
) {
  const jobs = new Map<string, JobRow>([[job.id, job]]);
  const cards = new Map<string, JobRow>();
  const placeholders = new Map<string, Placeholder>();
  if (placeholder) placeholders.set(PLACEHOLDER_ID, placeholder);

  markImageGenerationPlaceholderFailed.mockImplementation(
    async (
      _admin: unknown,
      _canvasId: string,
      elementId: string,
      sourceJobId: string,
      label: string,
      options?: { status?: "error" | "canceled" },
    ) => {
      const element = placeholders.get(elementId);
      // The real writer's guard, mirrored: only a still-live placeholder created
      // for this exact job settles. A deleted placeholder, another job's element,
      // or one that already settled is authoritative and must not be overwritten.
      if (
        !element ||
        element.isDeleted ||
        element.status !== "generating" ||
        element.jobId !== sourceJobId
      )
        return false;
      element.status = options?.status ?? "error";
      element.errorMessage = label;
      return true;
    },
  );

  const matches = (row: JobRow, filters: Array<{ column: string; value: unknown }>) =>
    filters.every(filter =>
      Array.isArray(filter.value)
        ? (filter.value as unknown[]).includes(row[filter.column])
        : row[filter.column] === filter.value,
    );

  const backgroundQuery = () => {
    let patch: JobRow | undefined;
    const filters: Array<{ column: string; value: unknown }> = [];
    const matchedRow = () => [...jobs.values()].find(row => matches(row, filters)) ?? null;
    // A real Supabase update applies its patch when the query settles, so both the
    // awaited chain and `.maybeSingle()` have to resolve the same derived row.
    const settle = () => {
      const target = matchedRow();
      if (patch && target) Object.assign(target, patch);
      return target;
    };
    const query: any = {
      update: (next: JobRow) => {
        patch = next;
        return query;
      },
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value });
        return query;
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ column, value });
        return query;
      },
      is: (column: string, value: unknown) => {
        filters.push({ column, value });
        return query;
      },
      or: () => query,
      not: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: settle(), error: null }),
      single: async () => ({ data: settle(), error: null }),
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: settle(), error: null }).then(resolve, reject),
    };
    return query;
  };

  const admin = {
    from: vi.fn((table: string) => {
      if (table === "chat_messages") {
        return {
          upsert: async (row: JobRow) => {
            cards.set(String(row.id), row);
            return { error: null };
          },
        };
      }
      if (table === "background_jobs") return backgroundQuery();
      if (table === "workspace_members") return simpleQuery({ role: "owner" });
      if (table === "chat_sessions") return simpleQuery({ canvas_id: CANVAS_ID });
      if (table === "canvases") return simpleQuery({ workspace_id: WORKSPACE_ID });
      throw new Error(`Unexpected table in test harness: ${table}`);
    }),
  };

  // The composition root's hook (app.ts). Reading the row per call is what makes a
  // late worker settle, a recovery scan, or a second cancel see
  // `canvas_terminal_finalized_at` and stop.
  const settleTerminalJob = vi.fn(async (jobId: string) => {
    const row = jobs.get(jobId);
    if (!row) return false;
    return finalizeTerminalImageJobPlaceholder(admin as never, row as unknown as FinalizableJob);
  });

  const service = createJobService({
    createUserClient: (() => {
      throw new Error("user client is not used by these tests");
    }) as never,
    getAdminClient: () => admin as never,
    pgmq: {} as never,
    settleTerminalJob,
  });

  /** The paid regression's own `stale_generating_placeholder` invariant. */
  const staleGeneratingPlaceholders = () => {
    const terminal = new Set(["succeeded", "failed", "canceled", "dead_letter"]);
    const ended = new Set(
      [...jobs.values()]
        .filter(row => terminal.has(String(row.status)))
        .map(row => String(row.id)),
    );
    return [...placeholders.entries()]
      .filter(([, element]) => element.status === "generating" && ended.has(element.jobId))
      .map(([id, element]) => `placeholder ${id} still generating for job ${element.jobId}`);
  };

  return { admin, jobs, cards, placeholders, service, settleTerminalJob, staleGeneratingPlaceholders };
}

beforeEach(() => {
  markImageGenerationPlaceholderFailed.mockReset();
});

describe("a canceled image job settles its canvas placeholder", () => {
  it("settles to canceled when the agent cancels a job no worker ever claimed", async () => {
    const harness = createHarness();
    const user = { id: USER_ID, accessToken: "token" } as never;

    // Exactly the agent tool's path: `cancel_image_job` → `cancelJobAdmin`.
    const canceled = await harness.service.cancelJobAdmin(user, JOB_ID, IMAGE_JOB_SCOPE);

    expect(canceled.status).toBe("canceled");
    // Nothing ever claimed it: this is the "cancelled before the worker arrived"
    // case, so no worker will ever run the terminal settlement for it.
    expect(harness.jobs.get(JOB_ID)!.started_at).toBeNull();
    expect(harness.settleTerminalJob).toHaveBeenCalledExactlyOnceWith(JOB_ID);

    expect(markImageGenerationPlaceholderFailed).toHaveBeenCalledExactlyOnceWith(
      harness.admin,
      CANVAS_ID,
      PLACEHOLDER_ID,
      JOB_ID,
      IMAGE_GENERATION_CANCELED_LABEL,
      { status: "canceled" },
    );
    // The placeholder's own state: canceled, not error — the user's action
    // succeeded, and a reader that conflates the two blames the customer.
    expect(harness.placeholders.get(PLACEHOLDER_ID)).toMatchObject({
      status: "canceled",
      errorMessage: "生成已取消",
    });
    // The durable idempotency marker the recovery scan reads.
    expect(harness.jobs.get(JOB_ID)!.result.canvas_terminal_finalized_at)
      .toEqual(expect.any(String));

    // The chat card stops promising work too: the same finalizer rewrites the
    // submission card in place.
    expect(harness.cards.get(JOB_ID)!.content_blocks[0]).toMatchObject({
      toolName: "generate_image",
      status: "canceled",
      output: expect.objectContaining({ status: "canceled" }),
    });

    // The structural invariant the paid run failed on, for this exact shape.
    expect(harness.staleGeneratingPlaceholders()).toEqual([]);
  });

  it("does not touch the placeholder again when the worker settles the same cancel late", async () => {
    const harness = createHarness();
    const user = { id: USER_ID, accessToken: "token" } as never;
    await harness.service.cancelJobAdmin(user, JOB_ID, IMAGE_JOB_SCOPE);
    const settled = structuredClone(harness.placeholders.get(PLACEHOLDER_ID));
    markImageGenerationPlaceholderFailed.mockClear();

    // worker.ts settles a canceled job after its provider call returns, and the
    // recovery scan settles it again: both must be no-ops once the marker exists.
    await expect(harness.settleTerminalJob(JOB_ID)).resolves.toBe(false);

    expect(markImageGenerationPlaceholderFailed).not.toHaveBeenCalled();
    expect(harness.placeholders.get(PLACEHOLDER_ID)).toEqual(settled);
  });

  it("never overwrites a placeholder that already settled before the cancel", async () => {
    const settledAt = "2026-09-20T12:03:40.000Z";
    const harness = createHarness(
      queuedJob({
        status: "canceled",
        canceled_at: settledAt,
        result: { canvas_terminal_finalized_at: settledAt, canvas_terminal_status: "canceled" },
      }),
      { status: "canceled", jobId: JOB_ID, errorMessage: IMAGE_GENERATION_CANCELED_LABEL },
    );
    const user = { id: USER_ID, accessToken: "token" } as never;

    await expect(harness.service.cancelJobAdmin(user, JOB_ID, IMAGE_JOB_SCOPE))
      .resolves.toMatchObject({ status: "canceled" });

    expect(markImageGenerationPlaceholderFailed).not.toHaveBeenCalled();
    expect(harness.placeholders.get(PLACEHOLDER_ID)!.status).toBe("canceled");
    expect(harness.staleGeneratingPlaceholders()).toEqual([]);
  });

  it("does not error, and does not resurrect, a placeholder the user deleted", async () => {
    const harness = createHarness(queuedJob(), null);
    const user = { id: USER_ID, accessToken: "token" } as never;

    await expect(harness.service.cancelJobAdmin(user, JOB_ID, IMAGE_JOB_SCOPE))
      .resolves.toMatchObject({ status: "canceled" });

    expect(markImageGenerationPlaceholderFailed).toHaveBeenCalledExactlyOnceWith(
      harness.admin,
      CANVAS_ID,
      PLACEHOLDER_ID,
      JOB_ID,
      IMAGE_GENERATION_CANCELED_LABEL,
      { status: "canceled" },
    );
    // Nothing was re-created, and the marker is still stamped so the recovery
    // scan stops trying.
    expect(harness.placeholders.size).toBe(0);
    expect(harness.jobs.get(JOB_ID)!.result.canvas_terminal_finalized_at)
      .toEqual(expect.any(String));
    expect(harness.staleGeneratingPlaceholders()).toEqual([]);
  });
});

describe("a dead-lettered image job settles its canvas placeholder", () => {
  it("settles to the error state with the code-derived reason", async () => {
    const harness = createHarness(
      queuedJob({
        status: "dead_letter",
        error_code: "provider_rejected",
        error_message: "upstream refused (request id: 20260920120332)",
      }),
    );

    // The worker's own settle seam, reached with a job that never succeeded.
    await expect(harness.settleTerminalJob(JOB_ID)).resolves.toBe(true);

    expect(harness.placeholders.get(PLACEHOLDER_ID)).toMatchObject({
      status: "error",
      errorMessage: canvasFailureLabel("dead_letter", "provider_rejected"),
    });
    expect(harness.jobs.get(JOB_ID)!.result).toMatchObject({
      canvas_terminal_finalized_at: expect.any(String),
      canvas_terminal_status: "dead_letter",
    });
    expect(harness.staleGeneratingPlaceholders()).toEqual([]);
  });

  it("is idempotent when the same dead letter is settled twice", async () => {
    const harness = createHarness(queuedJob({ status: "dead_letter", error_code: "provider_rejected" }));
    await harness.settleTerminalJob(JOB_ID);
    const settled = structuredClone(harness.placeholders.get(PLACEHOLDER_ID));
    markImageGenerationPlaceholderFailed.mockClear();

    await expect(harness.settleTerminalJob(JOB_ID)).resolves.toBe(false);

    expect(markImageGenerationPlaceholderFailed).not.toHaveBeenCalled();
    expect(harness.placeholders.get(PLACEHOLDER_ID)).toEqual(settled);
  });
});
