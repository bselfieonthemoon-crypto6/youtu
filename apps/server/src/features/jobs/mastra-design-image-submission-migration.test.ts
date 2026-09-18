import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../../../../supabase/migrations/20260913000012_mastra_design_image_submission.sql", import.meta.url), "utf8");

describe("Mastra native design image submission migration", () => {
  it("keeps the current session canvas as the workspace scope root", () => {
    expect(sql).toContain("scope_canvas.id=session.canvas_id");
    expect(sql).toContain("scope_canvas.workspace_id=job.workspace_id");
    expect(sql).toContain("member.workspace_id=job.workspace_id");
    expect(sql).toContain("member.user_id=p_user");
  });

  it("accepts either the exact canvas target or a live linked design target", () => {
    for (const fragment of ["job.target_kind::text='canvas'", "job.canvas_id=session.canvas_id",
      "job.target_kind::text='design'", "job.canvas_id IS NULL", "document.id=job.design_id",
      "document.workspace_id=job.workspace_id", "document.project_id=job.project_id",
      "node.canvas_id=session.canvas_id", "node.workspace_id=job.workspace_id",
      "document.revision::text=job.payload#>>'{target,expected_revision}'"])
      expect(sql).toContain(fragment);
  });

  it("retains atomic billing, queue publication and service-role-only access", () => {
    expect(sql).toContain("auth.role() IS DISTINCT FROM 'service_role'");
    expect(sql).toContain("loomic_deduct_credits_idempotent");
    expect(sql).toContain("PERFORM pgmq.send");
    expect(sql).toContain("image_enqueued_at=now()");
    expect(sql).toContain("FROM PUBLIC,anon,authenticated");
    expect(sql).toContain("TO service_role");
  });
});
