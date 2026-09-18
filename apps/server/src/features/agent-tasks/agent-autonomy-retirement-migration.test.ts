import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260911000007_retire_agent_autonomy.sql",
  import.meta.url,
);
const appUrl = new URL("../../app.ts", import.meta.url);

describe("agent autonomy retirement migration", () => {
  it("fails closed unless the exact autonomy state and trigger schema exists", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("to_regclass('public.agent_autonomy_preferences')");
    expect(sql).toContain("to_regclass('public.agent_task_autonomy')");
    expect(sql).toContain("to_regclass('public.agent_task_continuations')");
    expect(sql).toContain("to_regclass('public.agent_canvas_result_reviews')");
    expect(sql).toContain("tgfoid='private.loomic_record_agent_continuation()'::regprocedure");
    expect(sql).toContain("tgfoid='private.loomic_bind_delivered_canvas_review()'::regprocedure");
    expect(sql).toContain("raise exception 'unexpected autonomy schema");
  });

  it("retires only active autonomy state and preserves normal product records", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("disable trigger record_agent_task_continuation");
    expect(sql).toContain("disable trigger z_bind_delivered_canvas_review");
    expect(sql).toContain("revoke execute on function public.loomic_agent_autonomy");
    expect(sql).toContain("where enabled is true");
    expect(sql).toContain("where status in ('pending','running')");
    expect(sql).toContain("where state='registered'");
    expect(sql).not.toMatch(/(?:delete|truncate)\s+(?:from\s+)?public\./);
    expect(sql).not.toContain("drop table");
    expect(sql).not.toMatch(/update public\.(?:background_jobs|chat_messages|agent_runs|canvases|design_documents|asset_objects)/);
  });

  it("keeps task context without constructing unattended execution", async () => {
    const source = await readFile(appUrl, "utf8");
    expect(source).toContain("createAgentTaskService({ getAdminClient })");
    expect(source).not.toContain("atomicAutonomy");
    expect(source).not.toContain("startAgentAutonomyScheduler");
    expect(source).not.toContain("createAutonomyIdentityIssuer");
    expect(source).not.toContain("createAgentContinuationRunner");
  });
});
