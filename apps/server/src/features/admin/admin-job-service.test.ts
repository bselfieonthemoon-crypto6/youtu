import { describe, expect, it, vi } from "vitest";

import { AdminJobError, createAdminJobService } from "./admin-job-service.js";

function fakeAdmin(input: {
  isActorAdmin?: boolean;
  directory?: unknown;
  detail?: unknown;
  rpcError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = () => {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      is() { return builder; },
      maybeSingle: async () => ({ data: input.isActorAdmin === false ? null : { user_id: "actor" }, error: null }),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (input.rpcError) return { data: null, error: input.rpcError };
    if (fn === "admin_job_directory") return { data: input.directory ?? { total: 0, jobs: [] }, error: null };
    if (fn === "admin_job_detail") return { data: input.detail ?? { job: { id: args.p_job_id }, transactions: [], audit: [] }, error: null };
    if (fn === "admin_cancel_job") return { data: { status: "canceled", statusBefore: "queued" }, error: null };
    return { data: { acknowledged: true }, error: null };
  };
  return { client: { from, rpc } as never, rpcCalls };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-20T12:00:00.000Z");

function service(input: Parameters<typeof fakeAdmin>[0]) {
  const fake = fakeAdmin(input);
  return {
    ...createAdminJobService({ getAdminClient: () => fake.client, now: () => NOW }),
    fake,
  };
}

describe("admin job service", () => {
  it("refuses a non-platform-admin actor before any read or write", async () => {
    const { listJobs, getJob, cancelJob, acknowledgeJob, fake } = service({ isActorAdmin: false });
    const calls = [
      () => listJobs(ACTOR),
      () => getJob(ACTOR, JOB),
      () => cancelJob(ACTOR, { jobId: JOB, reason: "取消" }),
      () => acknowledgeJob(ACTOR, { jobId: JOB, reason: "已知悉" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("passes known filters through and drops values that are not real statuses or types", async () => {
    const { listJobs, fake } = service({ directory: { total: 3, jobs: [] } });
    await listJobs(ACTOR, { status: "dead_letter", jobType: "image_generation", workspaceId: WORKSPACE,
      errorCode: " provider_rate_limited ", sinceHours: 24, limit: 10, offset: 20 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_job_directory",
      args: {
        p_actor_user_id: ACTOR, p_status: "dead_letter", p_job_type: "image_generation",
        p_workspace_id: WORKSPACE, p_error_code: "provider_rate_limited",
        p_since: "2026-09-19T12:00:00.000Z", p_limit: 10, p_offset: 20,
      },
    });

    // An unknown status would be an enum cast error inside the function, so it is
    // dropped rather than sent.
    await listJobs(ACTOR, { status: "exploded", jobType: "wat" });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_status: null, p_job_type: null, p_since: null });
  });

  it("clamps the page size and never sends a negative offset", async () => {
    const { listJobs, fake } = service({});
    await listJobs(ACTOR, { limit: 10_000, offset: -3 });
    await listJobs(ACTOR, {});
    expect(fake.rpcCalls[0]!.args).toMatchObject({ p_limit: 100, p_offset: 0 });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_limit: 25, p_offset: 0 });
  });

  it("tolerates a malformed directory payload instead of producing NaN", async () => {
    const { listJobs } = service({ directory: { total: "nope", jobs: "nope" } });
    await expect(listJobs(ACTOR)).resolves.toEqual({ total: 0, jobs: [] });
  });

  it("returns a detail with its ledger rows and admin history", async () => {
    const { getJob, fake } = service({
      detail: { job: { id: JOB, status: "dead_letter" },
        transactions: [{ id: "t1" }], audit: [{ action: "job.cancel" }] },
    });
    const result = await getJob(ACTOR, JOB);
    expect(result).toMatchObject({ job: { id: JOB }, transactions: [{ id: "t1" }], audit: [{ action: "job.cancel" }] });
    expect(fake.rpcCalls[0]!.args).toEqual({
      p_actor_user_id: ACTOR, p_job_id: JOB, p_payload_preview_chars: 8000,
    });
  });

  it("reports a missing job as not found rather than an empty detail", async () => {
    const { getJob } = service({ detail: { job: null } });
    await expect(getJob(ACTOR, JOB)).rejects.toMatchObject({ code: "admin_job_not_found", statusCode: 404 });
  });

  it("cancels with a trimmed reason and reports the previous status", async () => {
    const { cancelJob, fake } = service({});
    await expect(cancelJob(ACTOR, { jobId: JOB, reason: "  上游长期无响应  " })).resolves.toEqual({ statusBefore: "queued" });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_cancel_job",
      args: { p_actor_user_id: ACTOR, p_job_id: JOB, p_reason: "上游长期无响应" },
    });
  });

  it("acknowledges with a trimmed reason", async () => {
    const { acknowledgeJob, fake } = service({});
    await expect(acknowledgeJob(ACTOR, { jobId: JOB, reason: " 已知悉，等待上游恢复 " })).resolves.toBeUndefined();
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_acknowledge_job",
      args: { p_actor_user_id: ACTOR, p_job_id: JOB, p_reason: "已知悉，等待上游恢复" },
    });
  });

  it("translates every refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["REASON_REQUIRED: a reason is required to cancel a job", "admin_reason_required", 400],
      ["UNKNOWN_JOB: no such job", "admin_job_not_found", 404],
      ["ALREADY_TERMINAL: the job already ended", "admin_job_already_terminal", 409],
      ["NOT_TERMINAL: only an ended job can be acknowledged", "admin_job_not_terminal", 409],
      ["something unexpected", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { cancelJob } = service({ rpcError: { message } });
      const error = await cancelJob(ACTOR, { jobId: JOB, reason: "取消" }).catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminJobError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
    void vi;
  });
});
