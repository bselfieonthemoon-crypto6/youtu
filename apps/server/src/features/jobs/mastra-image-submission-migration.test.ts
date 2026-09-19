import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Line endings are the checkout's business (`core.autocrlf` is on for this
// working copy), never the migration's contract, so the assertions below read a
// normalized copy instead of depending on how the file happened to be checked out.
const sql = readFileSync(new URL("../../../../../supabase/migrations/20260913000010_mastra_image_submission.sql", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

describe("Mastra direct image submission migration", () => {
  it("has a concurrent durable key and an atomic billing plus queue commit", () => {
    expect(sql).toContain("CREATE UNIQUE INDEX background_jobs_mastra_image_submission_key");
    expect(sql).toContain("payload->>'mastra_submission_key'");
    expect(sql).toContain("CREATE FUNCTION public.loomic_commit_mastra_image_job");
    expect(sql).toContain("loomic_deduct_credits_idempotent");
    expect(sql).toContain("PERFORM pgmq.send");
    expect(sql).toContain("image_enqueued_at=now()");
  });

  it("binds the job to the active owned run, request, session, canvas, workspace and member", () => {
    for (const fragment of ["run.id=p_run", "run.created_by=p_user", "run.session_id=job.session_id",
      "request.id=run.request_message_id", "request.session_id=session.id", "request.role='user'",
      "canvas.id=job.canvas_id", "canvas.workspace_id=job.workspace_id",
      "member.workspace_id=job.workspace_id", "member.user_id=p_user"])
      expect(sql).toContain(fragment);
    expect(sql).not.toContain("session.created_by=p_user");
  });

  it("extends the existing recovery scan without reviving terminal jobs", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.loomic_recover_image_submissions()");
    expect(sql).toContain("j.status::text='queued'");
    expect(sql).toContain("j.image_enqueued_at IS NULL");
    expect(sql).toContain("public.loomic_commit_mastra_image_job");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.loomic_recover_image_submissions()\n  TO service_role");
  });
});
