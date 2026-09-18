import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("exact image decision run guard migration", () => {
  it("binds the service-role decision to a real user turn in the same session", () => {
    const sql = readFileSync(resolve(process.cwd(),
      "../../supabase/migrations/20260916000002_harden_exact_image_decision_run.sql"), "utf8");
    expect(sql).toContain("run.id=p_run");
    expect(sql).toContain("run.created_by=p_user");
    expect(sql).toContain("run.session_id=p_session");
    expect(sql).toContain("message.role='user'");
    expect(sql).toContain("image_confirmation_run_forbidden");
    expect(sql).toContain("FROM PUBLIC,anon,authenticated");
    expect(sql).toContain("TO service_role");
  });
});
