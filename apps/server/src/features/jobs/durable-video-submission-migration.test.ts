import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL(
  "../../../../../supabase/migrations/20260916000001_durable_video_submission.sql",
  import.meta.url,
), "utf8");
const worker = readFileSync(new URL("../../worker.ts", import.meta.url), "utf8");

describe("durable video submission migration", () => {
  it("stores a unique durable identity and one enqueue receipt", () => {
    expect(sql).toContain("ADD COLUMN video_enqueued_at timestamptz");
    expect(sql).toContain("CREATE UNIQUE INDEX background_jobs_video_submission_key");
    expect(sql).toContain("payload->>'video_submission_key'");
    expect(sql).toContain("CREATE FUNCTION public.loomic_guard_durable_video_job()");
    expect(sql).toContain("video_submission_service_role_required");
    expect(sql).toContain("CREATE TRIGGER durable_video_job_guard");
    expect(sql).toContain("durable_video_receipt_immutable");
  });

  it("commits debit, queue publication and receipt in one database function", () => {
    expect(sql).toContain("CREATE FUNCTION public.loomic_commit_video_job");
    expect(sql).toContain("loomic_deduct_credits_idempotent");
    expect(sql).toContain("PERFORM pgmq.send");
    expect(sql).toContain("SET video_enqueued_at=now()");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.loomic_commit_video_job");
  });

  it("authorizes Mastra against its owned run and HTTP against a distinct key shape", () => {
    for (const fragment of ["run.id=p_run", "run.created_by=p_user",
      "run.session_id=j.session_id", "request.id=run.request_message_id",
      "request.session_id=session.id", "request.role='user'",
      "canvas.id=j.canvas_id", "canvas.workspace_id=j.workspace_id",
      "member.workspace_id=job.workspace_id", "member.user_id=p_user",
      "p_submission_key !~ '^http:[0-9a-f]{64}$'"])
      expect(sql).toContain(fragment);
  });

  it("recovers unknown outcomes without reviving terminal jobs", () => {
    expect(sql).toContain("CREATE FUNCTION public.loomic_recover_video_submissions()");
    expect(sql).toContain("j.status::text='queued'");
    expect(sql).toContain("j.video_enqueued_at IS NULL");
    expect(sql).toContain("public.loomic_commit_video_job(");
    expect(sql).toContain("WHEN OTHERS THEN");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.loomic_recover_video_submissions()");
    expect(worker).toContain('rpc("loomic_recover_video_submissions"');
    expect(worker).toContain('queue === "video_generation_jobs"');
  });
});
